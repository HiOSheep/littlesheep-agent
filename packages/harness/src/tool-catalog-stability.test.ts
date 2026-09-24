// SP-05: one session shows one tool catalog.
//
// The tool definitions sit inside the request prefix, so a catalog that changes
// with the turn's wording invalidates the cached conversation on every change.
// Measured before this contract: a local -> web -> local turn sequence produced
// three different catalogs (Web tools removed, added, removed again), so the
// session could never reuse a prefix across those turns.
//
// Per-turn restriction is therefore an execution-scope decision, not a
// visibility one: the model sees the registered catalog, and a call to a
// capability the Runtime withheld for this turn is refused at the boundary
// before anything runs.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { ChatRequest } from '@littlesheep/llm';
import { textMessage, type AgentTool, type RunContext } from '@littlesheep/types';
import { createExecuteStage } from './stages/execute.js';
import { assessRetrievalIntent, toolsForRetrievalIntent } from './retrieval-intent.js';
import { createMockLlm, makeCtx, makeTool, textResponse, toolCallResponse } from './tests/helpers.js';

const deps = { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

function webTools(): AgentTool[] {
  return [
    makeTool('read', { ok: true, output: 'file' }),
    makeTool('web_search', { ok: true, output: 'results' }),
    makeTool('web_fetch', { ok: true, output: 'page' }),
    makeTool('document_read', { ok: true, output: 'doc' }),
  ];
}

function contextFor(text: string, tools: AgentTool[]): RunContext {
  return makeCtx({
    tools,
    toolSources: Object.fromEntries(tools.map((tool) => [tool.name, 'builtin'])),
    inbound: textMessage('user', text),
  });
}

/** A rules-classified turn where the user named the tool to use. */
function explicitContextFor(text: string, tools: AgentTool[]): RunContext {
  return makeCtx({
    tools,
    toolSources: Object.fromEntries(tools.map((tool) => [tool.name, 'builtin'])),
    inbound: textMessage('user', text),
    classification: {
      activity: 'execute',
      type: 'problem',
      confidence: 0.96,
      source: 'rules',
      reason: 'explicit tool instruction',
    },
  });
}

/** The tool names a request advertises, in order. */
function advertised(request: ChatRequest): string[] {
  return (request.tools ?? []).map((spec) => spec.function.name);
}

/** The canonical advertised order: the provider sees a sorted, stable list. */
const CATALOG = ['document_read', 'read', 'web_fetch', 'web_search'];

describe('the tool catalog is fixed for the session', () => {
  it.each([
    '搜索我的项目文件里有哪些 web_search 调用',
    '查一下今天的公开新闻',
    '帮我写一个函数',
  ])('advertises the same catalog on a "%s" turn', async (inbound) => {
    const tools = webTools();
    const requests: ChatRequest[] = [];
    const llm = createMockLlm((request) => {
      requests.push(request);
      return textResponse('done');
    });
    await createExecuteStage({ ...deps, llm })(contextFor(inbound, tools));

    expect(advertised(requests[0]!)).toEqual(CATALOG);
  });

  it('advertises the same catalog regardless of the assessed intent', async () => {
    const catalogs: string[] = [];
    const intents: string[] = [];
    for (const inbound of [
      '搜索我的项目文件里有哪些 web_search 调用',
      '查一下今天的公开新闻',
      '打开 https://example.com/docs 并总结',
      '帮我写一个函数',
    ]) {
      const tools = webTools();
      const requests: ChatRequest[] = [];
      const llm = createMockLlm((request) => {
        requests.push(request);
        return textResponse('done');
      });
      await createExecuteStage({ ...deps, llm })(contextFor(inbound, tools));
      catalogs.push(JSON.stringify(requests[0]!.tools));
      intents.push(assessRetrievalIntent(inbound).intent);
    }

    // Different intents, one catalog: the schemas that sit inside the request
    // prefix cannot change with the turn's wording.
    expect(new Set(intents).size).toBeGreaterThan(1);
    expect(new Set(catalogs).size).toBe(1);
  });

  it('refuses a withheld call at the boundary instead of executing it', async () => {
    const tools = webTools();
    const webSearch = tools.find((tool) => tool.name === 'web_search') as
      AgentTool & { calls: unknown[] };
    let turn = 0;
    const llm = createMockLlm(() => {
      turn += 1;
      return turn === 1
        ? toolCallResponse([{ id: 'c1', name: 'web_search', args: { query: 'latest news' } }])
        : textResponse('local answer only');
    });
    // A local-workspace turn does not admit Web tools.
    const inbound = '搜索我的项目文件里有哪些 web_search 调用';
    expect(assessRetrievalIntent(inbound).intent).toBe('local_workspace');
    const ctx = contextFor(inbound, tools);

    const outcome = await createExecuteStage({ ...deps, llm })(ctx);

    expect(outcome.ok).toBe(true);
    // The tool never ran, and the refusal came from the scope boundary rather
    // than from a downstream policy check.
    expect(webSearch.calls).toHaveLength(0);
    const result = ctx.toolResults?.[0];
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/Runtime scope/);
    expect(result?.error).toMatch(/local_workspace|not admitted/);
  });

  it('lets an admitted tool through on the same local turn', async () => {
    const tools = webTools();
    const read = tools.find((tool) => tool.name === 'read') as AgentTool & { calls: unknown[] };
    let turn = 0;
    const llm = createMockLlm(() => {
      turn += 1;
      return turn === 1
        ? toolCallResponse([{ id: 'c1', name: 'read', args: { file_path: 'notes.md' } }])
        : textResponse('read it');
    });
    const ctx = contextFor('搜索我的项目文件里有哪些 web_search 调用', tools);

    await createExecuteStage({ ...deps, llm })(ctx);

    // Withholding the Web capability must not narrow the admitted set.
    expect(read.calls).toHaveLength(1);
    expect(ctx.toolResults?.[0]?.ok).toBe(true);
  });

  it('keeps the admitted tools usable after one over-scope call', async () => {
    const tools = webTools();
    const webSearch = tools.find((tool) => tool.name === 'web_search') as AgentTool & { calls: unknown[] };
    const read = tools.find((tool) => tool.name === 'read') as AgentTool & { calls: unknown[] };
    let turn = 0;
    const llm = createMockLlm(() => {
      turn += 1;
      if (turn === 1) {
        return toolCallResponse([{ id: 'c1', name: 'web_search', args: { query: 'latest news' } }]);
      }
      if (turn === 2) {
        return toolCallResponse([{ id: 'c2', name: 'read', args: { file_path: 'notes.md' } }]);
      }
      return textResponse('local answer only');
    });
    const ctx = contextFor('搜索我的项目文件里有哪些 web_search 调用', tools);

    const outcome = await createExecuteStage({ ...deps, llm })(ctx);

    // The over-scope call is refused, and the run keeps the tools the request did
    // admit: the read lands in the very next round. Treating the refusal as an
    // authoritative boundary froze every tool instead — measured on the
    // parallel-load gate, where a two-step write/read task lost its file to one
    // opening call for a tool outside its scope.
    expect(webSearch.calls).toHaveLength(0);
    expect(read.calls).toHaveLength(1);
    expect(outcome.ok).toBe(true);
    expect(ctx.toolResults?.map((result) => result.ok)).toEqual([false, true]);
  });

  it('still refuses a Web call when the network is off, even though the tool is visible', async () => {
    const tools = webTools();
    const webSearch = tools.find((tool) => tool.name === 'web_search') as
      AgentTool & { calls: unknown[] };
    let turn = 0;
    const llm = createMockLlm(() => {
      turn += 1;
      return turn === 1
        ? toolCallResponse([{ id: 'c1', name: 'web_search', args: { query: 'latest news' } }])
        : textResponse('no web access');
    });
    // Web intent (so the scope admits the tool) with the network switch off: the
    // catalog is unchanged, and the capability is still refused.
    const ctx = contextFor('查一下今天的公开新闻', tools);
    ctx.capabilitySnapshot = {
      epoch: 1,
      permissionPolicyId: 'research',
      workspace: 'inside',
      network: { enabled: false, status: 'disabled' },
      tools: tools.map((tool) => ({ name: tool.name, status: 'available' as const })),
    } as NonNullable<RunContext['capabilitySnapshot']>;

    await createExecuteStage({ ...deps, llm })(ctx);

    expect(webSearch.calls).toHaveLength(0);
    expect(ctx.toolResults?.[0]?.ok).toBe(false);
    // The refusal is the network policy, not the retrieval scope.
    expect(ctx.toolResults?.[0]?.error).toMatch(/network retrieval is disabled/);
  });

  it('does not mistake a withheld capability for an unknown tool', async () => {
    const tools = webTools();
    let turn = 0;
    const llm = createMockLlm(() => {
      turn += 1;
      return turn === 1
        ? toolCallResponse([{ id: 'c1', name: 'no_such_tool', args: {} }])
        : textResponse('recovered');
    });
    const ctx = contextFor('搜索我的项目文件里有哪些 web_search 调用', tools);

    await createExecuteStage({ ...deps, llm })(ctx);

    // "withheld by scope" and "not registered" are different facts.
    expect(ctx.toolResults?.[0]?.error).toMatch(/unknown tool/);
    expect(ctx.toolResults?.[0]?.error).not.toMatch(/Runtime scope/);
  });

  it('keeps the admitted set an execution-scope subset of the registered set', () => {
    const tools = webTools();
    const local = contextFor('搜索我的项目文件里有哪些 web_search 调用', tools);
    const web = contextFor('查一下今天的公开新闻', tools);

    const admittedLocal = toolsForRetrievalIntent(local).map((tool) => tool.name);
    const admittedWeb = toolsForRetrievalIntent(web).map((tool) => tool.name);

    // The scope still narrows (that is the enforcement), but it never widens
    // beyond what is registered.
    expect(admittedLocal).not.toContain('web_search');
    expect(admittedWeb).toContain('web_search');
    for (const name of [...admittedLocal, ...admittedWeb]) {
      expect(tools.map((tool) => tool.name)).toContain(name);
    }
  });
});

describe('an explicit tool instruction narrows execution scope, not the catalog', () => {
  it('advertises the whole registered catalog on the turn the user named one tool', async () => {
    const tools = webTools();
    const requests: ChatRequest[] = [];
    const llm = createMockLlm((request) => {
      requests.push(request);
      return textResponse('done');
    });

    await createExecuteStage({ ...deps, llm })(explicitContextFor('请使用 read 工具查看 notes.md', tools));

    expect(advertised(requests[0]!)).toEqual(CATALOG);
  });

  it('keeps one catalog across a normal -> explicit -> normal turn sequence', async () => {
    const tools = webTools();
    const catalogs: string[] = [];
    const rounds: Array<{ text: string; explicit: boolean }> = [
      { text: '帮我写一个函数', explicit: false },
      { text: '请使用 read 工具查看 notes.md', explicit: true },
      { text: '谢谢，继续', explicit: false },
    ];
    for (const round of rounds) {
      const requests: ChatRequest[] = [];
      const llm = createMockLlm((request) => {
        requests.push(request);
        return textResponse('done');
      });
      const ctx = round.explicit ? explicitContextFor(round.text, tools) : contextFor(round.text, tools);
      await createExecuteStage({ ...deps, llm })(ctx);
      catalogs.push(JSON.stringify(requests[0]!.tools));
    }

    // Naming a tool changes what may execute, never the schemas in the prefix.
    expect(new Set(catalogs).size).toBe(1);
  });

  it('refuses a registered tool the user did not name and names the explicit scope', async () => {
    const tools = webTools();
    const documentRead = tools.find((tool) => tool.name === 'document_read') as
      AgentTool & { calls: unknown[] };
    let turn = 0;
    const llm = createMockLlm(() => {
      turn += 1;
      return turn === 1
        ? toolCallResponse([{ id: 'c1', name: 'document_read', args: { file_path: 'a.pdf' } }])
        : textResponse('answered without it');
    });
    const ctx = explicitContextFor('请使用 read 工具查看 notes.md', tools);

    await createExecuteStage({ ...deps, llm })(ctx);

    expect(documentRead.calls).toHaveLength(0);
    expect(ctx.toolResults?.[0]?.ok).toBe(false);
    // The refusal states the real cause, not the retrieval intent.
    expect(ctx.toolResults?.[0]?.error).toMatch(/Runtime scope/);
    expect(ctx.toolResults?.[0]?.error).toMatch(/explicitly named read/);
  });

  it('never widens the Runtime retrieval scope for a named tool', async () => {
    const tools = webTools();
    const webSearch = tools.find((tool) => tool.name === 'web_search') as
      AgentTool & { calls: unknown[] };
    let turn = 0;
    const llm = createMockLlm(() => {
      turn += 1;
      return turn === 1
        ? toolCallResponse([{ id: 'c1', name: 'web_search', args: { query: 'notes' } }])
        : textResponse('local answer only');
    });
    // Naming a Web tool does not turn a local-workspace turn into a Web turn.
    const inbound = '请使用 web_search 工具搜索我的项目文件';
    expect(assessRetrievalIntent(inbound).intent).toBe('local_workspace');
    const ctx = explicitContextFor(inbound, tools);

    await createExecuteStage({ ...deps, llm })(ctx);

    expect(webSearch.calls).toHaveLength(0);
    expect(ctx.toolResults?.[0]?.ok).toBe(false);
    expect(ctx.toolResults?.[0]?.error).toMatch(/not admitted for this request/);
  });
});
