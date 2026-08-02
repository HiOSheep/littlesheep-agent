import type { Message } from '@littlesheep/types';

const MAX_SOURCE_CHARS = 12_000;
const MEMORY_ATOM_START = '<!-- littlesheep-memory-atom:start ';
const MEMORY_ATOM_END = '<!-- littlesheep-memory-atom:end ';

// Matching any of these terms alone is not useful evidence that a reply
// remembered an earlier turn or an injected Atom.
const STOP_TERMS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'have', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'we', 'what', 'when', 'where', 'which', 'with', 'you',
  '一个', '一些', '不是', '可以', '这个', '那么', '如果', '已经', '当前',
  '进行', '需要', '然后', '因为', '所以', '通过', '以及', '用户', '回答',
  '问题', '内容', '信息', '相关', '这里', '现在', '所有', '是否', '没有',
  '任务', '处理', '完成', '继续', '结果', '好的', '支持', '使用', '进行中',
]);

export interface ContinuityOverlap {
  count: number;
  ratio: number;
  terms: string[];
}

export interface MemoryAtomText {
  atomId: string;
  text: string;
}

export interface ContinuityValueTarget {
  label: string;
  value: string;
  terms: Set<string>;
  source: ContinuityValueSource;
}

export type ContinuityValueSource =
  | 'recent_history'
  | 'session_summary'
  | 'active_memory_atom';

export interface ContinuityValueSourceText {
  source: ContinuityValueSource;
  texts: readonly string[];
}

const CONTINUITY_VALUE_LABELS = [
  '代号', '颜色', '名称', '名字', '数值', '数字', '金额', '预算', '版本', '路径', '日期', '时间',
  'code', 'color', 'name', 'value', 'number', 'amount', 'budget', 'version', 'path', 'date', 'time',
] as const;

export function strongContinuityAnchor(value: ContinuityOverlap): boolean {
  return value.count >= 2 && value.ratio >= 0.2;
}

export function continuityOverlap(
  left: Set<string>,
  right: Set<string>,
): ContinuityOverlap {
  if (left.size === 0 || right.size === 0) return { count: 0, ratio: 0, terms: [] };
  const terms: string[] = [];
  for (const term of left) if (right.has(term)) terms.push(term);
  return {
    count: terms.length,
    ratio: terms.length / Math.max(1, Math.min(left.size, right.size)),
    terms,
  };
}

export function withoutContinuityTerms(
  source: Set<string>,
  excluded: Set<string>,
): Set<string> {
  return new Set([...source].filter((term) => !excluded.has(term)));
}

export function continuityMessageText(message: Message | undefined): string {
  return message?.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n') ?? '';
}

export function parseMemoryAtomSections(value: string | undefined): MemoryAtomText[] {
  if (!value) return [];
  const lines = value.slice(0, MAX_SOURCE_CHARS).split(/\r?\n/u);
  const atoms: MemoryAtomText[] = [];
  let atomId: string | undefined;
  let content: string[] = [];
  for (const line of lines) {
    const startId = markerAtomId(line, MEMORY_ATOM_START);
    if (startId) {
      if (atomId) atoms.push({ atomId, text: content.join('\n') });
      atomId = startId;
      content = [];
      continue;
    }
    const endId = markerAtomId(line, MEMORY_ATOM_END);
    if (endId && atomId === endId) {
      atoms.push({ atomId, text: content.join('\n') });
      atomId = undefined;
      content = [];
      continue;
    }
    if (atomId) content.push(line);
  }
  if (atomId) atoms.push({ atomId, text: content.join('\n') });
  return atoms;
}

export function stripMemoryAtomSections(value: string | undefined): string {
  if (!value) return '';
  const lines = value.slice(0, MAX_SOURCE_CHARS).split(/\r?\n/u);
  const retained: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (markerAtomId(line, MEMORY_ATOM_START)) {
      inside = true;
      continue;
    }
    if (markerAtomId(line, MEMORY_ATOM_END)) {
      inside = false;
      continue;
    }
    if (!inside) retained.push(line);
  }
  return retained.join('\n');
}

export function continuityTerms(value: string | undefined): Set<string> {
  const source = value?.normalize('NFKC').slice(0, MAX_SOURCE_CHARS) ?? '';
  const terms = new Set<string>();
  for (const run of source.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length <= 16 && !STOP_TERMS.has(run)) terms.add(run);
    for (let index = 0; index + 1 < run.length; index += 1) {
      const pair = run.slice(index, index + 2);
      if (!STOP_TERMS.has(pair)) terms.add(pair);
    }
  }
  for (const word of source.match(/[a-z0-9][a-z0-9_+#.-]{1,}/giu) ?? []) {
    const normalized = word.toLowerCase();
    if (!STOP_TERMS.has(normalized)) terms.add(normalized);
  }
  return terms;
}

/**
 * Resolve concrete prior values explicitly requested by the current continuation.
 * This prevents an incidental historical instruction from standing in for the
 * actual value the user asked LS to remember.
 */
export function continuityRequestedValueTargets(
  request: string | undefined,
  sources: readonly ContinuityValueSourceText[],
): ContinuityValueTarget[] {
  const normalizedRequest = request?.normalize('NFKC').toLowerCase() ?? '';
  if (!normalizedRequest) return [];
  const requestedLabels = CONTINUITY_VALUE_LABELS.filter((label) => (
    requestMentionsValueLabel(normalizedRequest, label)
  ));
  const targets: ContinuityValueTarget[] = [];
  const seen = new Set<string>();
  for (const label of requestedLabels) {
    let resolved = false;
    for (const source of sources) {
      for (let index = source.texts.length - 1; index >= 0; index--) {
        const value = extractLabeledValue(source.texts[index], label);
        if (!value) continue;
        const terms = continuityTerms(value);
        const normalizedValue = normalizeComparableValue(value);
        const targetKey = `${label}:${normalizedValue}`;
        if (terms.size > 0 && normalizedValue && !seen.has(targetKey)) {
          seen.add(targetKey);
          targets.push({ label, value: normalizedValue, terms, source: source.source });
        }
        resolved = true;
        break;
      }
      if (resolved) break;
    }
  }
  return targets;
}

export function continuityValueTargetMatched(
  reply: string | undefined,
  target: ContinuityValueTarget,
  overlap: ContinuityOverlap,
): boolean {
  if (!reply || target.terms.size <= 0) return false;
  const normalizedReply = normalizeComparableValue(reply);
  if (!normalizedReply.includes(target.value)) return false;
  if (replyNegatesValueTarget(normalizedReply, target)) return false;
  return overlap.count >= Math.min(2, target.terms.size) && overlap.ratio >= 0.5;
}

export function replyExplicitlyDisclaimsContinuity(value: string | undefined): boolean {
  const normalized = value?.normalize('NFKC').trim().toLowerCase() ?? '';
  if (!normalized) return false;
  if (/(?:并非|不是)(?:我)?(?:不记得|忘(?:了|记)|无法回忆)/u.test(normalized)) return false;
  return [
    /(?:我)?(?:不记得|忘(?:了|记)(?:上一轮|上次|之前)?|想不起来|无法(?:回忆|记起|确认))(?:[^。！？!?\r\n]{0,48})/u,
    /请(?:重新|再)(?:告诉|提供|说明)(?:我)?(?:上一轮|上次|之前|相关)?(?:[^。！？!?\r\n]{0,32})/u,
    /\b(?:i\s+)?(?:do\s+not|don't|cannot|can't)\s+(?:remember|recall)\b/iu,
    /\bi\s+(?:forgot|have\s+forgotten)\b/iu,
    /\bplease\s+(?:tell|provide|explain)(?:\s+it)?\s+again\b/iu,
  ].some((pattern) => pattern.test(normalized));
}

function extractLabeledValue(value: string | undefined, label: string): string | undefined {
  const source = value?.normalize('NFKC') ?? '';
  if (!source) return undefined;
  const escapedLabel = escapeRegExp(label);
  const labelSuffix = '(?:\\s|\\*\\*|__|~~)*';
  const quoted = source.match(new RegExp(
    `${escapedLabel}${labelSuffix}(?:是|为|=|:|：)?\\s*[“"‘'\`]([^”"’'\`\\r\\n]{1,120})[”"’'\`]`,
    'iu',
  ));
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const delimited = source.match(new RegExp(
    `${escapedLabel}${labelSuffix}(?:是|为|=|:|：)\\s*([^，。；;、\\r\\n]{1,120})`,
    'iu',
  ));
  if (delimited?.[1]?.trim()) {
    return cleanExtractedValue(trimAtFollowingLabel(delimited[1], label));
  }
  const compact = source.match(new RegExp(
    `${escapedLabel}${labelSuffix}([a-z0-9][a-z0-9_+#.\\/-]{1,80}|[\\p{Script=Han}]{1,16})`,
    'iu',
  ));
  const compactValue = cleanExtractedValue(compact?.[1]);
  return compactValue && !looksLikeValuePlaceholder(compactValue)
    ? compactValue
    : undefined;
}

function requestMentionsValueLabel(request: string, label: string): boolean {
  return /^[a-z]/iu.test(label)
    ? new RegExp(`\\b${escapeRegExp(label)}\\b`, 'iu').test(request)
    : request.includes(label);
}

function normalizeComparableValue(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function cleanExtractedValue(value: string | undefined): string | undefined {
  const normalized = value?.trim()
    .replace(/^(?:\*\*|__|~~|`)+/gu, '')
    .replace(/(?:\*\*|__|~~|`)+$/gu, '')
    .trim();
  return normalized || undefined;
}

function trimAtFollowingLabel(value: string, currentLabel: string): string {
  const otherLabels = CONTINUITY_VALUE_LABELS
    .filter((label) => label !== currentLabel)
    .map(escapeRegExp)
    .join('|');
  const boundary = value.search(new RegExp(
    `\\s*(?:(?:和|及|以及|and)|[,，;；、])\\s*(?:${otherLabels})(?:\\b|\\s|是|为|=|:|：)`,
    'iu',
  ));
  return (boundary >= 0 ? value.slice(0, boundary) : value).trim();
}

function looksLikeValuePlaceholder(value: string): boolean {
  const normalized = normalizeComparableValue(value);
  return /^(?:和|及|以及|都|已|已经|会|将|要|需要|被|还|是否|什么|多少|哪个|哪一个|记录|保存|记住|确认)/u.test(normalized)
    || /^(?:and|or|was|were|is|are|recorded|saved|remembered|confirmed)\b/iu.test(normalized);
}

function replyNegatesValueTarget(reply: string, target: ContinuityValueTarget): boolean {
  const label = escapeRegExp(target.label);
  const value = escapeRegExp(target.value);
  return [
    new RegExp(`${label}\\s*(?:是|为|=|:|：)?\\s*(?:不是|并非|不为|≠|not\\s+)\\s*[“"'\`]?${value}`, 'iu'),
    new RegExp(`(?:不是|并非|不为|≠|not\\s+)\\s*[“"'\`]?${value}`, 'iu'),
    new RegExp(`${value}\\s*(?:不对|错误|并不正确|is\\s+wrong|is\\s+incorrect)`, 'iu'),
  ].some((pattern) => pattern.test(reply));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function markerAtomId(line: string, prefix: string): string | undefined {
  if (!line.startsWith(prefix) || !line.endsWith(' -->')) return undefined;
  const atomId = line.slice(prefix.length, -4).trim();
  return atomId || undefined;
}
