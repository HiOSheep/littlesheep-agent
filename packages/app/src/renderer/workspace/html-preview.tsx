// Sandboxed HTML preview for workspace files. The source is sanitized before
// it enters an isolated iframe; it never becomes part of the app document.
import DOMPurify from 'dompurify'
import { attachmentFileUrl } from './path-utils'

const HTML_PREVIEW_FORBID_TAGS = [
  'base',
  'embed',
  'form',
  'iframe',
  'object',
  'script',
  'template',
]
const HTML_PREVIEW_FORBID_ATTR = ['srcdoc']
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
  const srcDoc = createHtmlPreviewDocument(content, path)
  return (
    <div className="workspace-preview-html-shell">
      <iframe
        className="workspace-preview-html"
        title={`HTML 预览：${name}`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
      />
    </div>
  )
}

export function createHtmlPreviewDocument(source: string, filePath: string): string {
  const sanitized = DOMPurify.sanitize(source, {
    FORBID_ATTR: HTML_PREVIEW_FORBID_ATTR,
    FORBID_TAGS: HTML_PREVIEW_FORBID_TAGS,
    ALLOW_DATA_ATTR: false,
  })
  const head = [
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
