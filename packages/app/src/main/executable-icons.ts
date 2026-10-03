// Icons for the executables the workspace offers.
//
// A handler called `msedge` says less than its own icon does, and the menus that list applications
// (open with, terminal shell) carried text only. Electron reads the icon out of the executable; the
// lookup is cached because those lists are rebuilt on every preview action.
//
// The icon is asked for at `large` (48px) rather than the 16px `small`: the menu draws it in a 15px
// box, so a scaled display (1.5x, 2x) upscaled the 16px bitmap and the edges came out visibly
// jagged (reported 2026-10-03). Downscaling a 48px bitmap is what the browser does well.
//
// Best-effort by design: anything unavailable - no Electron, a missing file, a format Chromium will
// not decode - answers an empty string, and the menu keeps its own glyph instead of failing the
// whole list.
const cache = new Map<string, string>()

export async function executableIconDataUrl(executable: string): Promise<string> {
  if (!executable) return ''
  const key = executable.toLowerCase()
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  let icon = ''
  try {
    const { app } = await import('electron')
    const image = await app.getFileIcon(executable, { size: 'large' })
    icon = image.isEmpty() ? '' : image.toDataURL()
  } catch {
    icon = ''
  }
  cache.set(key, icon)
  return icon
}
