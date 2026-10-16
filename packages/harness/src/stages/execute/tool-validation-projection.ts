/** Project only bounded Runtime Schema facts into a model-visible tool result. */
export function projectRuntimeValidationDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const details = value as Record<string, unknown>;
  if (details.source !== 'runtime_schema' || !Array.isArray(details.issues)) return undefined;
  const issues = details.issues.slice(0, 8).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const issue = candidate as Record<string, unknown>;
    const path = Array.isArray(issue.path)
      ? issue.path.slice(0, 8)
        .filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
        .map((part) => typeof part === 'string' ? part.slice(0, 80) : part)
      : [];
    return [{
      code: typeof issue.code === 'string' ? issue.code.slice(0, 40) : 'invalid_input',
      path,
      ...(typeof issue.expected === 'string' ? { expected: issue.expected.slice(0, 32) } : {}),
      ...(typeof issue.received === 'string' ? { received: issue.received.slice(0, 32) } : {}),
      ...(Array.isArray(issue.keys)
        ? { keys: issue.keys.slice(0, 8).filter((key): key is string => typeof key === 'string').map((key) => key.slice(0, 80)) }
        : {}),
    }];
  });
  return { source: 'runtime_schema', issues };
}
