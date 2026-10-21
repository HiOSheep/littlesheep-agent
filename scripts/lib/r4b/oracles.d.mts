import type { V2Task } from './tasks.mjs';

export interface DimensionResult {
  status: 'passed' | 'failed' | 'not_applicable' | 'unverified';
  evidenceRefs: string[];
  rejectionReasons: string[];
  missingFields: string[];
  [key: string]: unknown;
}

export interface MechanismResult extends DimensionResult {
  status: 'passed' | 'failed' | 'not_exercised' | 'blocked' | 'unverified';
  triggered: boolean;
  blockReason?: string;
}

export interface WorkspaceSnapshot {
  files: string[];
  contents: Record<string, string>;
}

export function evaluateFile02Goal(input: { task: V2Task; files: string[]; contents: Record<string, string> }): DimensionResult;
export function evaluateFile02Contract(input: { task: V2Task; files: string[]; contents: Record<string, string> }): DimensionResult;
export function evaluateDeliv01Goal(input: {
  task: V2Task; files: string[]; contents: Record<string, string>;
  successfulExecutions: number; duplicateSuccessfulEffects: number; toolName?: string;
}): DimensionResult;
export function evaluateDeliv01Mechanism(input: {
  task: V2Task;
  invocations: Array<{ toolName?: string; status?: string; errorKind?: string; callId?: string }>;
  successfulExecutions: number;
  duplicateSuccessfulEffects: number;
  expectedTool?: string;
}): MechanismResult;
export function evaluateTask(task: V2Task, observation: WorkspaceSnapshot & {
  successfulExecutions?: number;
  duplicateSuccessfulEffects?: number;
  invocations?: Array<{ toolName?: string; status?: string; errorKind?: string; callId?: string }>;
}): { goal: DimensionResult; contract: DimensionResult; mechanism: MechanismResult };
export function unverifiedDimensions(task: V2Task, missingFields: string[]): { goal: DimensionResult; contract: DimensionResult; mechanism: MechanismResult };
export function fileEvidence(path: string, content: string): { kind: 'file'; path: string; sha256: string; bytes: number };
