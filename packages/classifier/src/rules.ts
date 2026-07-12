// @littlesheep/classifier — rules.ts
// Rule-based fast path classifier. <1ms. Returns null when no rule matches.

import type { Classification, MessageClass } from '@littlesheep/types';

export interface Rule {
  pattern: RegExp;
  type: MessageClass;
  confidence: number;
  reason: string;
}

/** Ordered list of rules. First match wins. */
const RULES: Rule[] = [
  // Greetings → chat (high confidence).
  // NOTE: no \b — it's an ASCII word boundary and misbehaves after CJK chars
  // (e.g. "你好" alone wouldn't match). The ^ anchor + alternation is enough.
  {
    pattern: /^(你好|您好|hi|hello|嗨|hey|哈喽|早上好|下午好|晚上好|在吗|在不在)/i,
    type: 'chat',
    confidence: 0.9,
    reason: 'greeting',
  },
  // Confirmations / acknowledgements → chat.
  // The agent should understand these from context, not ask the user.
  {
    pattern: /^(对|是的|嗯|好|好的|OK|okay|yes|yeah|没错|对吧|明白|了解|知道|收到|懂了|嗯嗯|行|可以)$/i,
    type: 'chat',
    confidence: 0.85,
    reason: 'confirmation',
  },
  // Code blocks → problem
  {
    pattern: /```/,
    type: 'problem',
    confidence: 0.75,
    reason: 'code block marker',
  },
  // File paths (Unix /xxx or Windows X:\) → problem
  {
    pattern: /(^|\s)(\/[\w.\-]+)+\/|[A-Za-z]:\\/,
    type: 'problem',
    confidence: 0.75,
    reason: 'file path',
  },
  // Action verbs (Chinese + English) → problem
  {
    pattern: /(帮我|帮我写|写一个|写个|修复|实现|重构|调试|debug|测试|运行|部署|安装|删除|创建|修改|更新|配置|排查|诊断)/i,
    type: 'problem',
    confidence: 0.8,
    reason: 'action verb',
  },
  // Error/stacktrace keywords → problem
  {
    pattern: /(error|exception|stack trace|报错|错误|失败|崩溃|panic)/i,
    type: 'problem',
    confidence: 0.75,
    reason: 'error keyword',
  },
  // Pure question (ends with ?) → chat.
  // Questions are conversational — the agent should answer or continue the dialogue,
  // not ask the user "what do you want me to do?"
  {
    pattern: /^[^。.!？！?]*[?？]$/,
    type: 'chat',
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
        type: rule.type,
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
  return RULES;
}
