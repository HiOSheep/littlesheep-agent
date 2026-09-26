// UX-29/UX-30: which shell this terminal uses, kept out of the terminal surface.
//
// The surface is a composition hotspot with a line ceiling, and this is self-contained: read
// the shells Main discovered once, honour the saved preference, and report when that
// preference is gone.
import { useEffect, useRef, useState } from 'react'
import { listWorkspaceTerminalShells, type WorkspaceShellProfile } from '../api/terminal'
import { preferredShellId, resolveTerminalShellChoice, savePreferredShellId } from './terminal-shell-choice'

export interface TerminalShellSelection {
  profiles: WorkspaceShellProfile[]
  /** The chosen profile id, mirrored in a ref for the session-start path. */
  shellId: string | null
  shellIdRef: { current: string | null }
  notice: string
  choose: (id: string) => void
  clearNotice: () => void
}

export function useTerminalShellSelection(): TerminalShellSelection {
  const [profiles, setProfiles] = useState<WorkspaceShellProfile[]>([])
  const [shellId, setShellId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const shellIdRef = useRef<string | null>(null)

  // Discovery changes when the machine changes (a Git install, a WSL distribution), so it is
  // read once per mount and every start asks Main again through the profile id.
  useEffect(() => {
    let alive = true
    void listWorkspaceTerminalShells()
      .then((discovered) => {
        if (!alive) return
        setProfiles(discovered)
        const choice = resolveTerminalShellChoice(discovered, preferredShellId())
        setShellId(choice.selected?.id ?? null)
        setNotice(choice.notice ?? '')
        shellIdRef.current = choice.selected?.id ?? null
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])

  return {
    profiles,
    shellId,
    shellIdRef,
    notice,
    choose: (id: string) => {
      savePreferredShellId(id)
      setShellId(id)
      setNotice('')
      shellIdRef.current = id
    },
    clearNotice: () => setNotice(''),
  }
}
