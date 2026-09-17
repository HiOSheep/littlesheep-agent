import type { ToolCall } from './types.js';

const DSML_MARKER = /\s*(?:[｜|]\s*){1,2}DSML\s*(?:[｜|]\s*){1,2}/giu;
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
  const envelopeOffset = (envelope[1] ?? '').length;
  if (isEscapedAt(canonical, envelopeOffset) || isInsideMarkdownCode(canonical, envelopeOffset)) {
    return undefined;
  }
  const visibleContent = (envelope[1] ?? '').trim();
  if (containsUnquotedDsmlControlMarkup(visibleContent)) return undefined;
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
      const raw = decodeXml(parameter[3] ?? '');
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

/** Detect provider control markup while keeping quoted examples inert. */
export function containsUnquotedDsmlControlMarkup(value: string): boolean {
  if (!value.includes('DSML')) return false;
  const canonical = value.replace(DSML_MARKER, '｜DSML｜');
  const marker = /<｜DSML｜\s*(?:calls|tool_calls|invoke|parameter)\b/giu;
  const quotedEnvelopes = quotedDsmlEnvelopeRanges(canonical);
  for (const match of canonical.matchAll(marker)) {
    const offset = match.index ?? -1;
    if (quotedEnvelopes.some((range) => offset >= range.start && offset < range.end)) continue;
    if (offset >= 0 && !isEscapedAt(canonical, offset) && !isInsideMarkdownCode(canonical, offset)) {
      return true;
    }
  }
  return false;
}

/** Find a real control marker from a bounded search offset. */
export function findUnquotedDsmlControlStart(value: string, fromIndex = 0): number {
  if (!value.includes('DSML', Math.max(0, fromIndex - 16))) return -1;
  const marker = /<\s*(?:[｜|]\s*){1,2}DSML\s*(?:[｜|]\s*){1,2}\s*(?:calls|tool_calls)\b/giu;
  marker.lastIndex = Math.max(0, fromIndex);
  for (let match = marker.exec(value); match; match = marker.exec(value)) {
    const offset = match.index;
    if (!isEscapedAt(value, offset) && !isInsideMarkdownCode(value, offset)) return offset;
  }
  return -1;
}

function quotedDsmlEnvelopeRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const envelope = /<｜DSML｜\s*(?:calls|tool_calls)\s*>[\s\S]*?<\/｜DSML｜\s*(?:calls|tool_calls)\s*>/giu;
  for (const match of value.matchAll(envelope)) {
    const start = match.index ?? -1;
    if (start >= 0 && (isEscapedAt(value, start) || isInsideMarkdownCode(value, start))) {
      ranges.push({ start, end: start + match[0].length });
    }
  }
  return ranges;
}

function isEscapedAt(value: string, offset: number): boolean {
  let slashCount = 0;
  for (let index = offset - 1; index >= 0 && value[index] === '\\'; index -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function isInsideMarkdownCode(value: string, offset: number): boolean {
  let fence: { char: '`' | '~'; length: number } | undefined;
  let inlineTicks = 0;
  let lineStart = true;

  for (let index = 0; index < offset;) {
    const character = value[index];
    if (character === '\n') {
      lineStart = true;
      index += 1;
      continue;
    }
    if (lineStart) {
      let markerOffset = index;
      while (markerOffset < offset && markerOffset - index < 3 && value[markerOffset] === ' ') markerOffset += 1;
      const markerCharacter = value[markerOffset];
      if (markerCharacter === '`' || markerCharacter === '~') {
        const markerLength = repeatedCharacterLength(value, markerOffset, markerCharacter);
        if (markerLength >= 3) {
          if (!fence) fence = { char: markerCharacter, length: markerLength };
          else if (fence.char === markerCharacter && markerLength >= fence.length) fence = undefined;
          index = markerOffset + markerLength;
          lineStart = false;
          continue;
        }
      }
      lineStart = false;
    }
    if (!fence && character === '`') {
      const markerLength = repeatedCharacterLength(value, index, '`');
      if (inlineTicks === 0) inlineTicks = markerLength;
      else if (inlineTicks === markerLength) inlineTicks = 0;
      index += markerLength;
      continue;
    }
    index += 1;
  }
  return fence !== undefined || inlineTicks > 0;
}

function repeatedCharacterLength(value: string, offset: number, character: string): number {
  let length = 0;
  while (value[offset + length] === character) length += 1;
  return length;
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
