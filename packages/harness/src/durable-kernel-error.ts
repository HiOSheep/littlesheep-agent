/** Shared error type for durable event validation and projection boundaries. */
export type DurableKernelErrorKind =
  | 'invalid'
  | 'conflict'
  | 'duplicate_final_reply'
  | 'inbox_unavailable'
  | 'transition';

export class DurableKernelError extends Error {
  constructor(message: string, readonly kind: DurableKernelErrorKind) {
    super(message);
    this.name = 'DurableKernelError';
  }
}
