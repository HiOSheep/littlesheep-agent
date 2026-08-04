import { isMemoryRecallRequest } from '@littlesheep/classifier';

const EXECUTION_CONTINUATION_PATTERNS: readonly RegExp[] = [
  /(?:^|[，,。；;！？!?]\s*)(?:继续|接着)(?:执行|处理|完成|刚才|上次|上一轮|之前|未完成|这个任务|那件事|吧|下去|做)?(?:[，,。；;！？!?]|$)/iu,
  /恢复(?:执行|处理|刚才|上次|上一轮|之前|未完成|这个任务|那件事)/iu,
  /(?:刚才|上一轮|上次|之前(?:那次)?|当前(?:任务|执行)|这个任务|那件事).{0,24}(?:进度|状态|结果|耗时|用时|多久|执行到哪|完成|成功|失败|报错|错误|恢复)/iu,
  /(?:^|[，,。；;！？!?\s])(?:请(?:查看|看|告诉我)?|查看|检查)?(?:截至)?(?:目前|现在)(?:的|这个|该)?(?:任务|工作|执行|运行|操作)?.{0,16}(?:进度|状态|结果|耗时|用时|多久|执行到哪|完成|成功|失败|报错|错误|恢复)/iu,
  /(?:任务|工作|执行)(?:进度|状态|结果|完成情况|执行情况|恢复情况|耗时|用时)(?:如何|怎么样|到哪(?:了)?|是多少|呢|了|吗|没|$)/iu,
  /(?:完成|成功|失败|恢复)(?:了吗|了没|没有|没|情况|进度|与否)/iu,
  /(?:报错|错误)(?:原因|情况|是什么|了吗|了没)/iu,
  /(?:^|[,;.!?]\s*)(?:continue|resume|carry\s+on|pick\s+up)(?:\s+(?:(?:the|that|this)\s+)?(?:previous|last|unfinished|current)?\s*(?:run|task|work|operation))?(?:[,;.!?]|$)/iu,
  /(?:previous|last|current|this|that)\s+(?:run|task|work|operation|attempt).{0,32}(?:progress|status|result|elapsed|duration|finish|succeed|fail|error|recover)/iu,
  /(?:progress|status|result|elapsed|duration)\s+(?:of|for)\s+(?:the\s+)?(?:previous|last|current|this|that)?\s*(?:run|task|work|operation|attempt)/iu,
  /how\s+(?:far|long).{0,24}(?:run|task|work|operation|it|that)/iu,
  /did\s+(?:it|that).{0,16}(?:work|finish|succeed|fail)/iu,
];

export function isExplicitContinuationRequest(value: string | undefined): boolean {
  const normalized = value?.trim();
  return Boolean(normalized && (
    isExecutionContinuationRequest(normalized)
    || isMemoryRecallRequest(normalized)
  ));
}

export function isExecutionContinuationRequest(value: string | undefined): boolean {
  const normalized = value?.trim();
  return Boolean(normalized && EXECUTION_CONTINUATION_PATTERNS.some((pattern) => pattern.test(normalized)));
}
