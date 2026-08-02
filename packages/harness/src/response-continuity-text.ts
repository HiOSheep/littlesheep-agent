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

function markerAtomId(line: string, prefix: string): string | undefined {
  if (!line.startsWith(prefix) || !line.endsWith(' -->')) return undefined;
  const atomId = line.slice(prefix.length, -4).trim();
  return atomId || undefined;
}
