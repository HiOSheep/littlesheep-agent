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

const EXPLICIT_TOOL_INSTRUCTION_PATTERN = /(?:(?:(?:请|帮我|麻烦(?:你)?|替我)(?:使用|调用|用)|^(?:使用|调用|用))\s*[A-Za-z][A-Za-z0-9_.-]{0,63}\s*(?:工具|tool\b))|(?:\b(?:please\s+)?(?:use|call|invoke)\s+(?:the\s+)?[A-Za-z][A-Za-z0-9_.-]{0,63}\s+tool\b)/i;

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

/** Return every explicitly labelled tool name only for an imperative tool request. */
export function extractExplicitToolInstructionNames(text: string): string[] {
  const normalized = text.normalize('NFKC').trim();
  if (!normalized || !EXPLICIT_TOOL_INSTRUCTION_PATTERN.test(normalized)) return [];
  const names = [...normalized.matchAll(/([A-Za-z][A-Za-z0-9_.-]{0,63})\s*(?:工具|tool\b)/giu)]
    .map((match) => match[1]!.toLowerCase());
  return [...new Set(names)];
}
