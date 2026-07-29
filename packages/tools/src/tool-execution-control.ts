// Abort-aware control primitives for one hosted tool or approval operation.

export class ToolControlError extends Error {
  constructor(
    message: string,
    readonly status: 'timed_out' | 'aborted',
  ) {
    super(message);
    this.name = 'ToolControlError';
  }
}

export function invokeWithTimeout<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    };
    const settle = (kind: 'resolve' | 'reject', value: T | unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (kind === 'resolve') resolve(value as T);
      else reject(value);
    };
    const onAbort = () => {
      controller.abort(parentSignal?.reason);
      settle('reject', new ToolControlError('aborted', 'aborted'));
    };
    const timer = setTimeout(() => {
      controller.abort(new Error(`tool timed out after ${timeoutMs}ms`));
      settle('reject', new ToolControlError(`tool timed out after ${timeoutMs}ms`, 'timed_out'));
    }, timeoutMs);
    if (parentSignal) {
      if (parentSignal.aborted) {
        onAbort();
        return;
      }
      parentSignal.addEventListener('abort', onAbort, { once: true });
    }
    Promise.resolve()
      .then(() => execute(controller.signal))
      .then(
        (value) => settle('resolve', value),
        (error) => settle('reject', error),
      );
  });
}

export function waitForAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const settle = (kind: 'resolve' | 'reject', value: T | unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (kind === 'resolve') resolve(value as T);
      else reject(value);
    };
    const onAbort = () => settle('reject', new ToolControlError(message, 'aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => settle('resolve', value),
      (error) => settle('reject', error),
    );
  });
}
