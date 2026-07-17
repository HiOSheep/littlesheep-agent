// Builds a bounded retrieval query from the current request without replaying whole chat history.

export type MemoryTaskReferenceKind = 'none' | 'conversation' | 'assistant-selection';
export type MemoryTaskQuerySegmentSource = 'current' | 'recent-user' | 'recent-assistant' | 'session-summary';

export interface MemoryTaskQuerySegment {
  source: MemoryTaskQuerySegmentSource;
  text: string;
  weight: number;
}

export interface MemoryTaskQuery {
  /** Exact current user request, bounded for diagnostics. */
  currentText: string;
  /** Positive task text used for lexical relevance scoring. */
  positiveText: string;
  /** Independently scored task anchors; weaker continuity sources cannot dilute the current request. */
  positiveSegments: MemoryTaskQuerySegment[];
  /** Candidate-generation text. Includes excluded subjects so matching constraints can still be found. */
  retrievalText: string;
  /** Subjects the current task explicitly rejects. */
  excludedPhrases: string[];
  historyUsed: boolean;
  historyMessageCount: number;
  summaryUsed: boolean;
  summaryChars: number;
  continuitySummaryId?: string;
  referenceKind: MemoryTaskReferenceKind;
  taskShift: boolean;
}

export interface MemoryTaskQueryHistoryMessage {
  role: string;
  content: string;
}

export interface MemoryTaskContinuitySummary {
  id: string;
  content: string;
}

export interface MemoryTaskQueryLimits {
  maxCurrentChars?: number;
  maxHistoryChars?: number;
  maxHistoryMessages?: number;
  maxRetrievalChars?: number;
  maxExcludedPhrases?: number;
  maxSummaryChars?: number;
  maxSummarySegments?: number;
}

const DEFAULT_LIMITS: Required<MemoryTaskQueryLimits> = {
  maxCurrentChars: 1_200,
  maxHistoryChars: 1_200,
  maxHistoryMessages: 2,
  maxRetrievalChars: 1_800,
  maxExcludedPhrases: 8,
  maxSummaryChars: 1_000,
  maxSummarySegments: 4,
};

const TASK_SHIFT_PATTERNS = [
  /^(?:先不管|忽略|忘掉|放下)(?:刚才|之前|前面|上面)(?:的|那些)?(?:内容|任务|话题|方案)?[，,。\s]*/u,
  /^(?:换个|切换到|开始一个)(?:新的?|另一个)?(?:话题|任务|问题)[，,。\s]*/u,
  /^(?:new topic|new task|different topic|different task|switch(?:ing)? to|start(?:ing)? a new task)\b[,:\s-]*/iu,
  /^(?:ignore|forget|drop)\s+(?:the\s+)?(?:previous|earlier|above)\s+(?:context|task|topic|plan)\b[,:\s-]*/iu,
];

const ASSISTANT_REFERENCE_PATTERNS = [
  /(?:你|ls)(?:刚才|之前|上面|前面)?(?:说|提到|提出|建议|列出|给出)(?:的)?/iu,
  /(?:第[一二三四五六七八九十\d]+个|上一个|下一个)(?:方案|选项|建议|做法)/u,
  /\b(?:you (?:just |previously )?(?:said|suggested|listed|proposed)|the (?:first|second|third|previous|next) (?:option|plan|suggestion))\b/iu,
];

const REFERENCE_PATTERNS = [
  /^(?:请)?(?:继续|接着|照此|照做|按这个做|按那个做|就这样做|处理它|执行它|完成它)(?:吧|下去)?[。.!！\s]*$/u,
  /(?:刚才|之前|前面|上面|上述|下述)(?:的)?(?:这个|那个|内容|任务|方案|问题|做法)?/u,
  /(?:这个|那个|它|这些|那些)(?:呢|怎么办|怎么处理|继续|也一样)?[？?。.!！\s]*$/u,
  /\b(?:continue|go on|proceed|do that|do it|use that|same as above|the above|the previous one|this one|that one)\b/iu,
];

const NEGATIVE_SEGMENT_PATTERNS = [
  /(?:不要|别再?|无需|不用|不采用|不使用|不考虑|排除|禁止|忽略|去掉|移除|删除|舍弃|淘汰|拒绝)([^，,；;。.!！?？\n]*?)(?=(?:而是|改用|改为|转为|换成|保留)|[，,；;。.!！?？\n]|$)/gu,
  /不是([^，,；;。.!！?？\n]*?)(?=(?:而是|改用|改为|转为|换成)|[，,；;。.!！?？\n]|$)/gu,
  /\b(?:do\s+not|don't|dont|without|exclude|never|ignore|remove|drop|reject|instead\s+of)\s+([^,;.?!\n]*?)(?=(?:\b(?:but|instead|keep|switch\s+to)\b)|[,;.?!\n]|$)/giu,
];

const NEGATIVE_ONLY_PREFIX = /^(?:不要|别再?|无需|不用|不采用|不使用|不考虑|排除|禁止|忽略|去掉|移除|删除|舍弃|淘汰|拒绝|不是)\s*/u;
const ENGLISH_NEGATIVE_ONLY_PREFIX = /^(?:do\s+not|don't|dont|without|exclude|never|ignore|remove|drop|reject|instead\s+of)\s+/iu;
const CONTRAST_PREFIX = /^(?:而是|改用|改为|转为|换成|保留|采用|使用|but|instead|use|keep|switch\s+to)\s*/iu;

export function composeMemoryTaskQuery(
  currentText: string,
  recentHistory: readonly MemoryTaskQueryHistoryMessage[] = [],
  limits: MemoryTaskQueryLimits = {},
  continuitySummary?: MemoryTaskContinuitySummary,
): MemoryTaskQuery {
  const bounded = { ...DEFAULT_LIMITS, ...limits };
  const current = bound(normalizeWhitespace(currentText), bounded.maxCurrentChars);
  const taskShift = TASK_SHIFT_PATTERNS.some((pattern) => pattern.test(current));
  const referenceKind = taskShift ? 'none' : detectReferenceKind(current);
  const currentParts = partitionTaskText(taskShift ? stripTaskShiftFraming(current) : current);
  const currentSignal = meaningfulSignal(stripReferenceFraming(currentParts.positiveText));
  const shouldUseHistory = !taskShift
    && referenceKind !== 'none'
    && (referenceKind === 'assistant-selection' || currentSignal < 6);
  const selectedHistory = shouldUseHistory
    ? selectHistory(recentHistory, referenceKind, bounded)
    : [];
  const historyParts = selectedHistory.map((message) => ({ message, parts: partitionTaskText(message.content) }));
  const shouldUseSummary = shouldUseHistory
    && Boolean(continuitySummary?.content.trim())
    && continuitySignal(historyParts.map((entry) => entry.parts.positiveText).join(' ')) < 4;
  const selectedSummarySegments = shouldUseSummary
    ? selectContinuitySummary(continuitySummary!.content, bounded)
    : [];

  const positiveSegments: MemoryTaskQuerySegment[] = [];
  addPositiveSegment(positiveSegments, 'current', stripReferenceFraming(currentParts.positiveText), 1);
  const excludedPhrases = [...currentParts.excludedPhrases];
  for (const { message, parts } of historyParts) {
    addPositiveSegment(
      positiveSegments,
      message.role === 'user' ? 'recent-user' : 'recent-assistant',
      parts.positiveText,
      message.role === 'user' ? 0.9 : 0.8,
    );
    excludedPhrases.push(...parts.excludedPhrases);
  }
  for (const segment of selectedSummarySegments) {
    const parts = partitionTaskText(segment);
    addPositiveSegment(positiveSegments, 'session-summary', stripSummaryFraming(parts.positiveText), 0.7);
    excludedPhrases.push(...parts.excludedPhrases);
  }

  const positiveText = bound(
    uniqueNonEmpty(positiveSegments.map((segment) => segment.text)).join('\n'),
    bounded.maxRetrievalChars,
  );
  const exclusions = uniqueNonEmpty(excludedPhrases)
    .slice(0, bounded.maxExcludedPhrases);
  const retrievalText = bound(
    uniqueNonEmpty([positiveText, ...exclusions]).join('\n'),
    bounded.maxRetrievalChars,
  );

  return {
    currentText: current,
    positiveText,
    positiveSegments,
    retrievalText,
    excludedPhrases: exclusions,
    historyUsed: selectedHistory.length > 0,
    historyMessageCount: selectedHistory.length,
    summaryUsed: selectedSummarySegments.length > 0,
    summaryChars: selectedSummarySegments.reduce((sum, segment) => sum + segment.length, 0),
    continuitySummaryId: selectedSummarySegments.length > 0 ? continuitySummary?.id : undefined,
    referenceKind,
    taskShift,
  };
}

function addPositiveSegment(
  target: MemoryTaskQuerySegment[],
  source: MemoryTaskQuerySegmentSource,
  text: string,
  weight: number,
): void {
  const normalized = normalizeWhitespace(text);
  if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) return;
  target.push({ source, text: normalized, weight });
}

function detectReferenceKind(value: string): MemoryTaskReferenceKind {
  if (ASSISTANT_REFERENCE_PATTERNS.some((pattern) => pattern.test(value))) return 'assistant-selection';
  if (REFERENCE_PATTERNS.some((pattern) => pattern.test(value))) return 'conversation';
  return 'none';
}

function stripTaskShiftFraming(value: string): string {
  for (const pattern of TASK_SHIFT_PATTERNS) {
    if (pattern.test(value)) return value.replace(pattern, '').trim();
  }
  return value;
}

function selectHistory(
  history: readonly MemoryTaskQueryHistoryMessage[],
  referenceKind: MemoryTaskReferenceKind,
  limits: Required<MemoryTaskQueryLimits>,
): MemoryTaskQueryHistoryMessage[] {
  const eligible = history
    .filter((message) => ['user', 'assistant'].includes(message.role))
    .map((message) => ({ role: message.role, content: normalizeWhitespace(message.content) }))
    .filter((message) => message.content.length > 0);
  const selected: Array<{ index: number; message: MemoryTaskQueryHistoryMessage }> = [];
  const selectedIndexes = new Set<number>();
  let remainingChars = limits.maxHistoryChars;

  const push = (message: MemoryTaskQueryHistoryMessage | undefined): void => {
    const index = message ? eligible.indexOf(message) : -1;
    if (!message || index < 0 || selectedIndexes.has(index) || selected.length >= limits.maxHistoryMessages || remainingChars <= 0) return;
    const content = bound(message.content, Math.min(remainingChars, 700));
    if (!content) return;
    selectedIndexes.add(index);
    selected.push({ index, message: { role: message.role, content } });
    remainingChars -= content.length;
  };

  const latestUser = [...eligible].reverse().find((message) => message.role === 'user');
  const latestAssistant = [...eligible].reverse().find((message) => message.role === 'assistant');
  if (referenceKind === 'assistant-selection') {
    push(latestAssistant);
    push(latestUser);
  } else {
    push(latestUser);
    push(latestAssistant);
  }

  return selected.sort((left, right) => left.index - right.index).map((entry) => entry.message);
}

function partitionTaskText(value: string): { positiveText: string; excludedPhrases: string[] } {
  const excludedPhrases: string[] = [];
  let positive = value;
  if (!/(?:not\s+only|不仅|不只是)/iu.test(value)) {
    for (const pattern of NEGATIVE_SEGMENT_PATTERNS) {
      pattern.lastIndex = 0;
      positive = positive.replace(pattern, (match, captured: string) => {
        const phrase = cleanExcludedPhrase(captured);
        if (phrase) excludedPhrases.push(phrase);
        return ' ';
      });
    }
  }
  positive = positive
    .split(/(?<=[，,；;。.!！?？\n])/u)
    .map((segment) => segment.trim().replace(/^[，,；;。.!！?？\s]+/u, '').replace(CONTRAST_PREFIX, ''))
    .join(' ');
  return {
    positiveText: normalizeWhitespace(positive),
    excludedPhrases: uniqueNonEmpty(excludedPhrases),
  };
}

function cleanExcludedPhrase(value: string): string {
  return normalizeWhitespace(value)
    .replace(NEGATIVE_ONLY_PREFIX, '')
    .replace(ENGLISH_NEGATIVE_ONLY_PREFIX, '')
    .replace(/^(?:使用|采用|选择|执行|启用|use|using|adopt|choose|execute|enable)\s*/iu, '')
    .replace(CONTRAST_PREFIX, '')
    .replace(/^(?:再|继续)\s*/u, '')
    .replace(/(?:即可|就行|了|吧)$/u, '')
    .trim();
}

function stripReferenceFraming(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^(?:请)?(?:继续|接着|然后)(?:处理|执行|完成|推进|做)?(?:这个|那个|它|上述|刚才的|之前的|前面的)?[，,：:\s]*/u, '')
    .replace(/^(?:就)?按(?:照)?(?:你)?(?:刚才|之前|上面|前面)?(?:说|提到|提出|建议|列出|给出)?(?:的)?(?:第[一二三四五六七八九十\d]+个|这个|那个|上一个|下一个)?(?:方案|选项|建议|做法)?(?:做|执行|继续)?[，,：:\s]*/u, '')
    .replace(/^(?:please\s+)?(?:continue|go on|proceed)(?:\s+with)?(?:\s+(?:this|that|it|the previous task))?[,:\s-]*/iu, '')
    .trim();
}

function selectContinuitySummary(
  value: string,
  limits: Required<MemoryTaskQueryLimits>,
): string[] {
  const segments = value.normalize('NFKC').replace(/[^\S\r\n]+/gu, ' ').trim()
    .split(/(?<=[。.!！?？；;])\s*|\s*\n+\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((text, index) => ({ text, index, score: continuitySegmentScore(text) }));
  if (segments.length === 0) return [];
  const prioritized = segments.filter((segment) => segment.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limits.maxSummarySegments)
    .sort((left, right) => left.index - right.index);
  const selected = prioritized.length > 0
    ? prioritized
    : [...segments.slice(0, 2), ...segments.slice(-2)]
      .filter((segment, index, all) => all.findIndex((candidate) => candidate.index === segment.index) === index)
      .slice(0, limits.maxSummarySegments);
  const result: string[] = [];
  let remaining = limits.maxSummaryChars;
  for (const segment of selected) {
    const text = bound(segment.text, remaining);
    if (!text) break;
    result.push(text);
    remaining -= text.length;
  }
  return result;
}

function stripSummaryFraming(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^(?:当前目标|主要目标|用户目标|未完成(?:事项)?|待完成(?:事项)?|下一步|约束|决定|批准)[：:\s]*/u, '')
    .replace(/^(?:current goal|main goal|user goal|unfinished|pending|next step|constraint|decision|approval)[：:\s-]*/iu, '')
    .replace(/^(?:完成|处理|执行|验证|继续|finish|complete|handle|execute|verify|continue)\s*/iu, '')
    .trim();
}

function continuitySegmentScore(value: string): number {
  let score = 0;
  if (/(?:当前目标|主要目标|用户目标|未完成|待完成|下一步|继续|约束|决定|批准|current goal|main goal|unfinished|pending|next step|constraint|decision|approval)/iu.test(value)) score += 3;
  if (/(?:任务|项目|阶段|步骤|产物|文件|task|project|phase|step|artifact|file)/iu.test(value)) score += 1;
  return score;
}

function continuitySignal(value: string): number {
  const cleaned = normalizeWhitespace(value)
    .replace(/(?:下一步|接下来|继续|接着|处理|执行|完成|推进|任务|方案|步骤|阶段|这个|那个|已经完成|尚未完成)/gu, ' ')
    .replace(/\b(?:next|step|continue|proceed|resume|task|plan|option|done|complete|completed|work|this|that|it|ready|for|the|a|an|with|to|and|then|now)\b/giu, ' ');
  return meaningfulSignal(cleaned);
}

function meaningfulSignal(value: string): number {
  const latin = value.match(/[a-z0-9_-]{2,}/giu)?.length ?? 0;
  const han = [...(value.match(/[\p{Script=Han}]/gu) ?? [])].length;
  return latin * 2 + han;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeWhitespace(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function bound(value: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (value.length <= limit) return value;
  return value.slice(0, limit).trimEnd();
}
