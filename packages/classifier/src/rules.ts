// @littlesheep/classifier — rules.ts
// Rule-based fast path classifier. <1ms. Returns null when no rule matches.

import {
  messageClassFromActivity,
  type AgentActivity,
  type Classification,
  type MessageClass,
} from '@littlesheep/types';

export interface Rule {
  pattern: RegExp;
  activity: AgentActivity;
  /** Legacy inspection field; activity is authoritative. */
  type?: MessageClass;
  confidence: number;
  reason: string;
}

const EXPLICIT_TOOL_INSTRUCTION_PATTERN = /(?:(?:(?:请|帮我|麻烦(?:你)?|替我)(?:只|仅)?(?:使用|调用|用)|^(?:只|仅)?(?:使用|调用|用)|(?:第[一二三四五六七八九十百\d]+步|然后|再|随后|接着)\s*(?:请)?(?:只|仅)?(?:使用|调用|用))\s*[A-Za-z][A-Za-z0-9_.-]{0,63}\s*(?:工具|tool\b))|(?:\b(?:please\s+|then\s+|next\s+)?(?:use|call|invoke)\s+(?:the\s+)?[A-Za-z][A-Za-z0-9_.-]{0,63}\s+tool\b)/i;
const EXPLICIT_TOOL_LABEL_PATTERN = /([A-Za-z][A-Za-z0-9_.-]{0,63})\s*(?:工具|tool\b)/giu;
const MEMORY_RECALL_PATTERNS: readonly RegExp[] = [
  /(?:你|还)?(?:记得|记不记得|能否回忆|能不能回忆).{0,32}(?:上次|上一轮|之前|我(?:说|提|让你|告诉)|代号|颜色|名称|名字|版本|路径|预算|时间|日期)/iu,
  /(?:上次|上一轮|之前|我(?:说|提|让你|告诉)).{0,32}(?:是什么|是多少|叫什么|哪一个|哪个|记得吗|还记得)/iu,
  /(?:请|麻烦(?:你)?|帮我)?(?:分别|准确|直接)?(?:回答|说出|列出|告诉我|回忆)(?:[^。！？!?\r\n]{0,64})(?:最初|起初|原先|原来|先前|此前|之前|上次|上一轮|后来|后续)(?:保存|记录|约定|设定|确定|提到|说过|告诉)(?:的|过的)/iu,
  /(?:最初|起初|原先|原来|先前|此前|之前|上次|上一轮|后来|后续)(?:保存|记录|约定|设定|确定|提到|说过|告诉)(?:的|过的)(?:[^。！？!?\r\n]{0,64})(?:是什么|是多少|叫什么|哪一个|哪个|请回答|请说出|请列出|请告诉我)/iu,
  /(?:do\s+you\s+remember|can\s+you\s+recall).{0,48}(?:last|previous|earlier|i\s+(?:said|told|asked)|code|color|name|version|path|budget|time|date)/iu,
  /(?:what|which).{0,24}(?:did\s+i|from\s+(?:the\s+)?(?:last|previous|earlier)).{0,32}(?:say|tell|ask|code|color|name|version|path|budget|time|date)/iu,
  /(?:answer|state|list|tell\s+me|recall).{0,64}(?:initially|originally|previously|earlier|later).{0,24}(?:saved|recorded|agreed|set|specified|mentioned|said)/iu,
];

/** Ordered list of rules. First match wins. */
const RULES: Rule[] = [
  // Greetings → chat (high confidence).
  // NOTE: no \b — it's an ASCII word boundary and misbehaves after CJK chars
  // (e.g. "你好" alone wouldn't match). The ^ anchor + alternation is enough.
  {
    pattern: /^(你好|您好|hi|hello|嗨|hey|哈喽|早上好|下午好|晚上好|在吗|在不在)/i,
    activity: 'respond',
    confidence: 0.9,
    reason: 'greeting',
  },
  // Confirmations / acknowledgements → chat.
  // The agent should understand these from context, not ask the user.
  {
    pattern: /^(对|是的|嗯|好|好的|OK|okay|yes|yeah|没错|对吧|明白|了解|知道|收到|懂了|嗯嗯|行|可以)$/i,
    activity: 'respond',
    confidence: 0.85,
    reason: 'confirmation',
  },
  // Explicit copy/output constraints are still conversation. Words such as
  // "测试" or "校准" describe the content, not a request to run tools.
  {
    pattern: /(?:请|麻烦)?(?:只|仅)(?:回复|回答|输出|返回|说)|\b(?:reply|respond|answer|output|return|say)\s+only\b/i,
    activity: 'respond',
    confidence: 0.98,
    reason: 'direct response constraint',
  },
  // A direct recall question is answerable from the current session Context.
  // It must never become a generic clarification merely because the router
  // model overlooks an available prior-turn anchor.
  {
    pattern: memoryRecallPattern(),
    activity: 'respond',
    confidence: 0.98,
    reason: 'memory recall question',
  },
  // An explicit imperative to use a named tool is unambiguously executable
  // and does not need a separate classifier model call.
  {
    pattern: EXPLICIT_TOOL_INSTRUCTION_PATTERN,
    activity: 'execute',
    confidence: 0.96,
    reason: 'explicit tool instruction',
  },
  // Code blocks → problem
  {
    pattern: /```/,
    activity: 'execute',
    confidence: 0.75,
    reason: 'code block marker',
  },
  // File paths (Unix /xxx or Windows X:\) → problem
  {
    pattern: /(^|\s)(\/[\w.\-]+)+\/|[A-Za-z]:\\/,
    activity: 'execute',
    confidence: 0.75,
    reason: 'file path',
  },
  // Capability/status questions may contain an action word such as "配置" or
  // "实现" without asking the agent to perform that action. Route them as
  // conversation before the broad action-verb rule. Explicit requests still
  // fall through to the problem rule below.
  {
    pattern: /^(?!.*(?:帮我|请你|麻烦你|替我|给我|帮忙))(?=.*(?:是不是|是否|有没有|有没|好像|似乎|看起来|还没|尚未|已经|配置好|实现好|完成了|启用了吗|接入了吗))(?:(?=.*(?:吗|呢|吧|[?？])$)|(?=.*(?:是不是|是否|有没有|有没|好像|似乎|还没|尚未))).+$/i,
    activity: 'respond',
    confidence: 0.9,
    reason: 'capability or status question',
  },
  // Action verbs (Chinese + English) → problem
  {
    pattern: /(帮我|帮我写|写一个|写个|修复|实现|重构|调试|debug|测试|运行|部署|安装|删除|创建|修改|更新|配置|排查|诊断)/i,
    activity: 'execute',
    confidence: 0.8,
    reason: 'action verb',
  },
  // Error/stacktrace keywords → problem
  {
    pattern: /(error|exception|stack trace|报错|错误|失败|崩溃|panic)/i,
    activity: 'execute',
    confidence: 0.75,
    reason: 'error keyword',
  },
  // Pure question (ends with ?) → chat.
  // Questions are conversational — the agent should answer or continue the dialogue,
  // not ask the user "what do you want me to do?"
  {
    pattern: /^[^。.!？！?]*[?？]$/,
    activity: 'respond',
    confidence: 0.7,
    reason: 'question',
  },
];

/** Classify by rules. Returns null if no rule matches (defer to LLM). */
export function classifyByRules(text: string): Classification | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      if (rule.reason === 'explicit tool instruction'
        && extractExplicitToolInstructionNames(trimmed).length === 0) {
        continue;
      }
      return {
        activity: rule.activity,
        type: messageClassFromActivity(rule.activity),
        confidence: rule.confidence,
        source: 'rules',
        reason: rule.reason,
      };
    }
  }
  return null;
}

/** Export rules for testing/inspection. */
export function listRules(): readonly Rule[] {
  return RULES.map((rule) => ({
    ...rule,
    type: messageClassFromActivity(rule.activity),
  }));
}

export function isMemoryRecallRequest(value: string | undefined): boolean {
  const normalized = value?.normalize('NFKC').trim();
  return Boolean(normalized && MEMORY_RECALL_PATTERNS.some((pattern) => pattern.test(normalized)));
}

/** Return every explicitly labelled tool name only for an imperative tool request. */
export function extractExplicitToolInstructionNames(text: string): string[] {
  const normalized = text.normalize('NFKC').trim();
  if (!normalized || !EXPLICIT_TOOL_INSTRUCTION_PATTERN.test(normalized)) return [];
  const names: string[] = [];
  let previousPositiveEnd: number | undefined;
  for (const match of normalized.matchAll(EXPLICIT_TOOL_LABEL_PATTERN)) {
    const index = match.index;
    const positive = isPositiveToolInstructionPrefix(normalized.slice(0, index))
      || (previousPositiveEnd !== undefined
        && isCoordinatedToolContinuation(normalized.slice(previousPositiveEnd, index)));
    if (!positive) {
      previousPositiveEnd = undefined;
      continue;
    }
    names.push(match[1]!.toLowerCase());
    previousPositiveEnd = index + match[0].length;
  }
  return [...new Set(names)];
}

function isPositiveToolInstructionPrefix(prefix: string): boolean {
  return /(?:请|帮我|麻烦(?:你)?|替我)\s*(?:只|仅)?(?:使用|调用|用)\s*$/iu.test(prefix)
    || /(?:第[一二三四五六七八九十百\d]+步|然后|再|随后|接着)\s*(?:请)?(?:只|仅)?(?:使用|调用|用)\s*$/iu.test(prefix)
    || /^(?:只|仅)?(?:使用|调用|用)\s*$/iu.test(prefix)
    || /\bplease\s+(?:use|call|invoke)\s+(?:the\s+)?$/iu.test(prefix)
    || /\b(?:then|next)\s+(?:please\s+)?(?:use|call|invoke)\s+(?:the\s+)?$/iu.test(prefix)
    || /^(?:use|call|invoke)\s+(?:the\s+)?$/iu.test(prefix);
}

function isCoordinatedToolContinuation(value: string): boolean {
  return /^\s*[,;]?\s*(?:(?:and\s+)?then|and|next)\s+(?:(?:use|call|invoke)\s+)?(?:the\s+)?$/iu.test(value)
    || /^\s*[，、；]?\s*(?:和|及|以及|并且|并|然后|再|随后|接着)\s*(?:(?:只|仅)?(?:使用|调用|用)\s*)?$/iu.test(value);
}

function memoryRecallPattern(): RegExp {
  return new RegExp(MEMORY_RECALL_PATTERNS.map((pattern) => `(?:${pattern.source})`).join('|'), 'iu');
}
