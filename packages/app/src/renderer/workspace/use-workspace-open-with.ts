// Which application opens a workspace file, kept beside the preview rather than inside it.
//
// The list is what this machine can really open the file with: the external editor LS knows how to
// start, the handlers Windows registers for the extension, and the file manager as the last, always
// available entry. The choice is remembered per user, and Main re-resolves the id before starting
// anything, so a stale list can never launch something else.
import { useCallback, useEffect, useState } from 'react'
import {
  launchWorkspaceOpenWith,
  listWorkspaceOpenWith,
  revealWorkspacePath,
  type WorkspaceOpenWithHandler,
} from '../api/workspace-files'

const OPEN_WITH_STORAGE_KEY = 'littlesheep.ui.workspaceOpenWithApp'
const OPEN_WITH_CHOICE_EVENT = 'littlesheep:workspace-open-with-choice'
/** The external editor entry is addressed by a constant id: it is not a registry handler. */
export const OPEN_WITH_VSCODE_ID = '__vscode__'
export const OPEN_WITH_REVEAL_ID = '__reveal__'

/** VS Code under any install: `Code.exe`, `Code - Insiders.exe` and their forks share the stem. */
export function isSameExecutableAsVSCode(executable: string): boolean {
  const name = executable.replace(/\\/gu, '/').split('/').at(-1)?.toLowerCase() ?? ''
  return name === 'code.exe' || name.startsWith('code - ')
}

function readStoredChoice(): string | null {
  try {
    return window.localStorage.getItem(OPEN_WITH_STORAGE_KEY)
  } catch {
    return null
  }
}

function storeChoice(id: string) {
  try {
    window.localStorage.setItem(OPEN_WITH_STORAGE_KEY, id)
  } catch {
    // A blocked storage only costs the memory of this session.
  }
  window.dispatchEvent(new CustomEvent<string>(OPEN_WITH_CHOICE_EVENT, { detail: id }))
}

export interface WorkspaceOpenWith {
  handlers: WorkspaceOpenWithHandler[]
  isVSCodeDefault?: boolean
  /** The handler the primary segment would use right now. */
  currentId: string
  choose: (id: string) => void
  openWithCurrent: () => void
  /** Opens the file with a specific handler and remembers it. */
  openWith: (id: string) => void
  reveal: () => void
}

export function useWorkspaceOpenWith({
  root,
  path,
  canOpenInVSCode,
  onOpenInVSCode,
  onError,
  additionalChoices = [],
}: {
  root: string
  path: string | null
  canOpenInVSCode: boolean
  onOpenInVSCode: () => void | Promise<void>
  onError?: (message: string) => void
  additionalChoices?: readonly { id: string; available: boolean; open: () => void | Promise<void> }[]
}): WorkspaceOpenWith {
  const [handlers, setHandlers] = useState<WorkspaceOpenWithHandler[]>([])
  const [isVSCodeDefault, setIsVSCodeDefault] = useState(false)
  const [storedChoice, setStoredChoice] = useState<string | null>(() => readStoredChoice())
  useEffect(() => {
    const changed = (event: Event) => setStoredChoice((event as CustomEvent<string>).detail)
    const storage = (event: StorageEvent) => {
      if (event.key === OPEN_WITH_STORAGE_KEY || event.key === null) setStoredChoice(readStoredChoice())
    }
    window.addEventListener(OPEN_WITH_CHOICE_EVENT, changed)
    window.addEventListener('storage', storage)
    return () => {
      window.removeEventListener(OPEN_WITH_CHOICE_EVENT, changed)
      window.removeEventListener('storage', storage)
    }
  }, [])

  useEffect(() => {
    if (!path) {
      setHandlers([])
      setIsVSCodeDefault(false)
      return
    }
    let alive = true
    void listWorkspaceOpenWith(root, path)
      .then((discovered) => {
        if (!alive) return
        setIsVSCodeDefault(discovered.some(handler => handler.isDefault && isSameExecutableAsVSCode(handler.executable)))
        // The external editor has its own entry and its own launcher, so the registry's copy of it
        // is dropped rather than shown twice.
        setHandlers(canOpenInVSCode
          ? discovered.filter((handler) => !isSameExecutableAsVSCode(handler.executable))
          : discovered)
      })
      .catch(() => {
        if (alive) { setHandlers([]); setIsVSCodeDefault(false) }
      })
    return () => {
      alive = false
    }
  }, [canOpenInVSCode, root, path])

  const choose = useCallback((id: string) => {
    setStoredChoice(id)
    storeChoice(id)
  }, [])

  const openWith = useCallback((id: string) => {
    const additional = additionalChoices.find(choice => choice.id === id)
    if (additional) {
      if (!additional.available) return
      choose(id)
      void Promise.resolve().then(additional.open).catch((error: unknown) => onError?.(error instanceof Error ? error.message : String(error)))
      return
    }
    choose(id)
    if (id === OPEN_WITH_VSCODE_ID) {
      void onOpenInVSCode()
      return
    }
    if (id === OPEN_WITH_REVEAL_ID || !path) {
      void revealWorkspacePath(root, path ?? '').catch((error: unknown) => {
        onError?.(error instanceof Error ? error.message : String(error))
      })
      return
    }
    void launchWorkspaceOpenWith(root, path, id).catch((error: unknown) => {
      onError?.(error instanceof Error ? error.message : String(error))
    })
  }, [additionalChoices, choose, onError, onOpenInVSCode, path, root])

  const reveal = useCallback(() => {
    if (!path) return
    void revealWorkspacePath(root, path).catch((error: unknown) => {
      onError?.(error instanceof Error ? error.message : String(error))
    })
  }, [onError, path, root])

  const defaultId = canOpenInVSCode
    ? OPEN_WITH_VSCODE_ID
    : handlers.find((handler) => handler.isDefault)?.id ?? handlers[0]?.id ?? OPEN_WITH_REVEAL_ID
  const currentId = storedChoice && (
    storedChoice === OPEN_WITH_VSCODE_ID
      ? canOpenInVSCode
      : storedChoice === OPEN_WITH_REVEAL_ID || handlers.some((handler) => handler.id === storedChoice)
        || additionalChoices.some(choice => choice.id === storedChoice && choice.available)
  )
    ? storedChoice
    : defaultId

  return {
    handlers,
    isVSCodeDefault,
    currentId,
    choose,
    openWithCurrent: () => openWith(currentId),
    openWith,
    reveal,
  }
}
