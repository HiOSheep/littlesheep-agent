export type AssistantActivityStatus = 'running' | 'done' | 'failed' | 'aborted'

export function executionDisclosureDefaultOpen(status: AssistantActivityStatus): boolean {
  return status === 'running'
}

export function verificationDisclosureDefaultOpen(verificationRunning: boolean): boolean {
  return verificationRunning
}

export function executionDisclosureResetKey(status: AssistantActivityStatus): string {
  return `execution:${status}`
}

export function verificationDisclosureResetKey(
  status: AssistantActivityStatus,
  verificationRunning: boolean,
): string {
  return `verification:${status}:${verificationRunning}`
}
