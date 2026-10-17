type NativeWorkspaceFileToolName = 'read' | 'write' | 'edit' | 'runtime_check_file_content'

const nativeWorkspaceInvocations = new WeakMap<object, NativeWorkspaceFileToolName>()

/** Internal capability; intentionally omitted from the tools package public barrel. */
export function markNativeWorkspaceFileInvocation(
  context: object,
  toolName: NativeWorkspaceFileToolName,
): void {
  nativeWorkspaceInvocations.set(context, toolName)
}

export function isNativeWorkspaceFileInvocation(
  context: object,
  toolName: NativeWorkspaceFileToolName,
): boolean {
  return nativeWorkspaceInvocations.get(context) === toolName
}
