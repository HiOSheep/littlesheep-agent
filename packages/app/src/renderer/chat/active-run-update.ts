// Sends a user-authored update into the current run without opening another run.
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { sendRuntimeTaskEvent } from '../api'
import type { ChatMessage } from './types'
import {
  createRuntimeTaskEventIdentity,
  describeRuntimeTaskEventFailure,
  describeRuntimeTaskEventOutcome,
  runtimeTaskEventNeedsNewIdentity,
  type RuntimeTaskEventIdentity,
  type RuntimeTaskEventNotice,
} from '../runtime-events/runtime-task-events'


export interface ActiveRunUpdateContext {
  activeRunIdRef: MutableRefObject<string | null>
  appMountedRef: MutableRefObject<boolean>
  hasAttachments: boolean
  pendingRuntimeMessageRef: MutableRefObject<{
    runId: string
    text: string
    identity: RuntimeTaskEventIdentity
  } | null>
  publishRuntimeEventNotice: (notice: RuntimeTaskEventNotice | null) => void
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  setInput: Dispatch<SetStateAction<string>>
}


export async function sendActiveRunUpdate(text: string, context: ActiveRunUpdateContext): Promise<void> {
  const { activeRunIdRef, appMountedRef, hasAttachments, pendingRuntimeMessageRef, publishRuntimeEventNotice, setInput, setMessages } = context
  if (!text) {
    if (hasAttachments) {
      const createdAt = Date.now()
      publishRuntimeEventNotice({
        id: `runtime-attachment-${createdAt}`,
        tone: 'warning',
        text: '运行中的任务暂不接收新附件，附件已保留在输入栏',
        createdAt,
      })
    }
    return
  }

  const runId = activeRunIdRef.current
  if (!runId) {
    const createdAt = Date.now()
    publishRuntimeEventNotice({
      id: `runtime-starting-${createdAt}`,
      tone: 'warning',
      text: '当前任务仍在启动，这条补充已保留，请稍后重试',
      createdAt,
    })
    return
  }

  const pending = pendingRuntimeMessageRef.current
  const identity = pending?.runId === runId && pending.text === text
    ? pending.identity
    : createRuntimeTaskEventIdentity('user-message')
  pendingRuntimeMessageRef.current = { runId, text, identity }

  try {
    const outcome = await sendRuntimeTaskEvent(runId, {
      type: 'user_message',
      text,
      id: identity.id,
      dedupKey: identity.dedupKey,
      reason: 'renderer-user-update',
    })
    if (!appMountedRef.current) return
    publishRuntimeEventNotice(describeRuntimeTaskEventOutcome('message', outcome))
    if (outcome.kind === 'accepted' || outcome.kind === 'duplicate') {
      setInput((current) => current.trim() === text ? '' : current)
      setMessages((current) => {
        if (current.some((message) => message.id === identity.id)) return current
        const next = [...current]
        let activeAssistantIndex = -1
        for (let index = next.length - 1; index >= 0; index -= 1) {
          if (next[index]?.role === 'assistant') {
            activeAssistantIndex = index
            break
          }
        }
        next.splice(activeAssistantIndex >= 0 ? activeAssistantIndex : next.length, 0, {
          id: identity.id,
          role: 'user',
          text,
          timestamp: outcome.event.receivedAt,
        })
        return next
      })
    }
    if (runtimeTaskEventNeedsNewIdentity(outcome)) pendingRuntimeMessageRef.current = null
  } catch (error) {
    if (appMountedRef.current) publishRuntimeEventNotice(describeRuntimeTaskEventFailure('message', error))
  }
}
