// @littlesheep/safety — public API
//
// Write-side defence (SafeMemoryStore) + read-side defence (sanitizePrelude)
// + quarantine store for rejected writes. Composable with Snapshot (Phase B)
// and ExperienceDB (Phase C) via the MemoryStoreLike structural interface.

export { INJECTION_PATTERNS, type InjectionPattern } from './patterns.js';
export {
  validateMemoryContent,
  DEFAULT_MAX_LENGTH,
  type ValidateOptions,
  type ValidationResult,
} from './validate.js';
export {
  sanitizePreludeForInjection,
  type SanitizePreludeOptions,
} from './sanitize-prelude.js';
export {
  QuarantineStore,
  parseQuarantineFile,
  type QuarantineEntry,
  type QuarantineStoreOptions,
} from './quarantine.js';
export {
  SafeMemoryStore,
  type SafeMemoryStoreOptions,
} from './safe-memory-store.js';
export {
  authorizeToolAccess,
  classifySensitiveWebQuery,
  describeToolAccess,
  redactSensitiveWebQuery,
  resolvePermissionDecision,
  shouldRequestPermissionApproval,
  type ContainerBoundary,
  type PermissionAction,
  type PermissionDecision,
  type PermissionEffect,
  type PermissionEgress,
  type PermissionBoundaryContext,
  type PermissionTrust,
  type SafeReadClass,
  type SensitiveWebQueryClassification,
  type HardDecision,
  type ToolAccessDescriptor,
  type ToolAuthorization,
} from './permission-boundary.js';
