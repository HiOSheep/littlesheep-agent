export function environmentVersionDisplay(value: string | null): { label: string; diagnostic?: string } {
  if (!value) return { label: '未发现' }
  if (/^(?:(?:Python|git version|go version go|rustc|ruby|PHP|openjdk|java version|PowerShell)\s*)?v?\d+(?:\.\d+)+/iu.test(value.trim())) return { label: value.trim() }
  return { label: '检测未成功', diagnostic: value }
}
