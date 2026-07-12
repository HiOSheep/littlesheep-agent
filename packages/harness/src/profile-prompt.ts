export function appendSystemPromptAddons(
  systemPrompt: string,
  ...addons: Array<string | undefined>
): string {
  const parts = addons
    .map((addon) => addon?.trim())
    .filter((addon): addon is string => Boolean(addon))
  if (parts.length === 0) return systemPrompt
  return `${systemPrompt}\n\n---\n\n${parts.join('\n\n---\n\n')}`
}
