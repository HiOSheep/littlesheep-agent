// Owns bounded text parsing and exact labeled-value matching for answer-level continuity checks.

import type { Message } from '@littlesheep/types';
import { readSessionSummaryFidelityFields } from './session-summary-fidelity-text.js';

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

export interface ContinuityLabeledValue {
  label: string;
  value: string;
}

interface ContinuityValueLabelDefinition {
  label: string;
  aliases: readonly string[];
}

const CONTINUITY_VALUE_LABEL_DEFINITIONS = [
  { label: '代号', aliases: ['验收代号', '代号'] },
  { label: '颜色', aliases: ['颜色'] },
  { label: '名称', aliases: ['文件名称', '项目名称', '名称'] },
  { label: '名字', aliases: ['名字'] },
  { label: '数值', aliases: ['数值'] },
  { label: '数字', aliases: ['数字'] },
  { label: '金额', aliases: ['金额'] },
  { label: '预算', aliases: ['预算'] },
  { label: '版本', aliases: ['版本'] },
  { label: '路径', aliases: ['文件路径', '路径'] },
  { label: '日期', aliases: ['日期'] },
  { label: '时间', aliases: ['时间'] },
  { label: 'executionCount', aliases: ['executionCount', 'execution count', '执行次数'] },
  { label: 'ticks', aliases: ['ticks', 'tick count'] },
  { label: 'completed', aliases: ['completed', '完成状态'] },
  { label: 'code', aliases: ['acceptance code', 'code'] },
  { label: 'color', aliases: ['color'] },
  { label: 'name', aliases: ['file name', 'project name', 'name'] },
  { label: 'value', aliases: ['value'] },
  { label: 'number', aliases: ['number'] },
  { label: 'amount', aliases: ['amount'] },
  { label: 'budget', aliases: ['budget'] },
  { label: 'version', aliases: ['version'] },
  { label: 'path', aliases: ['file path', 'path'] },
  { label: 'date', aliases: ['date'] },
  { label: 'time', aliases: ['time'] },
] as const satisfies readonly ContinuityValueLabelDefinition[];

const CONTINUITY_VALUE_LABELS = CONTINUITY_VALUE_LABEL_DEFINITIONS
  .map((definition) => definition.label);

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
  const requestedLabels = continuityRequestedValueLabels(request);
  const targets: ContinuityValueTarget[] = [];
  const seen = new Set<string>();
  for (const label of requestedLabels) {
    let resolved = false;
    for (const source of sources) {
      for (let index = source.texts.length - 1; index >= 0; index--) {
        const value = source.source === 'session_summary'
          ? extractSessionSummaryFidelityValue(source.texts[index], label)
          : extractLabeledValue(source.texts[index], label);
        if (!value) continue;
        const normalizedValue = normalizeComparableValue(value);
        const terms = continuityTerms(value);
        const targetKey = `${label}:${normalizedValue}`;
        if (
          normalizedValue
          && (terms.size > 0 || isExactLabeledScalar(normalizedValue))
          && !seen.has(targetKey)
        ) {
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

export function continuityRequestedValueLabels(value: string | undefined): string[] {
  const normalized = value?.normalize('NFKC').toLowerCase() ?? '';
  return normalized
    ? CONTINUITY_VALUE_LABELS.filter((label) => requestMentionsValueLabel(normalized, label))
    : [];
}

/** Extract the latest concrete value for each continuity label without normalizing its value. */
export function continuityLabeledValues(value: string | undefined): ContinuityLabeledValue[] {
  return CONTINUITY_VALUE_LABELS.flatMap((label) => {
    const extracted = extractLabeledValue(value, label);
    return extracted ? [{ label, value: extracted }] : [];
  });
}

export function continuityValueTargetMatched(
  reply: string | undefined,
  target: ContinuityValueTarget,
  overlap: ContinuityOverlap,
): boolean {
  if (!reply) return false;
  const replyValue = extractLabeledValue(reply, target.label);
  if (!replyValue || normalizeComparableValue(replyValue) !== target.value) return false;
  const normalizedReply = normalizeComparableValue(reply);
  if (replyNegatesValueTarget(normalizedReply, target)) return false;
  if (target.terms.size === 0) return isExactLabeledScalar(target.value);
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
  const source = value?.normalize('NFKC').slice(0, MAX_SOURCE_CHARS) ?? '';
  if (!source) return undefined;
  const labelSuffix = '(?:\\s|\\*\\*|__|~~)*';
  const assignment = '(?:是|为|改成|改为|更新为|设为|设置为|调整为|换成|becomes?|is|=|:|：)';
  const candidates: Array<{ index: number; priority: number; value: string }> = [];
  collectMarkdownTableValueCandidates(source, label, candidates);
  for (const alias of valueLabelAliases(label)) {
    const escapedLabel = escapeRegExp(alias);
    const labelPattern = /^[a-z]/iu.test(alias) ? `\\b${escapedLabel}\\b` : escapedLabel;
    const patterns = [
      {
        priority: 3,
        regex: new RegExp(
          `${labelPattern}${labelSuffix}(?:${assignment})?\\s*[“"‘'\`]([^”"’'\`\\r\\n]{1,120})[”"’'\`]`,
          'giu',
        ),
      },
      {
        priority: 3,
        regex: new RegExp(
          `${labelPattern}${labelSuffix}${assignment}\\s*([^,，。；;、\\r\\n]{1,120})`,
          'giu',
        ),
      },
      {
        priority: 1,
        regex: new RegExp(
          `${labelPattern}${labelSuffix}([a-z0-9][a-z0-9_+#.\\/-]{1,80}|[\\p{Script=Han}]{1,16})`,
          'giu',
        ),
      },
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern.regex)) {
        const extracted = cleanExtractedValue(trimAtFollowingLabel(match[1] ?? '', label));
        if (!extracted || looksLikeValuePlaceholder(extracted)) continue;
        candidates.push({
          index: match.index ?? 0,
          priority: pattern.priority + alias.length / 1_000,
          value: extracted,
        });
      }
    }
  }
  candidates.sort((left, right) => right.priority - left.priority || right.index - left.index);
  return candidates[0]?.value;
}

function collectMarkdownTableValueCandidates(
  source: string,
  label: string,
  candidates: Array<{ index: number; priority: number; value: string }>,
): void {
  let offset = 0;
  for (const line of source.split(/\r?\n/gu)) {
    const lineIndex = offset;
    offset += line.length + 1;
    const cells = markdownTableCells(line);
    if (cells.length < 2 || isMarkdownTableDivider(cells)) continue;
    const labelCell = cleanMarkdownTableCell(cells[0]!);
    if (!valueLabelAliases(label).some((alias) => tableLabelMatches(labelCell, alias))) continue;
    const extracted = cleanExtractedValue(cleanMarkdownTableCell(cells[1]!));
    if (!extracted || looksLikeValuePlaceholder(extracted)) continue;
    candidates.push({ index: lineIndex, priority: 4, value: extracted });
  }
}

function markdownTableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return [];
  const bounded = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutEnd = bounded.endsWith('|') ? bounded.slice(0, -1) : bounded;
  return withoutEnd.split('|');
}

function cleanMarkdownTableCell(value: string): string {
  return value.trim()
    .replace(/^(?:\*\*|__|~~|`)+/gu, '')
    .replace(/(?:\*\*|__|~~|`)+$/gu, '')
    .trim();
}

function isMarkdownTableDivider(cells: readonly string[]): boolean {
  return cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function tableLabelMatches(cell: string, alias: string): boolean {
  const normalizedCell = comparableLabel(cell);
  const normalizedAlias = comparableLabel(alias);
  if (normalizedCell === normalizedAlias) return true;
  return /^[a-z]/iu.test(alias)
    ? new RegExp(`\\b${escapeRegExp(normalizedAlias)}\\b`, 'iu').test(normalizedCell)
    : normalizedCell.includes(normalizedAlias);
}

function extractSessionSummaryFidelityValue(
  value: string | undefined,
  label: string,
): string | undefined {
  const authoritative = readSessionSummaryFidelityFields(value)
    .filter((field) => valueLabelAliases(label).some(
      (alias) => comparableLabel(field.label) === comparableLabel(alias),
    ))
    .at(-1)?.value;
  const authoritativeValue = cleanExtractedValue(authoritative);
  return authoritativeValue && !looksLikeValuePlaceholder(authoritativeValue)
    ? authoritativeValue
    : undefined;
}

function comparableLabel(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').trim();
}

function requestMentionsValueLabel(request: string, label: string): boolean {
  return valueLabelAliases(label).some((alias) => requestMentionsValueAlias(request, alias));
}

function requestMentionsValueAlias(request: string, alias: string): boolean {
  const regex = new RegExp(
    /^[a-z]/iu.test(alias)
      ? `\\b${escapeRegExp(alias)}\\b`
      : escapeRegExp(alias),
    'giu',
  );
  return [...request.matchAll(regex)].some((match) => !isFormattingOnlyValueLabelUse(
    request,
    match.index ?? 0,
    alias,
  ));
}

function isFormattingOnlyValueLabelUse(request: string, index: number, alias: string): boolean {
  const before = request.slice(Math.max(0, index - 12), index);
  const after = request.slice(index + alias.length, index + alias.length + 12);
  if (alias === '数字' || alias === '数值') {
    return /(?:用|以|按)(?:阿拉伯)?$/u.test(before)
      || /^(?:形式|格式)(?:回答|输出|表示)?/u.test(after);
  }
  if (alias === 'number') {
    return /(?:\bas\s+(?:a\s+)?|\bin\s+)$/iu.test(before)
      || /^s?\s+(?:format|form)\b/iu.test(after);
  }
  return false;
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
    .flatMap(valueLabelAliases)
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
  return /^(?:\.{2,}|…+|不是|并非|不为|和|及|以及|都|已|已经|会|将|要|需要|被|还|吗|呢|嘛|是否|什么|啥|多少|哪个|哪一个|哪种|如何|怎么|怎样|记录|保存|记住|确认)/u.test(normalized)
    || /^(?:and|or|not|was|were|is|are|recorded|saved|remembered|confirmed)\b/iu.test(normalized);
}

function replyNegatesValueTarget(reply: string, target: ContinuityValueTarget): boolean {
  const label = valueLabelAliases(target.label).map(escapeRegExp).join('|');
  const value = escapeRegExp(target.value);
  return [
    new RegExp(`(?:${label})\\s*(?:是|为|=|:|：)?\\s*(?:不是|并非|不为|≠|not\\s+)\\s*[“"'\`]?${value}`, 'iu'),
    new RegExp(`(?:不是|并非|不为|≠|not\\s+)\\s*[“"'\`]?${value}`, 'iu'),
    new RegExp(`${value}\\s*(?:不对|错误|并不正确|is\\s+wrong|is\\s+incorrect)`, 'iu'),
  ].some((pattern) => pattern.test(reply));
}

function valueLabelAliases(label: string): readonly string[] {
  return CONTINUITY_VALUE_LABEL_DEFINITIONS.find(
    (definition) => definition.label === label,
  )?.aliases ?? [label];
}

function isExactLabeledScalar(value: string): boolean {
  return /^(?:[-+]?(?:\d+(?:\.\d+)?|\.\d+)|true|false|yes|no|是|否|完成|未完成)$/iu.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function markerAtomId(line: string, prefix: string): string | undefined {
  if (!line.startsWith(prefix) || !line.endsWith(' -->')) return undefined;
  const atomId = line.slice(prefix.length, -4).trim();
  return atomId || undefined;
}
