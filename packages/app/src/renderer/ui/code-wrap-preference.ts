// One shared preference for "wrap long lines in code" (taskbook UX-23).
//
// The chat code blocks and the workspace editor use different renderers, but the
// switch the user sees is one switch: both sides read and write this key, so the
// state is the same in every code block, in the editor, and after a restart.
// Default is off (code scrolls horizontally), which is what the reference put
// behind the toggle.
const CODE_WRAP_STORAGE_KEY = 'littlesheep.ui.codeWrap'

export interface CodeWrapStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function defaultStorage(): CodeWrapStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    // A blocked storage (privacy mode, sandboxed frame) must not break rendering:
    // the preference then simply stays at its default for this session.
    return undefined
  }
}

export function readCodeWrapPreference(storage: CodeWrapStorage | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(CODE_WRAP_STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

export function writeCodeWrapPreference(
  value: boolean,
  storage: CodeWrapStorage | undefined = defaultStorage(),
): boolean {
  try {
    storage?.setItem(CODE_WRAP_STORAGE_KEY, value ? 'on' : 'off')
    return true
  } catch {
    return false
  }
}

/** The action a user performs next, not the current state: the button label. */
export function codeWrapToggleLabel(wrapped: boolean): string {
  return wrapped ? '关闭自动换行' : '开启自动换行'
}

export const CODE_WRAP_STORAGE = CODE_WRAP_STORAGE_KEY
