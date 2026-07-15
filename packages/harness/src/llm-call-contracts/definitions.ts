import type {
  ContextItemKind,
  LlmCallContract,
  LlmCallPurpose,
  LlmMemoryIntentKind,
  RunContext,
  StageName,
} from '@littlesheep/types';

export interface LlmCallContractTemplate {
  purpose: LlmCallPurpose;
  stage: StageName;
  modelCall: LlmCallContract['modelCall'];
  goal(ctx: RunContext): string;
  allowedContextKinds: readonly ContextItemKind[];
  requiredContextKinds: readonly ContextItemKind[];
  history: LlmCallContract['inputs']['history'];
  attachments: LlmCallContract['inputs']['attachments'];
  allowedDecisions: readonly string[];
  outputSchema: LlmCallContract['outputSchema'];
  memoryIntents: readonly LlmMemoryIntentKind[];
  requiresMemoryEvidence: boolean;
  writableBranches?: readonly string[];
  toolMode: LlmCallContract['toolPolicy']['mode'];
  runtimeApprovalRequired: boolean;
  maxIterations: number;
  maxAttempts: number;
  maxOutputTokens: number;
  temperature?: number;
}

const FULL_INPUTS: readonly ContextItemKind[] = [
  'system_prompt', 'user_input', 'recent_message', 'summary_memory',
  'memory_index', 'memory_fragment', 'project_knowledge', 'tool_result',
  'workflow_state', 'output_constraint', 'attachment_manifest', 'runtime_event',
];
const WORKFLOW_INPUTS: readonly ContextItemKind[] = [
  'system_prompt', 'workflow_state', 'output_constraint', 'tool_result', 'runtime_event',
];
const NO_MEMORY: readonly LlmMemoryIntentKind[] = ['none'];

export const LLM_CALL_CONTRACT_TEMPLATES: Readonly<Record<LlmCallPurpose, LlmCallContractTemplate>> = {
  classify: template({
    purpose: 'classify', stage: 'classify', modelCall: 'optional',
    goal: (ctx) => `Classify the inbound request without choosing workflow transitions: ${inbound(ctx)}`,
    allowedContextKinds: ['system_prompt', 'recent_message', 'user_input', 'attachment_manifest', 'output_constraint'],
    requiredContextKinds: ['system_prompt', 'user_input'], history: 'recent', attachments: 'manifest',
    allowedDecisions: ['chat', 'problem', 'unclear'], outputSchema: json('classification.v1', 'Classification with type, confidence and reason.'),
    memoryIntents: NO_MEMORY, requiresMemoryEvidence: true, toolMode: 'none', runtimeApprovalRequired: false,
    maxIterations: 0, maxAttempts: 1, maxOutputTokens: 256, temperature: 0,
  }),
  decide: template({
    purpose: 'decide', stage: 'decide', modelCall: 'required',
    goal: (ctx) => `Calibrate scope and produce the smallest sufficient TaskBook for: ${goal(ctx)}`,
    allowedContextKinds: FULL_INPUTS.filter((kind) => kind !== 'tool_result'),
    requiredContextKinds: ['system_prompt', 'user_input'], history: 'session', attachments: 'images_and_manifest',
    allowedDecisions: ['needs_clarification', 'lightweight_plan', 'structured_taskbook', 'partial_replan'],
    outputSchema: json('taskbook-decision.v1', 'NeedAssessment, optional ClarificationRequest and TaskBook.'),
    memoryIntents: ['read', 'none'], requiresMemoryEvidence: true, toolMode: 'none', runtimeApprovalRequired: false,
    maxIterations: 0, maxAttempts: 3, maxOutputTokens: 1_800, temperature: 0,
  }),
  execute_tool_loop: template({
    purpose: 'execute_tool_loop', stage: 'execute', modelCall: 'required',
    goal: (ctx) => `Complete the active TaskBook step while preserving runtime control: ${activeStep(ctx)}`,
    allowedContextKinds: FULL_INPUTS, requiredContextKinds: ['system_prompt', 'user_input'],
    history: 'session', attachments: 'images_and_manifest',
    allowedDecisions: ['return_step_result', 'propose_registered_tool_call'],
    outputSchema: text('execute-step-result.v1', 'Concise step result or provider-native tool call proposal.'),
    memoryIntents: ['read', 'none'], requiresMemoryEvidence: true, toolMode: 'step_scoped', runtimeApprovalRequired: true,
    maxIterations: 20, maxAttempts: 20, maxOutputTokens: 4_096, temperature: 0,
  }),
  execute_final_reply: template({
    purpose: 'execute_final_reply', stage: 'execute', modelCall: 'optional',
    goal: (ctx) => `Assemble a proportional final reply from verified step evidence for: ${goal(ctx)}`,
    allowedContextKinds: WORKFLOW_INPUTS, requiredContextKinds: ['system_prompt', 'workflow_state'],
    history: 'none', attachments: 'none', allowedDecisions: ['compose_final_reply'],
    outputSchema: text('final-reply.v1', 'User-facing answer with progressive disclosure and explicit failures.'),
    memoryIntents: NO_MEMORY, requiresMemoryEvidence: true, toolMode: 'none', runtimeApprovalRequired: false,
    maxIterations: 0, maxAttempts: 1, maxOutputTokens: 900, temperature: 0,
  }),
  recover: template({
    purpose: 'recover', stage: 'recover', modelCall: 'optional',
    goal: (ctx) => `Choose a bounded recovery action for: ${ctx.lastError?.message ?? 'unknown failure'}`,
    allowedContextKinds: ['system_prompt', 'recent_message', 'workflow_state', 'output_constraint'],
    requiredContextKinds: ['system_prompt', 'workflow_state'], history: 'recent', attachments: 'none',
    allowedDecisions: ['retry', 'escalate', 'abort'], outputSchema: json('recovery-decision.v1', 'Bounded recovery action and optional revised legacy plan.'),
    memoryIntents: ['read', 'conflict', 'none'], requiresMemoryEvidence: true, toolMode: 'none', runtimeApprovalRequired: false,
    maxIterations: 0, maxAttempts: 3, maxOutputTokens: 800, temperature: 0,
  }),
  verify: template({
    purpose: 'verify', stage: 'verify', modelCall: 'required',
    goal: (ctx) => `Judge the recorded evidence against the calibrated success criteria for: ${goal(ctx)}`,
    allowedContextKinds: WORKFLOW_INPUTS, requiredContextKinds: ['system_prompt', 'workflow_state'],
    history: 'none', attachments: 'none', allowedDecisions: ['pass', 'needs_replan', 'fail'],
    outputSchema: json('verification-verdict.v1', 'Verdict, reason, feedback and exact failed step ids.'),
    memoryIntents: ['conflict', 'none'], requiresMemoryEvidence: true, toolMode: 'none', runtimeApprovalRequired: false,
    maxIterations: 0, maxAttempts: 2, maxOutputTokens: 500, temperature: 0,
  }),
  evolve: template({
    purpose: 'evolve', stage: 'evolve', modelCall: 'optional',
    goal: (ctx) => `Propose only durable, evidenced improvements from the verified run: ${goal(ctx)}`,
    allowedContextKinds: WORKFLOW_INPUTS, requiredContextKinds: ['system_prompt', 'workflow_state'],
    history: 'none', attachments: 'none', allowedDecisions: ['propose_memory_intents', 'propose_skill', 'none'],
    outputSchema: json('evolution-proposal.v1', 'Structured memory intents and an optional reusable Skill proposal.'),
    memoryIntents: ['write', 'merge', 'invalidate', 'conflict', 'none'], requiresMemoryEvidence: true,
    writableBranches: ['long-term', 'project', 'experience'], toolMode: 'none', runtimeApprovalRequired: false,
    maxIterations: 0, maxAttempts: 2, maxOutputTokens: 2_400, temperature: 0,
  }),
  capture: template({
    purpose: 'capture', stage: 'capture', modelCall: 'optional',
    goal: (ctx) => `Capture bounded factual run events for later reconstruction: ${goal(ctx)}`,
    allowedContextKinds: WORKFLOW_INPUTS, requiredContextKinds: ['system_prompt', 'workflow_state'],
    history: 'none', attachments: 'none', allowedDecisions: ['propose_daily_write', 'none'],
    outputSchema: json('daily-capture.v1', 'Structured factual daily observations.'),
    memoryIntents: ['write', 'none'], requiresMemoryEvidence: true, writableBranches: ['daily'],
    toolMode: 'none', runtimeApprovalRequired: false, maxIterations: 0, maxAttempts: 2, maxOutputTokens: 900, temperature: 0,
  }),
  reply: template({
    purpose: 'reply', stage: 'reply', modelCall: 'required',
    goal: (ctx) => `Answer the conversational request directly and proportionally: ${inbound(ctx)}`,
    allowedContextKinds: FULL_INPUTS.filter((kind) => kind !== 'tool_result'),
    requiredContextKinds: ['system_prompt', 'user_input'], history: 'session', attachments: 'images_and_manifest',
    allowedDecisions: ['respond'], outputSchema: text('chat-reply.v1', 'Direct user-facing conversational response.'),
    memoryIntents: ['read', 'none'], requiresMemoryEvidence: true, toolMode: 'none', runtimeApprovalRequired: false,
    maxIterations: 0, maxAttempts: 1, maxOutputTokens: 4_096, temperature: 0.7,
  }),
  finalize: template({
    purpose: 'finalize', stage: 'finalize', modelCall: 'forbidden',
    goal: () => 'Persist the already assembled reply and execution evidence without another model call.',
    allowedContextKinds: [], requiredContextKinds: [], history: 'none', attachments: 'none',
    allowedDecisions: ['persist_existing_result'], outputSchema: none('finalize.no-model.v1', 'No model output is permitted.'),
    memoryIntents: NO_MEMORY, requiresMemoryEvidence: true, toolMode: 'none', runtimeApprovalRequired: false,
    maxIterations: 0, maxAttempts: 0, maxOutputTokens: 0,
  }),
  session_compaction: template({
    purpose: 'session_compaction', stage: 'capture', modelCall: 'optional',
    goal: () => 'Merge older transcript evidence into a versioned, non-destructive session summary.',
    allowedContextKinds: ['system_prompt', 'summary_memory', 'workflow_state', 'output_constraint'],
    requiredContextKinds: ['system_prompt', 'workflow_state'], history: 'none', attachments: 'none',
    allowedDecisions: ['produce_summary'], outputSchema: text('session-summary.v1', 'Traceable summary preserving goals, constraints, decisions and unfinished work.'),
    memoryIntents: NO_MEMORY, requiresMemoryEvidence: true, toolMode: 'none', runtimeApprovalRequired: false,
    maxIterations: 0, maxAttempts: 1, maxOutputTokens: 1_400, temperature: 0,
  }),
};

function template(value: LlmCallContractTemplate): LlmCallContractTemplate {
  return value;
}

function json(schemaId: string, description: string): LlmCallContract['outputSchema'] {
  return { kind: 'json', schemaId, strict: true, description };
}

function text(schemaId: string, description: string): LlmCallContract['outputSchema'] {
  return { kind: 'text', schemaId, strict: false, description };
}

function none(schemaId: string, description: string): LlmCallContract['outputSchema'] {
  return { kind: 'none', schemaId, strict: true, description };
}

function inbound(ctx: RunContext): string {
  const value = ctx.inbound.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
  return (value || '(empty request)').slice(0, 320);
}

function goal(ctx: RunContext): string {
  return (ctx.taskBook?.goal ?? ctx.needAssessment?.goal ?? inbound(ctx)).slice(0, 400);
}

function activeStep(ctx: RunContext): string {
  const active = ctx.taskBook?.steps.find((step) => step.status === 'in_progress');
  return (active?.description ?? goal(ctx)).slice(0, 400);
}
