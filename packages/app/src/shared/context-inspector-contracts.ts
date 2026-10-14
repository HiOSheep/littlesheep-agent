// Inspector data is a content-free Runner projection, separate from chat transcript APIs.
import type { ContextInspection as RunnerContextInspection } from '@littlesheep/runner';
export type { ContextInspectionRequest } from '@littlesheep/runner';

export type ContextInspection = RunnerContextInspection & {
  /** Authorized session index metadata; no transcript or execution-log read. */
  session?: { title?: string; createdAt?: number; lastMessageAt?: number };
};
