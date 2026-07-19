// Coalesce high-frequency UI state updates to the browser's display frame.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'


export function useFrameCoalescedState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(initialValue)
  const pendingRef = useRef(value)
  const frameRef = useRef<number>()
  const setCoalesced = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    const current = pendingRef.current
    pendingRef.current = typeof next === 'function'
      ? (next as (value: T) => T)(current)
      : next
    if (frameRef.current !== undefined) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = undefined
      setValue(pendingRef.current)
    })
  }, [])

  useEffect(() => () => {
    window.cancelAnimationFrame(frameRef.current ?? 0)
    frameRef.current = undefined
  }, [])

  return [value, setCoalesced]
}
