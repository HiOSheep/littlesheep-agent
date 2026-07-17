// Computes current-task relevance without mixing in truth confidence or long-term usefulness.

import { composeMemoryTaskQuery, type MemoryTaskQuery } from './task-query.js';

export type MemoryTaskRelevanceField = 'retrieval-key' | 'title' | 'summary' | 'content';

export interface MemoryTaskRelevanceDocument {
  title?: string;
  summary?: string;
  content?: string;
  searchKeys?: readonly string[];
}

export interface MemoryTaskRelevanceResult {
  score: number;
  queryTermCount: number;
  matchedTerms: string[];
  strongestField?: MemoryTaskRelevanceField;
  exactPhrase: boolean;
  matchedExclusions: string[];
  alignedExclusions: string[];
  blockedByExclusion: boolean;
}

const FIELD_WEIGHTS: Record<MemoryTaskRelevanceField, number> = {
  'retrieval-key': 1,
  title: 0.95,
  summary: 0.8,
  content: 0.6,
};

const STOP_TERMS = new Set([
  'a', 'an', 'and', 'are', 'about', 'current', 'for', 'help', 'how', 'is', 'me', 'of', 'or',
  'please', 'that', 'the', 'this', 'these', 'those', 'to', 'use', 'what', 'with',
  '一下', '关于', '当前', '进行', '可以', '如何', '是否', '什么', '现在', '需要', '这个', '那个', '这些', '那些',
  '继续', '接着', '处理', '执行', '完成', '推进', '按照', '请问', '帮我',
]);

const DOCUMENT_REJECTION_MARKERS = [
  '不要', '别用', '不用', '无需', '不采用', '不使用', '不考虑', '不再', '禁止', '排除', '避免',
  '拒绝', '舍弃', '淘汰', '废弃', '停用', '替代', '已替代',
  'donot', 'dont', 'not', 'without', 'exclude', 'avoid', 'never', 'reject', 'drop', 'deprecated',
  'superseded', 'replaced', 'nolonger', 'insteadof',
];

export function scoreMemoryTaskRelevance(
  query: string | MemoryTaskQuery,
  document: MemoryTaskRelevanceDocument,
): MemoryTaskRelevanceResult {
  const taskQuery = typeof query === 'string' ? composeMemoryTaskQuery(query) : query;
  const fields = normalizedFields(document);
  const segments = taskQuery.positiveSegments?.length > 0
    ? taskQuery.positiveSegments
    : [{ source: 'current' as const, text: taskQuery.positiveText, weight: 1 }];
  const positive = segments
    .map((segment) => {
      const scored = scorePositiveSegment(segment.text, fields);
      return { ...scored, weightedScore: scored.score * clamp01(segment.weight) };
    })
    .sort((left, right) => right.weightedScore - left.weightedScore || right.score - left.score)[0]
    ?? emptyPositiveScore();
  const exclusions = evaluateExclusions(taskQuery.excludedPhrases, fields);
  if (exclusions.blocked.length > 0) {
    return {
      score: 0,
      queryTermCount: positive.queryTermCount + exclusionTermCount(exclusions.blocked),
      matchedTerms: [],
      strongestField: exclusions.strongestField,
      exactPhrase: false,
      matchedExclusions: exclusions.matched,
      alignedExclusions: exclusions.aligned,
      blockedByExclusion: true,
    };
  }

  const alignedScore = exclusions.aligned.length > 0 ? exclusions.strongestWeight * 0.9 : 0;
  const strongestField = exclusions.strongestWeight > positive.strongestWeight
    ? exclusions.strongestField
    : positive.strongestField;
  return {
    score: clamp01(Math.max(positive.weightedScore, alignedScore)),
    queryTermCount: positive.queryTermCount + exclusionTermCount(exclusions.aligned),
    matchedTerms: [...positive.matchedTerms, ...exclusions.aligned].slice(0, 16),
    strongestField,
    exactPhrase: positive.exactPhrase || exclusions.aligned.length > 0,
    matchedExclusions: exclusions.matched,
    alignedExclusions: exclusions.aligned,
    blockedByExclusion: false,
  };
}

interface PositiveSegmentScore {
  score: number;
  weightedScore: number;
  queryTermCount: number;
  matchedTerms: string[];
  strongestField?: MemoryTaskRelevanceField;
  strongestWeight: number;
  exactPhrase: boolean;
}

function scorePositiveSegment(
  value: string,
  fields: ReturnType<typeof normalizedFields>,
): Omit<PositiveSegmentScore, 'weightedScore'> {
  const effectiveQuery = stripRequestFraming(normalize(value));
  const terms = taskTerms(effectiveQuery);
  const matchedTerms: string[] = [];
  let weightedCoverage = 0;
  let strongestField: MemoryTaskRelevanceField | undefined;
  let strongestWeight = 0;
  for (const term of terms) {
    let bestField: MemoryTaskRelevanceField | undefined;
    let bestWeight = 0;
    for (const field of fields) {
      if (field.values.some((fieldValue) => matchesTerm(fieldValue, term)) && field.weight > bestWeight) {
        bestField = field.name;
        bestWeight = field.weight;
      }
    }
    if (!bestField) continue;
    matchedTerms.push(term);
    weightedCoverage += bestWeight;
    if (bestWeight > strongestWeight) {
      strongestField = bestField;
      strongestWeight = bestWeight;
    }
  }
  const compactQuery = compact(effectiveQuery);
  let phraseScore = 0;
  let exactPhrase = false;
  if (compactQuery.length >= 4) {
    for (const field of fields) {
      if (field.values.some((fieldValue) => compact(fieldValue).includes(compactQuery))) {
        phraseScore = Math.max(phraseScore, field.weight);
        exactPhrase = true;
        if (field.weight > strongestWeight) {
          strongestField = field.name;
          strongestWeight = field.weight;
        }
      }
    }
  }
  return {
    score: terms.length > 0 ? clamp01(Math.max(weightedCoverage / terms.length, phraseScore)) : 0,
    queryTermCount: terms.length,
    matchedTerms,
    strongestField,
    strongestWeight,
    exactPhrase,
  };
}

function emptyPositiveScore(): PositiveSegmentScore {
  return {
    score: 0,
    weightedScore: 0,
    queryTermCount: 0,
    matchedTerms: [],
    strongestWeight: 0,
    exactPhrase: false,
  };
}

export function describeMemoryTaskRelevance(result: MemoryTaskRelevanceResult): string {
  if (result.queryTermCount === 0) return 'task relevance 0.000 (no meaningful query terms)';
  const field = result.strongestField ? `; strongest=${result.strongestField}` : '';
  const phrase = result.exactPhrase ? '; exact-phrase' : '';
  const exclusion = result.blockedByExclusion
    ? `; excluded=${result.matchedExclusions.join('|')}`
    : result.alignedExclusions.length > 0
      ? `; constraint=${result.alignedExclusions.join('|')}`
      : '';
  return `task relevance ${result.score.toFixed(3)} (${result.matchedTerms.length}/${result.queryTermCount} terms${field}${phrase}${exclusion})`;
}

interface ExclusionEvaluation {
  matched: string[];
  aligned: string[];
  blocked: string[];
  strongestField?: MemoryTaskRelevanceField;
  strongestWeight: number;
}

function evaluateExclusions(
  phrases: readonly string[],
  fields: ReturnType<typeof normalizedFields>,
): ExclusionEvaluation {
  const result: ExclusionEvaluation = { matched: [], aligned: [], blocked: [], strongestWeight: 0 };
  for (const rawPhrase of phrases) {
    const phrase = normalize(rawPhrase);
    if (!compact(phrase)) continue;
    let matchedField: MemoryTaskRelevanceField | undefined;
    let matchedWeight = 0;
    let aligned = false;
    for (const field of fields) {
      for (const value of field.values) {
        if (!matchesPhrase(value, phrase)) continue;
        if (field.weight > matchedWeight) {
          matchedField = field.name;
          matchedWeight = field.weight;
        }
        if (explicitlyRejects(value, phrase)) aligned = true;
      }
    }
    if (!matchedField) continue;
    result.matched.push(rawPhrase);
    if (aligned) result.aligned.push(rawPhrase);
    else result.blocked.push(rawPhrase);
    if (matchedWeight > result.strongestWeight) {
      result.strongestField = matchedField;
      result.strongestWeight = matchedWeight;
    }
  }
  return result;
}

function normalizedFields(document: MemoryTaskRelevanceDocument): Array<{
  name: MemoryTaskRelevanceField;
  weight: number;
  values: string[];
}> {
  return [
    { name: 'retrieval-key', weight: FIELD_WEIGHTS['retrieval-key'], values: (document.searchKeys ?? []).map(normalize) },
    { name: 'title', weight: FIELD_WEIGHTS.title, values: [normalize(document.title ?? '')] },
    { name: 'summary', weight: FIELD_WEIGHTS.summary, values: [normalize(document.summary ?? '')] },
    { name: 'content', weight: FIELD_WEIGHTS.content, values: [normalize(document.content ?? '')] },
  ];
}

function taskTerms(normalized: string): string[] {
  const terms: string[] = [];
  for (const value of normalized.match(/[a-z0-9_-]{2,}/gu) ?? []) terms.push(value);
  for (const run of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
    const characters = [...run];
    if (characters.length === 2) terms.push(run);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      terms.push(characters[index]! + characters[index + 1]!);
    }
  }
  return [...new Set(terms.filter((term) => term.length > 1 && !STOP_TERMS.has(term)))];
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function stripRequestFraming(value: string): string {
  return value
    .replace(/^(?:(?:请问|请|麻烦)(?:帮我|帮助我)?|(?:帮我|帮助我))(?:检查|查看|看看|分析|处理)?/u, '')
    .replace(/一下$/u, '')
    .trim();
}

function compact(value: string): string {
  return value.replace(/[^\p{L}\p{N}_-]+/gu, '');
}

function matchesTerm(value: string, term: string): boolean {
  if (!/^[a-z0-9_-]+$/u.test(term)) return value.includes(term);
  return new Set(value.match(/[a-z0-9_-]{2,}/gu) ?? []).has(term);
}

function matchesPhrase(value: string, phrase: string): boolean {
  const compactPhrase = compact(phrase);
  return compactPhrase.length > 1 && compact(value).includes(compactPhrase);
}

function explicitlyRejects(value: string, phrase: string): boolean {
  const compactValue = compact(value)
    .replace(/notonly/gu, '')
    .replace(/不仅|不只是/gu, '');
  const compactPhrase = compact(phrase);
  let offset = compactValue.indexOf(compactPhrase);
  while (offset >= 0) {
    const start = Math.max(0, offset - 32);
    const end = Math.min(compactValue.length, offset + compactPhrase.length + 32);
    const window = compactValue.slice(start, end);
    if (DOCUMENT_REJECTION_MARKERS.some((marker) => window.includes(marker))) return true;
    offset = compactValue.indexOf(compactPhrase, offset + compactPhrase.length);
  }
  return false;
}

function exclusionTermCount(phrases: readonly string[]): number {
  return phrases.reduce((sum, phrase) => sum + Math.max(1, taskTerms(normalize(phrase)).length), 0);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
