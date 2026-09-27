// @littlesheep/runner — taskbook-skill-registration.test.ts
// SL-03 evidence: what the per-run dynamic `taskbook` skill actually looks like
// in the model request for (a) a plain new run and (b) a resumed legacy
// checkpoint. The probe runs inside the model request itself, so it observes the
// same catalogue and the same `loadBody` result that `use_skill` would return to
// the model at that moment — not a reconstruction of the registration call.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { textMessage, type RunCheckpoint, type SessionId } from '@littlesheep/types';
import { createRunner } from './runner.js';

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}

function probeLlm(probe: (request: ChatRequest) => Promise<void>): LlmClient {
  const chat = vi.fn(async (request: ChatRequest) => {
    await probe(request);
    return textResponse('continued reply');
  });
  const chatStream = vi.fn(async (request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
    const response = await chat(request);
    onDelta({ type: 'delta', delta: response.content });
    onDelta({ type: 'done', finishReason: response.finishReason });
    return response;
  });
  return {
    chat,
    chatStream,
    embed: vi.fn(async () => ({ embeddings: [], model: 'test', usage: { promptTokens: 0 } })),
  };
}

/** The advertised skill names, read from `use_skill`'s live description. */
function advertisedSkills(request: ChatRequest): string {
  const useSkill = request.tools?.find((tool) => tool.function.name === 'use_skill');
  const description = useSkill?.function.description ?? '(use_skill not advertised)';
  const match = /Available skills: (.*?)\. Call this/u.exec(description);
  return match?.[1] ?? '(no available-skills clause)';
}

interface Observation {
  requestIndex: number;
  advertisedSkills: string;
  /** `undefined` from `loadBody` is recorded as null so the log states it. */
  taskbookBody: string | null;
}

function report(label: string, observation: Observation): void {
  console.log(`[SL-03 evidence] ${label} ${JSON.stringify(observation)}`);
}

describe('per-run taskbook skill registration', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-taskbook-skill-'));
    process.env.LITTLESHEEP_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    delete process.env.LITTLESHEEP_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('reports what a plain new run advertises for the taskbook skill', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const observed: Observation[] = [];
    let runner: Awaited<ReturnType<typeof createRunner>> | undefined;
    runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: probeLlm(async (request) => {
        observed.push({
          requestIndex: observed.length + 1,
          advertisedSkills: advertisedSkills(request),
          taskbookBody: (await runner!.infra.skillLoader.loadBody('taskbook')) ?? null,
        });
      }),
      skillsDirs: [],
    });
    try {
      const session = await runner.sessionManager.create('test/model');
      await runner.sessionManager.append(session.id, [
        textMessage('user', 'say hello', { sessionId: session.id }),
      ]);
      const result = await runner.run({ sessionId: session.id, text: 'say hello', cwd: workspace });
      expect(result.status, result.error).toBe('ok');
      expect(observed.length).toBeGreaterThan(0);
      report('plain-run', observed[0]!);
      // A fresh run has neither a task book nor a plan, so the entry has no body
      // and must therefore not be advertised at all.
      expect(observed[0]!.taskbookBody).toBeNull();
      expect(observed[0]!.advertisedSkills).not.toContain('taskbook');
    } finally {
      await runner.shutdown();
    }
  });

  it('reports what a resumed legacy checkpoint advertises for the taskbook skill', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const observed: Observation[] = [];
    let runner: Awaited<ReturnType<typeof createRunner>> | undefined;
    runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: probeLlm(async (request) => {
        observed.push({
          requestIndex: observed.length + 1,
          advertisedSkills: advertisedSkills(request),
          taskbookBody: (await runner!.infra.skillLoader.loadBody('taskbook')) ?? null,
        });
      }),
      skillsDirs: [],
    });
    try {
      const session = await runner.sessionManager.create('test/model');
      const inbound = textMessage('user', 'continue the interrupted plan', { sessionId: session.id });
      await runner.sessionManager.append(session.id, [inbound]);
      // A checkpoint written before the second executor was deleted: it names
      // DECIDE and carries only a plan, which is what a legacy data root holds.
      const checkpoint: RunCheckpoint = {
        version: 1,
        id: 'legacy-decide-checkpoint',
        runId: 'legacy-decide-run',
        sessionId: session.id as SessionId,
        status: 'recoverable',
        currentStage: 'decide',
        taskBookRevision: 0,
        eventCursor: 0,
        pendingEventIds: [],
        contextSnapshotIds: [],
        sideEffects: [],
        loopBudget: {
          attemptsUsed: 1,
          maxAttempts: 8,
          elapsedMs: 0,
          maxElapsedMs: 60_000,
          noProgressRounds: 0,
          maxNoProgressRounds: 2,
        },
        resumeState: {
          version: 1,
          inboundMessageId: inbound.id,
          cwd: workspace,
          workspaceContext: { boundaryKind: 'agent_workplace' },
          model: 'test/model',
          origin: 'test',
          permissionPolicyId: 'restricted',
          reasoning: 'auto',
          behaviorModeId: 'general',
          availableToolNames: [],
          attachmentCount: 0,
          plan: [{ id: 'legacy-step-1', description: 'finish the legacy plan step' }],
          appliedTaskBookPatchIds: [],
          deferredRuntimeEvents: [],
          recoveryAttempts: 0,
          replanAttempts: 0,
          maxReplanAttempts: 2,
          verificationHistory: [],
        },
        createdAt: new Date().toISOString(),
        reason: 'interrupted during execution',
      };
      await runner.infra.runCheckpointStore!.write(checkpoint);

      const result = await runner.resumeCheckpoint!(checkpoint.id);
      expect(result.status, result.error).toBe('ok');
      expect(observed.length).toBeGreaterThan(0);
      report('legacy-checkpoint', observed[0]!);
      // The legacy stage name is rerouted into the one main loop.
      const stages = result.trace.map((entry) => entry.name);
      expect(stages).toContain('execute');
      expect(stages).not.toContain('decide');
      expect(stages.filter((name) => name === 'execute')).toHaveLength(1);
      // The restored plan is readable as the skill body, with no second loop.
      expect(observed[0]!.taskbookBody).toContain('finish the legacy plan step');
      expect(observed[0]!.advertisedSkills).toContain('taskbook');
      expect(result.conversationContinuation?.resumeStage).toBe('decide');
    } finally {
      await runner.shutdown();
    }
  });
});
