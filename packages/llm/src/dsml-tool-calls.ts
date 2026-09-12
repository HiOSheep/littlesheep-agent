import type { ToolCall } from './types.js';

const DSML_MARKER = /｜{1,2}\s*DSML\s*｜{1,2}/gu;
const CALLS_ENVELOPE = /^([\s\S]*?)(<｜DSML｜\s*(?:calls|tool_calls)\s*>([\s\S]*)<\/｜DSML｜\s*(?:calls|tool_calls)\s*>)\s*$/u;
const INVOKE = /<｜DSML｜\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜DSML｜\s*invoke\s*>/gu;
const PARAMETER = /<｜DSML｜\s*parameter\s+name="([^"]+)"\s+string="(true|false)"\s*>([\s\S]*?)<\/｜DSML｜\s*parameter\s*>/gu;

/**
 * Recover the official DeepSeek DSML tool envelope when an OpenAI-compatible
 * endpoint returns it as message.content instead of structured tool_calls.
 * Only a complete, tool-only envelope is accepted; surrounding prose fails
 * closed and remains ordinary model text.
 */
export interface ParsedDsmlToolEnvelope {
  content: string;
  toolCalls: ToolCall[];
}

export function parseDsmlToolCalls(
  content: string,
  allowedToolNames: ReadonlySet<string>,
): ParsedDsmlToolEnvelope | undefined {
  if (!content.includes('DSML') || allowedToolNames.size === 0) return undefined;
  const canonical = content.replace(DSML_MARKER, '｜DSML｜');
  const envelope = CALLS_ENVELOPE.exec(canonical);
  if (!envelope) return undefined;
  const visibleContent = (envelope[1] ?? '').trim();
  if (visibleContent.includes('｜DSML｜')) return undefined;
  const body = envelope[3] ?? '';
  const calls: ToolCall[] = [];
  let consumed = '';
  for (const match of body.matchAll(INVOKE)) {
    consumed += match[0];
    const name = decodeXml(match[1] ?? '').trim();
    if (!name || !allowedToolNames.has(name)) return undefined;
    const parameterBody = match[2] ?? '';
    const args: Record<string, unknown> = {};
    let parameterConsumed = '';
    for (const parameter of parameterBody.matchAll(PARAMETER)) {
      parameterConsumed += parameter[0];
      const key = decodeXml(parameter[1] ?? '').trim();
      if (!key || Object.prototype.hasOwnProperty.call(args, key)) return undefined;
      const raw = decodeXml(parameter[3] ?? '').trim();
      if (parameter[2] === 'true') {
        args[key] = raw;
      } else {
        try { args[key] = JSON.parse(raw) as unknown } catch { return undefined }
      }
    }
    if (stripWhitespace(parameterBody) !== stripWhitespace(parameterConsumed)) return undefined;
    calls.push({
      id: `dsml_${stableHash(`${canonical}:${calls.length}`)}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  if (calls.length === 0 || stripWhitespace(body) !== stripWhitespace(consumed)) return undefined;
  return { content: visibleContent, toolCalls: calls };
}

function stripWhitespace(value: string): string {
  return value.replace(/\s+/gu, '');
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
