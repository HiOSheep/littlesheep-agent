const EXECUTION_CONTINUATION_PATTERNS: readonly RegExp[] = [
  /(?:^|[，。！？!?]\s*)(?:继续|接着)(?:执行|处理|完成|刚才|上次|上一轮|之前|未完成|这个任务|那件事|吧|下去|做)?(?:[。！？!?]|$)/iu,
  /恢复(?:执行|处理|刚才|上次|上一轮|之前|未完成|这个任务|那件事)/iu,
  /(?:刚才|上一轮|上次|之前(?:那次)?|目前|现在|当前(?:任务|执行)|这个任务|那件事).{0,24}(?:进度|状态|结果|耗时|用时|多久|执行到哪|完成|成功|失败|报错|错误|恢复)/iu,
  /(?:任务|工作|执行)(?:进度|状态|结果|完成情况|执行情况|恢复情况|耗时|用时)(?:如何|怎么样|到哪(?:了)?|是多少|呢|了|吗|没|$)/iu,
  /(?:完成|成功|失败|恢复)(?:了吗|了没|没有|没|情况|进度|与否)/iu,
  /(?:报错|错误)(?:原因|情况|是什么|了吗|了没)/iu,
  /(?:^|[.!?]\s*)(?:continue|resume|carry\s+on|pick\s+up)(?:\s+(?:(?:the|that|this)\s+)?(?:previous|last|unfinished|current)?\s*(?:run|task|work|operation))?(?:[.!?]|$)/iu,
  /(?:previous|last|current|this|that)\s+(?:run|task|work|operation|attempt).{0,32}(?:progress|status|result|elapsed|duration|finish|succeed|fail|error|recover)/iu,
  /(?:progress|status|result|elapsed|duration)\s+(?:of|for)\s+(?:the\s+)?(?:previous|last|current|this|that)?\s*(?:run|task|work|operation|attempt)/iu,
  /how\s+(?:far|long).{0,24}(?:run|task|work|operation|it|that)/iu,
  /did\s+(?:it|that).{0,16}(?:work|finish|succeed|fail)/iu,
];

const MEMORY_RECALL_PATTERNS: readonly RegExp[] = [
  /(?:你|还)?(?:记得|记不记得|能否回忆|能不能回忆).{0,32}(?:上次|上一轮|之前|我(?:说|提|让你|告诉)|代号|颜色|名称|名字|版本|路径|预算|时间|日期)/iu,
  /(?:上次|上一轮|之前|我(?:说|提|让你|告诉)).{0,32}(?:是什么|是多少|叫什么|哪一个|哪个|记得吗|还记得)/iu,
  /(?:do\s+you\s+remember|can\s+you\s+recall).{0,48}(?:last|previous|earlier|i\s+(?:said|told|asked)|code|color|name|version|path|budget|time|date)/iu,
  /(?:what|which).{0,24}(?:did\s+i|from\s+(?:the\s+)?(?:last|previous|earlier)).{0,32}(?:say|tell|ask|code|color|name|version|path|budget|time|date)/iu,
];

export function isExplicitContinuationRequest(value: string | undefined): boolean {
  const normalized = value?.trim();
  return Boolean(normalized && (
    isExecutionContinuationRequest(normalized)
    || MEMORY_RECALL_PATTERNS.some((pattern) => pattern.test(normalized))
  ));
}

export function isExecutionContinuationRequest(value: string | undefined): boolean {
  const normalized = value?.trim();
  return Boolean(normalized && EXECUTION_CONTINUATION_PATTERNS.some((pattern) => pattern.test(normalized)));
}
