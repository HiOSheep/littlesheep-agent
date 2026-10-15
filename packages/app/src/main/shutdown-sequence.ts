export interface ShutdownStep {
  name: string
  run: () => Promise<void> | void
}

export interface ShutdownSequenceOptions {
  stepTimeoutMs?: number
  onWarning?: (message: string) => void
}

/** Runs cleanup in dependency order while guaranteeing that no step can block exit forever. */
export async function runShutdownSequence(
  steps: ShutdownStep[],
  options: ShutdownSequenceOptions = {},
): Promise<void> {
  const stepTimeoutMs = Math.max(0, options.stepTimeoutMs ?? 1500)
  const warn = options.onWarning ?? (() => undefined)

  for (const step of steps) {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const operation = Promise.resolve()
      .then(() => step.run())
      .catch((err) => {
        warn(`${step.name} cleanup failed: ${errorMessage(err)}`)
      })
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        warn(`${step.name} cleanup exceeded ${stepTimeoutMs}ms; continuing shutdown`)
        resolve()
      }, stepTimeoutMs)
      // Keep the deadline alive after the last server or worker has closed.
      // A pending Promise alone does not keep Node's event loop running.
    })

    await Promise.race([operation, timeout])
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
