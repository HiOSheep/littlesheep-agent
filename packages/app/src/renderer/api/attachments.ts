// Renderer attachment picker and managed import client.

import type { AttachmentRef } from '../../shared/attachment-contracts'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes'
import { localApiStatusError, localApiUrl } from './common'

export function getPathForFile(file: File): string {
  return window.littlesheep?.getPathForFile?.(file) ?? ''
}

export async function selectAttachments(): Promise<AttachmentRef[]> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.attachmentSelect), { method: 'POST' })
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { files: AttachmentRef[] }
  return data.files
}

export async function importAttachment(file: File): Promise<AttachmentRef> {
  const dataUrl = await readFileAsDataUrl(file)
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.attachmentImport), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: file.name || defaultAttachmentName(file),
      mimeType: file.type,
      dataUrl,
    }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  const data = await res.json() as { file: AttachmentRef }
  return data.file
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('failed to read attachment'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}

function defaultAttachmentName(file: File): string {
  if (file.type === 'image/png') return 'clipboard.png'
  if (file.type === 'image/jpeg') return 'clipboard.jpg'
  return 'clipboard-file'
}
