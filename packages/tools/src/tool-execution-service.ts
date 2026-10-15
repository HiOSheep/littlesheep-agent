// Facade for the complete hosted tool-invocation lifecycle.

import { randomUUID } from 'node:crypto';
import type {
  AgentTool,
  TaskStepSideEffect,
  ToolContext,
  ToolInvocationRecord,
  ToolInvocationStatus,
  ToolRegistration,
  ToolResourceAccess,
  ToolResult,
  ToolStreamEvent,
} from '@littlesheep/types';
import { describeToolAccess, resolvePermissionDecision } from '@littlesheep/safety';
import { inspectWorkspaceFilePath } from './workspace-file-guard.js';
import { markNativeWorkspaceFileInvocation } from './native-workspace-file-invocation.js';
import { attachShellInvocation } from './shell-authorization.js';
import { prepareShellToolBatch } from './shell-tool-batch.js';
import { DEFAULT_SANITIZE, type SanitizeOptions } from './sanitize.js';
import {
  executeToolWaves,
  toolResourceAccessCovered,
  type ScheduledToolExecution,
} from './tool-execution-scheduler.js';
import { ToolControlError, invokeWithTimeout, waitForAbort } from './tool-execution-control.js';
import {
  boundedError,
  boundedInteger,
  boundedText,
  errorMessage,
  hashToolInput,
  summarizeToolInput,
} from './tool-execution-records.js';
import {
  invocationOutcomeForResult,
  projectToolInput,
  resolveToolExecutionPolicy,
  sanitizeToolResult,
  stampToolStep,
} from './tool-execution-result.js';

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_REPEATED_TOOL_CALLS = 3;
export const DEFAULT_MAX_TOOL_INVOCATION_RECORDS = 256;

const MAX_REPEAT_KEYS = 1_024;

export interface ToolInvocationRequest {
  callId: string;
  name: string;
  input: unknown;
  stepId?: string;
  /** Branch-local cancellation while the owning run signal remains authoritative. */
  signal?: AbortSignal;
  /** Present only when a Runtime-approved parallel TaskBook branch owns the call. */
  parallelStep?: {
    sideEffect: TaskStepSideEffect;
    resources: readonly ToolResourceAccess[];
  };
}

export interface ToolExecutionLifecycleContext {
  request: ToolInvocationRequest;
  tool: AgentTool;
  toolSource: string;
  input: unknown;
  resources: readonly ToolResourceAccess[];
}

export interface ToolExecutionLifecycleResult {
  result: ToolResult;
  status?: ToolInvocationStatus;
  errorKind?: string;
}

/** What the service knows that a raw `ToolResult` cannot: whether a failure was determinate (`failed`) or cut short (`timed_out`, `aborted`). */
export interface ToolInvocationOutcomeInfo {
  status?: ToolInvocationStatus;
  errorKind?: string;
}

export interface ToolExecutionLifecycle {
  beforeInvoke?(context: ToolExecutionLifecycleContext): Promise<ToolExecutionLifecycleResult | void>;
  afterInvoke?(
    context: ToolExecutionLifecycleContext,
    result: ToolResult,
    outcome?: ToolInvocationOutcomeInfo,
  ): Promise<ToolExecutionLifecycleResult | ToolResult>;
}

export interface ToolExecutionServiceOptions {
  registrations: readonly ToolRegistration[];
  toolContext: ToolContext;
  maxParallel?: number;
  maxRepeat?: number;
  timeoutMs?: number;
  maxRecords?: number;
  sanitize?: SanitizeOptions;
  onToolEvent?: (event: ToolStreamEvent) => void;
  onRecord?: (
    record: ToolInvocationRecord,
    state: { retained: boolean; truncated: boolean },
  ) => void;
  now?: () => Date;
  idFactory?: () => string;
}

interface PreparedInvocation {
  index: number;
  request: ToolInvocationRequest;
  registration: ToolRegistration;
  input: unknown;
  record: ToolInvocationRecord;
  retained: boolean;
  approvalGranted: boolean;
  shellGrant?: object;
  concurrency: 'parallel' | 'exclusive';
  resources: readonly ToolResourceAccess[];
}

interface InvocationOutcome {
  result: ToolResult;
  status?: ToolInvocationStatus;
  errorKind?: string;
}

/**
 * The single host boundary for tool lookup, validation, approval, scheduling,
 * execution, output sanitation, events, and structured invocation evidence.
 */
export class ToolExecutionService {
  private readonly registrations = new Map<string, ToolRegistration>();
  private readonly repeatCounts = new Map<string, number>();
  private readonly records: ToolInvocationRecord[] = [];
  private readonly options: Required<Pick<
    ToolExecutionServiceOptions,
    'maxParallel' | 'maxRepeat' | 'timeoutMs' | 'maxRecords' | 'sanitize'
  >> & ToolExecutionServiceOptions;
  private approvalQueue: Promise<void> = Promise.resolve();
  private recordsTruncated = false;

  constructor(options: ToolExecutionServiceOptions) {
    this.options = {
      ...options,
      maxParallel: boundedInteger(options.maxParallel, 1, 8, 4),
      maxRepeat: boundedInteger(options.maxRepeat, 1, 20, DEFAULT_MAX_REPEATED_TOOL_CALLS),
      timeoutMs: boundedInteger(options.timeoutMs, 1, 24 * 60 * 60_000, DEFAULT_TOOL_TIMEOUT_MS),
      maxRecords: boundedInteger(options.maxRecords, 1, 4_096, DEFAULT_MAX_TOOL_INVOCATION_RECORDS),
      sanitize: options.sanitize ?? DEFAULT_SANITIZE,
    };
    for (const registration of options.registrations) {
      if (this.registrations.has(registration.tool.name)) {
        throw new Error(`tools: tool "${registration.tool.name}" is registered more than once for this run`);
      }
      this.registrations.set(registration.tool.name, registration);
    }
  }

  async executeBatch(
    requests: readonly ToolInvocationRequest[],
    lifecycle?: ToolExecutionLifecycle,
    allowedToolNames?: ReadonlySet<string>,
    maxParallel?: number,
  ): Promise<Map<number, ToolResult>> {
    const immediate = new Map<number, ToolResult>();
    const prepared: PreparedInvocation[] = [];
    // Snapshot request identities before the batch can suspend on an approval.
    const batchRequests = requests.map((request) => ({ ...request }));
    const { inputs: shellInputs, batch: shellBatch } = await prepareShellToolBatch({
      requests: batchRequests, registrations: this.registrations, context: this.options.toolContext,
      timeoutMs: this.options.timeoutMs, allowedToolNames,
      serialize: (task) => this.withApprovalLock(this.options.toolContext.signal, task),
    });

    try {
    for (const [index, request] of batchRequests.entries()) {
      const registration = this.registrations.get(request.name);
      const auditInput = registration
        ? projectToolInput(registration.tool, request.input)
        : { projection: 'unavailable' };
      const record = this.createRecord(request, auditInput);
      const retained = this.retainRecord(record);
      if (!registration) {
        record.resolvedAt = this.timestamp();
        this.publishRecord(record, retained);
        immediate.set(index, this.finishWithoutExecution(
          record,
          retained,
          request,
          'unknown_tool',
          `unknown tool: ${request.name}`,
          'unknown_tool',
        ));
        continue;
      }
      record.resolvedAt = this.timestamp();
      record.toolSource = registration.source;
      this.publishRecord(record, retained);
      if (allowedToolNames && !allowedToolNames.has(request.name)) {
        immediate.set(index, this.finishWithoutExecution(
          record,
          retained,
          request,
          'validation_failed',
          `tool is registered but not admitted for the current request: ${request.name}`,
          'step_tool_not_allowed',
        ));
        continue;
      }

      let input: unknown;
      try {
        input = shellInputs.get(index) ?? registration.tool.inputSchema.parse(request.input);
        record.validatedAt = this.timestamp();
        this.publishRecord(record, retained);
      } catch (error) {
        immediate.set(index, this.finishWithoutExecution(
          record,
          retained,
          request,
          'validation_failed',
          `tool input validation failed: ${errorMessage(error)}`,
          'input_validation',
        ));
        continue;
      }

      const policy = resolveToolExecutionPolicy(registration.tool, input, this.options.toolContext);
      record.resourceKeys = [...new Set(policy.resources.map((resource) => `${resource.mode}:${resource.key}`))].sort();
      this.publishRecord(record, retained);
      const parallelContractError = validateParallelStepContract(request, policy);
      if (parallelContractError) {
        immediate.set(index, this.finishWithoutExecution(
          record,
          retained,
          request,
          'validation_failed',
          parallelContractError,
          'parallel_step_contract',
        ));
        continue;
      }

      const descriptor = describeToolAccess(registration.tool.name, input, this.options.toolContext);
      const shellGrant = shellBatch.grants.get(index);
      const shellError = shellBatch.failures.get(index);
      const shellFailure = shellError;
      const approval = request.name === 'exec'
        ? shellGrant
          ? { ok: true as const, granted: true }
          : { ok: false as const, status: shellFailure?.status ?? 'hard_denied' as const,
              error: shellFailure?.message ?? 'Shell authorization unavailable: untrusted executor',
              errorKind: shellFailure?.errorKind ?? 'shell_authorization_invalid' }
        : await this.approve(registration, input, descriptor, record, retained, request.signal);
      if (request.name === 'exec') {
        record.approval = { required: true, decision: approval.ok ? 'approved'
          : shellFailure?.status === 'hard_denied' || !shellFailure ? 'blocked'
            : shellFailure?.status === 'approval_denied' || shellFailure?.status === 'aborted' ? 'denied' : 'unavailable',
          decidedAt: this.timestamp(), ...(shellFailure ? { reason: shellFailure.message } : {}) };
        this.publishRecord(record, retained);
      }
      if (!approval.ok) {
        immediate.set(index, this.finishWithoutExecution(
          record,
          retained,
          request,
          approval.status,
          approval.error,
          approval.errorKind,
        ));
        continue;
      }

      const repeatKey = `${request.name}:${hashToolInput(input)}`;
      const repeatCount = this.incrementRepeat(repeatKey);
      if (repeatCount > this.options.maxRepeat) {
        immediate.set(index, this.finishWithoutExecution(
          record,
          retained,
          request,
          'repeated_call_blocked',
          `repeated identical call (${repeatCount}x) - refusing to re-execute; try different arguments or stop`,
          'repeated_call',
        ));
        continue;
      }

      prepared.push({
        index,
        request,
        registration,
        input,
        record,
        retained,
        approvalGranted: approval.granted,
        shellGrant,
        ...policy,
      });
    }

    const scheduled: ScheduledToolExecution<ToolResult>[] = prepared.map((invocation) => ({
      index: invocation.index,
      concurrency: invocation.concurrency,
      resources: invocation.resources,
      execute: () => this.executePrepared(invocation, lifecycle),
    }));
    const completed = await executeToolWaves(
      scheduled,
      Math.min(this.options.maxParallel, boundedInteger(maxParallel, 1, 8, this.options.maxParallel)),
    );
    return new Map([...immediate, ...completed]);
    } finally { shellBatch.close(); }
  }

  snapshot(): { records: ToolInvocationRecord[]; truncated: boolean } {
    return {
      records: this.records.map((record) => structuredClone(record)),
      truncated: this.recordsTruncated,
    };
  }

  private createRecord(request: ToolInvocationRequest, auditInput: unknown): ToolInvocationRecord {
    const id = this.options.idFactory?.() ?? randomUUID();
    return {
      version: 1,
      id: `${this.options.toolContext.runId}:tool:${id}`,
      callId: request.callId,
      runId: this.options.toolContext.runId,
      sessionId: this.options.toolContext.sessionId,
      stepId: request.stepId,
      toolName: request.name,
      toolSource: 'unknown',
      status: 'proposed',
      proposedAt: this.timestamp(),
      inputHash: hashToolInput(auditInput),
      inputSummary: summarizeToolInput(auditInput),
      approval: { required: 'unknown', decision: 'unknown' },
      evidenceIds: [`${this.options.toolContext.runId}:evidence:tool:${id}`],
    };
  }

  private retainRecord(record: ToolInvocationRecord): boolean {
    if (this.records.length >= this.options.maxRecords) {
      this.recordsTruncated = true;
      this.publishRecord(record, false);
      return false;
    }
    this.records.push(record);
    this.publishRecord(record, true);
    return true;
  }

  private publishRecord(record: ToolInvocationRecord, retained: boolean): void {
    try {
      this.options.onRecord?.(structuredClone(record), {
        retained,
        truncated: this.recordsTruncated,
      });
    } catch (error) {
      this.options.toolContext.log?.('warn', 'tool invocation record observer failed', boundedError(error));
    }
  }

  private async approve(
    registration: ToolRegistration,
    input: unknown,
    descriptor: ReturnType<typeof describeToolAccess>,
    record: ToolInvocationRecord,
    retained: boolean,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; granted: boolean }
    | { ok: false; status: 'hard_denied' | 'approval_denied' | 'approval_unavailable' | 'aborted'; error: string; errorKind: string }
  > {
    const tool = registration.tool
    if (descriptor.hardDecision === 'deny') {
      record.approval.required = false;
      record.approval.decision = 'blocked';
      record.approval.decidedAt = this.timestamp();
      record.approval.reason = descriptor.reason;
      this.publishRecord(record, retained);
      return {
        ok: false,
        status: 'hard_denied',
        error: `tool execution blocked by runtime safety policy: ${descriptor.reason}`,
        errorKind: 'hard_deny',
      };
    }
    if (descriptor.hardDecision === 'unavailable') {
      record.approval.required = false;
      record.approval.decision = 'blocked';
      record.approval.decidedAt = this.timestamp();
      record.approval.reason = descriptor.reason;
      this.publishRecord(record, retained);
      return {
        ok: false,
        status: 'hard_denied',
        error: `tool execution cannot proceed because required safety enforcement is unavailable: ${descriptor.reason}`,
        errorKind: 'permission_safety_unavailable',
      };
    }
    const mode = this.options.toolContext.permissionMode;
    const snapshot = this.options.toolContext.permissionPolicyV2;
    const selectedPolicy = snapshot?.preset ?? this.options.toolContext.permissionPreset ?? mode;
    const isNativeWorkspaceFileTool = registration.source === 'builtin'
      && (tool.name === 'read' || tool.name === 'write' || tool.name === 'edit');
    const filePath = typeof input === 'object' && input !== null && 'file_path' in input
      && typeof (input as { file_path?: unknown }).file_path === 'string'
      ? (input as { file_path: string }).file_path
      : undefined;
    if (snapshot && isNativeWorkspaceFileTool && filePath !== undefined) {
      const pathGuard = await inspectWorkspaceFilePath(
        filePath,
        this.options.toolContext,
        tool.name === 'read' ? 'read' : 'write',
      );
      // An unsafe alias that purports to be inside the authorized workspace
      // cannot be approved by the displayed lexical path. Outside absolute
      // paths remain eligible for the ordinary per-call approval flow.
      if (pathGuard.attemptedWorkspace && !pathGuard.safe) {
        record.approval.required = false;
        record.approval.decision = 'blocked';
        record.approval.decidedAt = this.timestamp();
        record.approval.reason = pathGuard.reason ?? 'workspace path identity could not be verified';
        this.publishRecord(record, retained);
        return {
          ok: false,
          status: 'hard_denied',
          error: `native file operation blocked because the workspace path could not be verified: ${record.approval.reason}`,
          errorKind: 'permission_safety_unavailable',
        };
      }
    }
    const resolvedDecision = selectedPolicy
      ? resolvePermissionDecision(selectedPolicy, descriptor, {
          strictReadApproval: this.options.toolContext.networkPolicy?.strictReadApproval === true,
          approvalPolicy: snapshot?.approvalPolicy ?? this.options.toolContext.approvalPolicy,
          workspaceFileWrites: snapshot?.constraints.workspaceFileWrites ?? this.options.toolContext.workspaceFileWrites,
          shellIsolation: snapshot?.constraints.shellIsolation ?? this.options.toolContext.shellIsolation,
          fullAccessConfirmed: snapshot?.fullAccessConfirmed ?? this.options.toolContext.fullAccessConfirmed,
        })
      : descriptor.hardDecision === 'approval' || tool.requiresApproval === true
        ? 'approval'
        : 'allow';
    // workspace-write's native auto-write capability belongs only to the
    // guarded builtin write/edit implementations. Plugin and document tools
    // keep using this same service but remain explicitly approvable.
    const isNativeWorkspaceFileWriter = registration.source === 'builtin'
      && (tool.name === 'write' || tool.name === 'edit');
    const isNativeWorkspaceFileReader = registration.source === 'builtin' && tool.name === 'read';
    const guardedNativeWorkspaceFileWriter = selectedPolicy === 'workspace-write'
      && isNativeWorkspaceFileWriter
      && descriptor.action === 'write'
      && descriptor.resourceScope === 'workspace'
      && filePath !== undefined
      && (await inspectWorkspaceFilePath(filePath, this.options.toolContext, 'write')).safe
    const guardedNativeWorkspaceFileReader = (selectedPolicy === 'workspace-write' || selectedPolicy === 'read-only')
      && isNativeWorkspaceFileReader
      && descriptor.action === 'read'
      && descriptor.resourceScope === 'workspace'
      && filePath !== undefined
      && (await inspectWorkspaceFilePath(filePath, this.options.toolContext, 'read')).safe
    const requiresNativeFileConstraint = (selectedPolicy === 'workspace-write'
      && descriptor.action === 'write'
      && descriptor.resourceScope === 'workspace'
      && !guardedNativeWorkspaceFileWriter)
      || ((selectedPolicy === 'workspace-write' || selectedPolicy === 'read-only')
          && descriptor.action === 'read'
          && descriptor.resourceScope === 'workspace'
          && !guardedNativeWorkspaceFileReader)
    const decision = requiresNativeFileConstraint && resolvedDecision === 'allow'
      ? snapshot?.approvalPolicy === 'deny' || this.options.toolContext.approvalPolicy === 'deny'
        ? 'deny'
        : 'approval'
      : resolvedDecision
    if (decision === 'deny' || decision === 'unavailable') {
      record.approval.required = false;
      record.approval.decision = 'blocked';
      record.approval.decidedAt = this.timestamp();
      record.approval.reason = decision === 'unavailable'
        ? 'required permission enforcement is unavailable'
        : descriptor.reason;
      this.publishRecord(record, retained);
      return {
        ok: false,
        status: 'hard_denied',
        error: decision === 'unavailable'
          ? 'tool execution cannot proceed because required safety enforcement is unavailable'
          : `tool execution blocked by runtime safety policy: ${descriptor.reason}`,
        errorKind: decision === 'unavailable' ? 'permission_safety_unavailable' : 'hard_deny',
      };
    }
    const required = decision === 'approval';
    record.approval.required = required;
    if (!required) {
      record.approval.decision = 'not_required';
      record.approval.decidedAt = this.timestamp();
      this.publishRecord(record, retained);
      return { ok: true, granted: false };
    }

    const approve = this.options.toolContext.approve;
    if (!approve) {
      record.approval.decision = 'unavailable';
      record.approval.decidedAt = this.timestamp();
      record.approval.reason = 'approval callback is unavailable';
      this.publishRecord(record, retained);
      return {
        ok: false,
        status: 'approval_unavailable',
        error: 'approval unavailable',
        errorKind: 'approval_unavailable',
      };
    }
    try {
      const approvalSignal = signal ?? this.options.toolContext.signal;
      this.emitToolEvent({
        type: 'runtime_activity',
        visibility: 'progress',
        phaseId: `tool-approval:${record.callId}`,
        activityKind: 'runtime_waiting_approval',
        activityStatus: 'running',
        callId: record.callId,
        name: tool.name,
        summary: `正在等待 ${tool.name} 的权限批准`,
      });
      const approved = await this.withApprovalLock(approvalSignal, () => waitForAbort(
        Promise.resolve().then(() => approve(tool.name, projectToolInput(tool, input), {
          requiresExplicitUserApproval: true,
        })),
        approvalSignal,
        'approval aborted',
      ));
      record.approval.decision = approved ? 'approved' : 'denied';
      record.approval.decidedAt = this.timestamp();
      record.approval.reason = approved ? undefined : 'denied by approval gate';
      this.publishRecord(record, retained);
      this.emitToolEvent({
        type: 'runtime_activity',
        visibility: 'progress',
        phaseId: `tool-approval:${record.callId}`,
        activityKind: 'runtime_waiting_approval',
        activityStatus: approved ? 'done' : 'failed',
        callId: record.callId,
        name: tool.name,
        summary: approved ? `${tool.name} 的权限已批准` : `${tool.name} 的权限未获批准`,
      });
      return approved
        ? { ok: true, granted: true }
        : {
            ok: false,
            status: 'approval_denied',
            error: 'denied by approval gate',
            errorKind: 'approval_denied',
          };
    } catch (error) {
      record.approval.decision = 'error';
      record.approval.decidedAt = this.timestamp();
      record.approval.reason = boundedError(error);
      this.publishRecord(record, retained);
      const aborted = error instanceof ToolControlError && error.status === 'aborted';
      this.emitToolEvent({
        type: 'runtime_activity',
        visibility: 'progress',
        phaseId: `tool-approval:${record.callId}`,
        activityKind: 'runtime_waiting_approval',
        activityStatus: aborted ? 'aborted' : 'failed',
        callId: record.callId,
        name: tool.name,
        summary: aborted ? `${tool.name} 的权限等待已取消` : `${tool.name} 的权限批准失败`,
      });
      if (error instanceof ToolControlError && error.status === 'aborted') {
        return {
          ok: false,
          status: 'aborted',
          error: error.message,
          errorKind: 'approval_aborted',
        };
      }
      return {
        ok: false,
        status: 'approval_denied',
        error: `approval error: ${errorMessage(error)}`,
        errorKind: 'approval_error',
      };
    }
  }

  private async executePrepared(
    invocation: PreparedInvocation,
    lifecycle?: ToolExecutionLifecycle,
  ): Promise<ToolResult> {
    const { request, registration, input, record, retained, resources } = invocation;
    const startedAtMs = Date.now();
    record.status = 'running';
    record.startedAt = this.timestamp();
    this.publishRecord(record, retained);
    this.emitToolEvent({
      type: 'tool_start',
      visibility: 'progress',
      callId: request.callId,
      name: request.name,
      stepId: request.stepId,
      input: projectToolInput(registration.tool, input),
    });
    const lifecycleContext: ToolExecutionLifecycleContext = {
      request,
      tool: registration.tool,
      toolSource: registration.source,
      input,
      resources,
    };

    let outcome: InvocationOutcome;
    try {
      const preflight = await lifecycle?.beforeInvoke?.(lifecycleContext);
      if (preflight) {
        outcome = preflight;
      } else {
        outcome = await this.invokeTool(invocation);
        if (lifecycle?.afterInvoke) {
          outcome = normalizeLifecycleResult(
            await lifecycle.afterInvoke(lifecycleContext, outcome.result, {
              status: outcome.status,
              errorKind: outcome.errorKind,
            }),
            outcome,
          );
        }
      }
    } catch (error) {
      outcome = {
        result: { callId: request.callId, ok: false, error: boundedError(error) },
        status: 'failed',
        errorKind: 'lifecycle_error',
      };
    }

    const finalized = sanitizeToolResult(outcome.result, this.options.sanitize);
    const result = stampToolStep({
      ...finalized,
      callId: request.callId,
      durationMs: Math.max(finalized.durationMs ?? 0, Date.now() - startedAtMs),
    }, request.stepId);
    const status = outcome.status ?? (result.ok ? 'succeeded' : 'failed');
    this.finishRecord(record, retained, status, result, outcome.errorKind);
    this.emitToolEvent({
      type: 'tool_end',
      visibility: 'progress',
      callId: request.callId,
      name: request.name,
      stepId: request.stepId,
      ok: result.ok,
      output: result.ok && result.output !== undefined ? String(result.output).slice(0, 400) : undefined,
      error: result.error,
      durationMs: result.durationMs,
    });
    return result;
  }

  private async invokeTool(invocation: PreparedInvocation): Promise<InvocationOutcome> {
    const { registration, input, approvalGranted, request } = invocation;
    const signal = request.signal ?? this.options.toolContext.signal;
    try {
      const toolName = registration.tool.name;
      const invocationContext: ToolContext = {
        ...this.options.toolContext,
        signal,
        // Tool code only receives a callback scoped to this invocation. A
        // nested or direct tool call cannot ask Main to auto-allow another
        // action by omitting the explicit-approval flag.
        approve: async (action, detail, approvalOptions) => {
          const sameApprovedInvocation = approvalGranted
            && action === toolName
            && (registration.source === 'builtin' || hashToolInput(detail) === hashToolInput(input));
          if (sameApprovedInvocation) return true;
          return await this.options.toolContext.approve?.(action, detail, {
            ...approvalOptions,
            requiresExplicitUserApproval: true,
          }) ?? false;
        },
      };
      if (invocation.shellGrant) attachShellInvocation(invocationContext, registration.tool, invocation.shellGrant);
      if (registration.source === 'builtin'
        && (toolName === 'read' || toolName === 'write' || toolName === 'edit')) {
        markNativeWorkspaceFileInvocation(invocationContext, toolName);
      }
      const result = await invokeWithTimeout(
        (toolSignal) => {
          invocationContext.signal = toolSignal;
          return registration.tool.execute(input, invocationContext);
        },
        this.options.timeoutMs,
        signal,
      );
      // A tool may declare a precise reason for a returned failure in
      // `meta.errorKind`; the outcome carries it into the invocation record.
      return invocationOutcomeForResult(result, request.callId);
    } catch (error) {
      if (error instanceof ToolControlError) {
        return {
          result: { callId: request.callId, ok: false, error: error.message },
          status: error.status,
          errorKind: error.status,
        };
      }
      return {
        result: { callId: request.callId, ok: false, error: boundedError(error) },
        status: 'failed',
        errorKind: 'tool_error',
      };
    }
  }

  private finishWithoutExecution(
    record: ToolInvocationRecord,
    retained: boolean,
    request: ToolInvocationRequest,
    status: ToolInvocationStatus,
    error: string,
    errorKind: string,
  ): ToolResult {
    const result = stampToolStep({ callId: request.callId, ok: false, error, meta: { errorKind } }, request.stepId);
    this.finishRecord(record, retained, status, result, errorKind);
    return result;
  }

  private finishRecord(
    record: ToolInvocationRecord,
    retained: boolean,
    status: ToolInvocationStatus,
    result: ToolResult,
    errorKind?: string,
  ): void {
    record.status = status;
    record.endedAt = this.timestamp();
    record.durationMs = result.durationMs;
    record.outputSummary = result.output === undefined
      ? undefined
      : `output present (${String(result.output).length} characters)`;
    record.outputSanitized = result.sanitized === true;
    record.outputTruncated = result.meta?.outputTruncated === true;
    record.errorKind = status === 'succeeded' ? undefined : (errorKind ?? status);
    record.error = status === 'succeeded' ? undefined : boundedText(result.error ?? 'tool execution failed');
    this.publishRecord(record, retained);
  }

  private incrementRepeat(key: string): number {
    const count = (this.repeatCounts.get(key) ?? 0) + 1;
    if (!this.repeatCounts.has(key) && this.repeatCounts.size >= MAX_REPEAT_KEYS) {
      const oldest = this.repeatCounts.keys().next().value as string | undefined;
      if (oldest) this.repeatCounts.delete(oldest);
    }
    this.repeatCounts.set(key, count);
    return count;
  }

  private timestamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private async withApprovalLock<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const previous = this.approvalQueue.catch(() => undefined);
    let release!: () => void;
    this.approvalQueue = new Promise<void>((resolve) => { release = resolve; });
    try {
      await waitForAbort(previous, signal, 'approval aborted');
      return await task();
    } finally {
      release();
    }
  }

  private emitToolEvent(event: ToolStreamEvent): void {
    try {
      this.options.onToolEvent?.(event);
    } catch (error) {
      this.options.toolContext.log?.('warn', 'tool event observer failed', boundedError(error));
    }
  }
}

function validateParallelStepContract(
  request: ToolInvocationRequest,
  policy: { concurrency: 'parallel' | 'exclusive'; resources: readonly ToolResourceAccess[] },
): string | undefined {
  const contract = request.parallelStep;
  if (!contract) return undefined;
  if (policy.concurrency !== 'parallel') {
    return `parallel step ${request.stepId ?? 'unknown'} selected an exclusive tool: ${request.name}`;
  }
  if (contract.sideEffect === 'none' && policy.resources.length > 0) {
    return `parallel step ${request.stepId ?? 'unknown'} declared no resource access but ${request.name} resolved resources`;
  }
  if (contract.sideEffect === 'read' && policy.resources.some((resource) => resource.mode === 'write')) {
    return `parallel step ${request.stepId ?? 'unknown'} declared read-only work but ${request.name} resolved a write`;
  }
  for (const actual of policy.resources) {
    if (!contract.resources.some((declared) => toolResourceAccessCovered(declared, actual))) {
      return `parallel step ${request.stepId ?? 'unknown'} exceeded its resource envelope at ${actual.key}`;
    }
  }
  return undefined;
}

function normalizeLifecycleResult(
  value: ToolExecutionLifecycleResult | ToolResult,
  fallback: InvocationOutcome,
): InvocationOutcome {
  if ('result' in value) return value;
  return { ...fallback, result: value };
}
