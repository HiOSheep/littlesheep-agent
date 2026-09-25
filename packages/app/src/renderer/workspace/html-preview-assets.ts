// Relative asset resolution for the sanitized HTML preview (UX-25 item 2).
//
// The preview frame is `sandbox=""` with an opaque origin, so Chromium refuses
// `file:` subresources: a stylesheet, image or font next to the HTML file simply
// does not load. The fix is not to relax the sandbox or `webSecurity` (that would
// hand the frame the whole disk) but to route subresources through Main's bounded
// loopback service, which resolves every path against the selected workspace root,
// rejects traversal and reports what it refused.
//
// This module is the pure half: it decides what a reference points at and rewrites
// it. It deliberately does no DOM work, so it stays unit-testable in Node and its
// rules can be read in one place.
//
// Covered by the item's own list: subdirectories, Chinese names, spaces, `#` and `%`
// in file names, and references that do not exist (which stay rewritten, so the
// request happens and Main records the failure instead of the preview pretending
// the resource was never referenced).

const ASSET_TAGS = 'img|source|video|audio|track|input|image|use|link'
const ASSET_ATTRIBUTES = ['src', 'href', 'xlink:href', 'poster', 'data', 'srcset']
/** Schemes and forms that are already absolute — they are not ours to rewrite. */
const ABSOLUTE_REFERENCE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu

export interface PreviewAssetContext {
  /**
   * Service root URL for the workspace, ending in `/`, token included — e.g.
   * `http://127.0.0.1:41234/ab12/`. References are resolved to paths *relative to
   * the workspace root* and appended to this, which is why the document's own
   * directory appears in the resolved path exactly once.
   */
  base: string
  /** Document path relative to the workspace root, POSIX separators. */
  documentPath: string
}

/**
 * Resolve one reference to the URL the frame should load.
 *
 * Returns the value unchanged when it is not a relative reference, and `null` when
 * it points above the workspace root (which is refused rather than clamped, so a
 * broken reference cannot silently become a different file).
 */
export function resolvePreviewAssetUrl(rawValue: string, context: PreviewAssetContext): string | null {
  const value = rawValue.trim()
  if (!value || value.startsWith('#')) return value
  if (ABSOLUTE_REFERENCE.test(value)) return value

  const { path, suffix } = splitQueryAndFragment(value)
  const encoded = encodeRelativePath(path, context.documentPath)
  if (encoded === null) return null
  return `${context.base}${encoded}${suffix}`
}

/**
 * Encode a relative reference into a URL path.
 *
 * Each segment is decoded first and then encoded, which is what makes the item's
 * `%` case work in both directions: a reference a page already wrote as
 * `shot%231.png` must stay `%23` (not become `%2523`), and a name that only has a
 * literal `#` in it was a fragment per the URL spec to begin with — that is decided
 * before this function runs.
 *
 * `..` is resolved against the document's directory, so it can never become
 * traversal, and every remaining segment goes through `encodeURIComponent`, which is
 * what carries spaces, Chinese names and `#`/`%` through the request intact.
 */
export function encodeRelativePath(reference: string, documentPath: string): string | null {
  const directory = documentPath.split('/').slice(0, -1)
  const segments = reference.startsWith('/')
    ? reference.split('/')
    : [...directory, ...reference.split('/')]
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
      continue
    }
    resolved.push(encodeURIComponent(decodeSegment(segment)))
  }
  return resolved.join('/')
}

/** A malformed escape (`100%.png`) is data, not an error. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * True when the document references anything that has to be fetched from disk.
 *
 * Values are captured rather than asserted with a lookahead: an optional quote
 * before the scheme test lets the engine skip the quote and then read `"data:…`
 * as a relative path, which made every data URL look like a local file.
 */
export function htmlPreviewNeedsAssets(source: string): boolean {
  if (cssNeedsAssets(source)) return true
  const tag = new RegExp(`<(${ASSET_TAGS})\\b[^>]*>`, 'giu')
  for (const match of source.matchAll(tag)) {
    for (const attribute of ASSET_ATTRIBUTES) {
      for (const value of attributeValues(match[0] ?? '', attribute)) {
        for (const candidate of attribute === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/u)[0] ?? '') : [value]) {
          if (isLocalReference(candidate)) return true
        }
      }
    }
  }
  return false
}

function cssNeedsAssets(css: string): boolean {
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/giu)) {
    if (isLocalReference(match[1] ?? match[2] ?? match[3] ?? '')) return true
  }
  for (const match of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/giu)) {
    if (isLocalReference(match[1] ?? match[2] ?? '')) return true
  }
  return false
}

function isLocalReference(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('#')) return false
  return !ABSOLUTE_REFERENCE.test(trimmed)
}

/** Every value of one attribute inside a single tag, quotes handled explicitly. */
function attributeValues(tag: string, attribute: string): string[] {
  const values: string[] = []
  const pattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'giu')
  for (const match of tag.matchAll(pattern)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return values
}

export interface PreviewAssetRewrite {
  html: string
  /** References that were rewritten, in document order. */
  rewritten: string[]
  /** References refused because they point above the workspace root. */
  refused: string[]
}


/**
 * Rewrite the sanitized document so its local references go through the service.
 *
 * Tags are matched by name and attributes are only touched inside those tags, so an
 * `<a href="page.html">` link target is left alone: this function exists to make
 * *subresources* load, not to rewrite navigation.
 */
export function rewritePreviewAssets(html: string, context: PreviewAssetContext): PreviewAssetRewrite {
  const rewritten: string[] = []
  const refused: string[] = []
  const record = (value: string): string => {
    const resolved = resolvePreviewAssetUrl(value, context)
    if (resolved === null) {
      refused.push(value)
      return value
    }
    if (resolved !== value) rewritten.push(value)
    return resolved
  }

  // The sanitizer is allowed to keep `<link>` so a local stylesheet survives, so this
  // is where every other use of the element is dropped again: `preload`, `prefetch`,
  // `icon`, `manifest` and friends reach for the network, which the preview promises
  // not to do. Dropping them also keeps UX-25 item 1's verified claim that the
  // document does not fetch anything on its own.
  const localOnly = html.replace(/<link\b[^>]*>/giu, (tag) => (
    /\brel\s*=\s*("stylesheet"|'stylesheet'|stylesheet\b)/iu.test(tag) ? tag : ''
  ))
  const withTagAssets = localOnly.replace(
    new RegExp(`<(${ASSET_TAGS})\\b[^>]*>`, 'giu'),
    (tag) => rewriteAttributes(tag, record),
  )
  const withInlineStyles = withTagAssets.replace(
    /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/giu,
    (match, _quoted: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? ''
      const next = rewriteCssUrls(value, record)
      if (next === value) return match
      return `style="${next.replace(/"/gu, '&quot;')}"`
    },
  )
  const withStyleBlocks = withInlineStyles.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/giu,
    (_match, open: string, css: string, close: string) => `${open}${rewriteCssUrls(css, record)}${close}`,
  )

  return { html: withStyleBlocks, rewritten, refused }
}

function rewriteAttributes(tag: string, record: (value: string) => string): string {
  let next = tag
  for (const attribute of ASSET_ATTRIBUTES) {
    const pattern = new RegExp(`(\\b${attribute.replace(':', ':')}\\s*=\\s*)("([^"]*)"|'([^']*)')`, 'giu')
    next = next.replace(pattern, (_match, prefix: string, _quoted: string, doubleQuoted?: string, singleQuoted?: string) => {
      const value = doubleQuoted ?? singleQuoted ?? ''
      if (attribute === 'srcset') {
        const rewrittenSet = value
          .split(',')
          .map((candidate) => {
            const trimmed = candidate.trim()
            if (!trimmed) return trimmed
            const [url, ...descriptor] = trimmed.split(/\s+/u)
            return [record(url ?? ''), ...descriptor].join(' ')
          })
          .join(', ')
        return `${prefix}"${rewrittenSet}"`
      }
      return `${prefix}"${record(value)}"`
    })
  }
  return next
}

/** `url(...)` and `@import` are the two ways CSS reaches a file. */
function rewriteCssUrls(css: string, record: (value: string) => string): string {
  const withUrls = css.replace(
    /url\(\s*("([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/giu,
    (_match, _all: string, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? ''
      return `url("${record(value)}")`
    },
  )
  return withUrls.replace(
    /@import\s+("([^"]*)"|'([^']*)')/giu,
    (_match, _all: string, doubleQuoted?: string, singleQuoted?: string) => {
      const value = doubleQuoted ?? singleQuoted ?? ''
      return `@import "${record(value)}"`
    },
  )
}

function splitQueryAndFragment(value: string): { path: string; suffix: string } {
  const index = value.search(/[?#]/u)
  if (index < 0) return { path: value, suffix: '' }
  return { path: value.slice(0, index), suffix: value.slice(index) }
}
