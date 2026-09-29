// The turn's web sources: the count summary, the evidence's own limits, and the citations.
//
// Split out of `assistant-turn.tsx` (O3) because the block is a self-contained projection of one
// `WebEvidenceProjection`: the transcript component owns folding and visibility, this file owns how
// a citation list is summarised and disclosed.
import { useState } from 'react'
import type { WebEvidenceProjection } from '@littlesheep/types'

/** How many citations the sources block lists before the reader has to ask for the rest. */
export const WEB_SOURCES_VISIBLE_ROWS = 3

/**
 * The turn's sources: a count summary, the evidence limitations that stay true whether or not the
 * list is open, and the citations themselves behind one disclosure (O3).
 *
 * A reply that cites ten pages should not push ten rows between the answer and the next turn, but a
 * *blocked*, *truncated* or *cached* source is a limit of the evidence and must not be hidden by
 * folding: those facts are computed from the projection and printed on the summary line itself.
 */
export function WebSources({ evidence }: { evidence: WebEvidenceProjection }) {
  const [expanded, setExpanded] = useState(false)
  const state = webEvidenceStateLabel(evidence)
  const citations = evidence.citations ?? []
  const flags = webSourceFlags(citations)
  const hiddenCount = Math.max(0, citations.length - WEB_SOURCES_VISIBLE_ROWS)
  const shown = expanded || hiddenCount === 0 ? citations : citations.slice(0, WEB_SOURCES_VISIBLE_ROWS)
  return (
    <section className="web-sources" aria-label="网络资料来源">
      <div className="web-sources-heading">
        <strong>来源</strong>
        <span>{state} · {evidence.citationCount} 项</span>
      </div>
      {flags.length > 0 && (
        <div className="web-sources-flags">{flags.join(' · ')}</div>
      )}
      {shown.map((citation) => (
        <a
          key={citation.id}
          className="web-source-row"
          href={citation.url}
          {...(!citation.url ? { 'aria-disabled': true, onClick: (event) => event.preventDefault() } : {})}
          title={citation.url ? `打开 ${citation.origin}` : '安全投影未保留完整链接'}
        >
          <span className="web-source-copy">
            <strong>{citation.title || citation.origin}</strong>
            <small>{sourceDomain(citation.origin)} · {sourceTime(citation.publishedAt ?? citation.fetchedAt)}</small>
          </span>
          <span className="web-source-state">{webCitationStateLabel(citation)}</span>
        </a>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="web-sources-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起来源' : `展开其余 ${hiddenCount} 项`}
          <span className={`web-sources-toggle-arrow ${expanded ? 'open' : ''}`} aria-hidden="true" />
        </button>
      )}
      {evidence.errorKinds && evidence.errorKinds.length > 0 && (
        <div className="web-source-errors" role="status">{evidence.errorKinds.map(webErrorLabel).join(' · ')}</div>
      )}
    </section>
  )
}

/** The limitations of the *evidence*, not of one row: what the reader must know with the list closed. */
export function webSourceFlags(citations: NonNullable<WebEvidenceProjection['citations']>): string[] {
  const flags: string[] = []
  const count = (predicate: (citation: (typeof citations)[number]) => boolean) => citations.filter(predicate).length
  const blocked = count((citation) => citation.status === 'blocked')
  const truncated = count((citation) => citation.truncated || citation.status === 'partial')
  const cached = count((citation) => citation.status === 'cached')
  if (blocked > 0) flags.push(`${blocked} 项被安全策略阻止`)
  if (truncated > 0) flags.push(`${truncated} 项只读到一部分`)
  if (cached > 0) flags.push(`${cached} 项来自缓存`)
  return flags
}

export function webCitationStateLabel(citation: NonNullable<WebEvidenceProjection['citations']>[number]): string {
  if (citation.status === 'cached') return '缓存'
  if (citation.status === 'blocked') return '阻止'
  if (citation.truncated || citation.status === 'partial') return '截断'
  return '已读取'
}

function sourceDomain(origin: string): string {
  try { return new URL(origin).hostname } catch { return origin }
}

function sourceTime(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value
}

export function webEvidenceStateLabel(evidence: WebEvidenceProjection): string {
  if (evidence.blocked) return '已阻止'
  if (evidence.completeness === 'none') return '无可用资料'
  if (evidence.partial || evidence.truncated) return '部分资料'
  if (evidence.cached) return '缓存资料'
  return '实时资料'
}

export function webErrorLabel(value: string): string {
  if (value === 'web_disabled') return '网络检索已关闭'
  if (value === 'web_provider_unconfigured') return '搜索服务未配置'
  if (value === 'web_provider_auth_failed') return '搜索服务认证失败'
  if (value === 'web_provider_rate_limited') return '搜索服务限流'
  if (value === 'web_provider_unavailable') return '搜索服务暂不可用'
  if (value === 'web_provider_invalid_response') return '搜索服务返回异常结果'
  if (value === 'web_invalid_query') return '检索条件无效'
  if (value === 'web_sensitive_query_blocked') return '检索内容被隐私策略阻止'
  if (value === 'web_fetch_timeout') return '页面读取超时'
  if (value === 'web_fetch_cancelled') return '页面读取已取消'
  if (value === 'web_response_too_large') return '页面内容超过读取上限'
  if (value === 'web_content_unsupported') return '页面内容格式不受支持'
  if (value === 'web_extraction_failed') return '页面正文提取失败'
  if (value === 'web_cache_unavailable') return '本地网页缓存暂不可用'
  if (value === 'web_citation_invalid') return '来源引用无法验证'
  if (value === 'web_ssrf_blocked' || value === 'web_url_invalid' || value === 'web_scheme_blocked'
    || value === 'web_dns_check_failed' || value === 'web_redirect_blocked') return '地址被安全策略阻止'
  if (value === 'web_partial') return '资料不完整'
  return '网络资料读取失败'
}
