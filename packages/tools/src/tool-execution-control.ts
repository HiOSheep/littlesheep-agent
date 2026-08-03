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

const TOOL_ABORT_SETTLE_GRACE_MS = 1_500;

export function invokeWithTimeout<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let controlError: ToolControlError | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      parentSignal?.removeEventListener('abort', onAbort);
    };
    const settle = (kind: 'resolve' | 'reject', value: T | unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (kind === 'resolve') resolve(value as T);
      else reject(value);
    };
    const stop = (error: ToolControlError) => {
      if (settled || controlError) return;
      controlError = error;
      controller.abort(error);
      graceTimer = setTimeout(() => settle('reject', error), TOOL_ABORT_SETTLE_GRACE_MS);
      graceTimer.unref?.();
    };
    const onAbort = () => {
      stop(new ToolControlError('aborted', 'aborted'));
    };
    const timer = setTimeout(() => {
      stop(new ToolControlError(`tool timed out after ${timeoutMs}ms`, 'timed_out'));
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
        (value) => controlError ? settle('reject', controlError) : settle('resolve', value),
        (error) => settle('reject', controlError ?? error),
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
