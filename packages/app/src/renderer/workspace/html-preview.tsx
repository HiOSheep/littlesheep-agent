// Sandboxed HTML preview for workspace files. The source is sanitized before
// it enters an isolated iframe; it never becomes part of the app document.
//
// Two measured defects shape this file (UX-24 baseline, `verify:html-preview-baseline`):
//   1. The sanitizer used to run as a fragment, so the document's <head> — and with
//      it every <style> rule — was dropped and a styled page rendered as unstyled
//      text on white. The whole document is sanitized now, keeping title and style.
//   2. A `srcdoc` set while the frame was still loading its initial empty document
//      could be ignored by Chromium, leaving a permanently blank preview. The frame
//      is therefore only created once there is a document to show, and it is keyed
//      by that document: a new document gets a new frame instead of a late update.
import DOMPurify from 'dompurify'
import { attachmentFileUrl } from './path-utils'
import { WorkspacePlaceholder } from './placeholder'

const HTML_PREVIEW_FORBID_TAGS = [
  'base',
  'embed',
  'form',
  'iframe',
  'meta',
  'object',
  'script',
  'template',
]
const HTML_PREVIEW_FORBID_ATTR = ['srcdoc']
/** `title` is not in the sanitizer's default list, but it is pure static metadata. */
const HTML_PREVIEW_ADD_TAGS = ['title']
const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  'img-src data: blob: file: http: https:',
  "style-src 'unsafe-inline' data: file: http: https:",
  'font-src data: blob: file: http: https:',
  'media-src data: blob: file: http: https:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
].join('; ')

export function WorkspaceHtmlPreview({
  path,
  name,
  content,
}: {
  path: string
  name: string
  content: string
}) {
  if (!content.trim()) {
    return (
      <div className="workspace-preview-html-shell">
        <WorkspacePlaceholder title="HTML 预览" text="这个文件还没有内容，暂无可显示的页面。" />
      </div>
    )
  }
  const srcDoc = createHtmlPreviewDocument(content, path)
  return (
    <div className="workspace-preview-html-shell">
      <p className="workspace-preview-html-note" role="status">
        静态预览：保留标题与样式，不运行页面脚本，也不发起网络请求。
      </p>
      <iframe
        key={previewDocumentKey(path, srcDoc)}
        className="workspace-preview-html"
        title={`HTML 预览：${name}`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
      />
    </div>
  )
}

/**
 * Identity of the document a frame was created with.
 *
 * The frame is keyed by this value so that new content always lands in a frame
 * created for it; a frame whose initial empty document is still loading can
 * ignore a later `srcdoc` update (measured in Electron).
 */
export function previewDocumentKey(path: string, srcDoc: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < srcDoc.length; index += 1) {
    hash ^= srcDoc.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${path}:${srcDoc.length}:${hash.toString(16)}`
}

export function createHtmlPreviewDocument(source: string, filePath: string): string {
  const sanitized = DOMPurify.sanitize(source, {
    // A whole document, not a fragment: without this the <head> (title, style)
    // is dropped and a styled page renders as unstyled text on white.
    WHOLE_DOCUMENT: true,
    ADD_TAGS: HTML_PREVIEW_ADD_TAGS,
    FORBID_ATTR: HTML_PREVIEW_FORBID_ATTR,
    FORBID_TAGS: HTML_PREVIEW_FORBID_TAGS,
    ALLOW_DATA_ATTR: false,
  })
  const head = [
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(HTML_PREVIEW_CSP)}">`,
    `<base href="${escapeHtmlAttribute(resolveHtmlBaseUrl(filePath))}">`,
  ].join('')
  return addPreviewHead(sanitized, head)
}

function resolveHtmlBaseUrl(filePath: string): string {
  return new URL('.', attachmentFileUrl(filePath)).href
}

function addPreviewHead(sanitized: string, head: string): string {
  const headTag = /<head\b[^>]*>/iu.exec(sanitized)
  if (headTag?.index !== undefined) {
    const insertAt = headTag.index + headTag[0].length
    return `${sanitized.slice(0, insertAt)}${head}${sanitized.slice(insertAt)}`
  }

  const htmlTag = /<html\b[^>]*>/iu.exec(sanitized)
  if (htmlTag?.index !== undefined) {
    const insertAt = htmlTag.index + htmlTag[0].length
    return `${sanitized.slice(0, insertAt)}<head>${head}</head>${sanitized.slice(insertAt)}`
  }

  return `<!doctype html><html><head>${head}</head><body>${sanitized}</body></html>`
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}
