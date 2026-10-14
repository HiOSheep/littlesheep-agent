import { useEffect, useState } from 'react'
import type { ContextInspection } from '../../shared/context-inspector-contracts'
import { getContextWindowForModelRef } from '../../shared/model-capabilities'
import { fetchContextInspection } from '../api/context-inspector'
import { contextOccupancy, loadedContextUsage, selectContextRequest, snapshotTime, tokenValue } from './model'

const KIND_LABELS = {
  system_prompt: '系统提示', user_input: '用户输入', recent_message: '会话历史', summary_memory: '压缩摘要',
  memory_index: '记忆索引', memory_fragment: '记忆片段与状态', project_knowledge: '项目资料', tool_result: '工具结果',
  workflow_state: '工作流状态', output_constraint: '输出约束', attachment_manifest: '附件', runtime_event: '运行时信息',
}
const SCOPE_LABELS = { run: '本次运行', session: '会话', project: '项目', workspace: '工作区', global: '全局' }

export function ContextInspectorPage({ sessionId, modelRef, running, active = true }: {
  sessionId: string | null; modelRef?: string; running: boolean; active?: boolean
}) {
  const [data, setData] = useState<ContextInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState<{ sessionId: string; requestId: string } | null>(null)
  useEffect(() => {
    if (!active) return
    if (!sessionId) { setData(null); setError(null); setPending(false); return }
    const abort = new AbortController()
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      setPending(true)
      try {
        const result = await fetchContextInspection(sessionId, abort.signal)
        if (!disposed) { setData(result); setError(null) }
      } catch {
        if (!disposed) { setData(null); setError('诊断暂时无法加载，请稍后刷新。') }
      } finally {
        if (!disposed) {
          setPending(false)
          if (running) timer = setTimeout(() => void refresh(), 2000)
        }
      }
    }
    setData(null)
    setError(null)
    void refresh()
    return () => { disposed = true; abort.abort(); clearTimeout(timer) }
  }, [sessionId, running, revision, active])
  const bound = data?.sessionId === sessionId ? data : null
  const selectedRequest = selection?.sessionId === sessionId
    ? selectContextRequest(bound, sessionId, modelRef, selection.requestId) : undefined
  const detailOpen = !!selectedRequest
  const request = selectedRequest ?? selectContextRequest(bound, sessionId, modelRef)
  const occupancy = contextOccupancy(request, modelRef)
  const local = request?.trace.tokens.local
  const provider = request?.trace.tokens.provider
  const usage = provider?.status === 'reported' ? provider : undefined
  const localTokens = local?.status === 'exact' ? local.promptTokens : undefined
  const windowTokens = request?.maxContextTokens ?? (getContextWindowForModelRef(request?.modelRef ?? modelRef) || undefined)
  const historical = !!request && (request !== selectContextRequest(bound, sessionId, modelRef) || occupancy.historical || !request.conversationRequest)
  const partial = request && Object.values(request.trace.coverage).some((value) => value === 'partial')
  return <section className="context-inspector-surface" aria-label="Context Inspector">
    <header className="context-inspector-header">
      {detailOpen ? <button className="context-inspector-back" onClick={() => setSelection(null)}>‹ 会话总览</button> : <h1>会话总览</h1>}
      <button className="context-inspector-refresh" onClick={() => setRevision((value) => value + 1)} disabled={pending || !sessionId}>{pending ? '加载中…' : '刷新'}</button>
    </header>
    <div className="context-inspector-content">
      <div className="context-inspector-status" role="status">
        {running || bound?.active ? 'Agent 仍在运行 · 页面只读，不会中断任务' : '只读快照'}
        {detailOpen ? historical ? ' · 历史请求' : ' · 最近会话请求' : ''}{detailOpen && partial ? ' · 部分数据' : ''}
      </div>
      {error ? <p className="context-inspector-notice" role="alert">{error}</p> : null}
      {!detailOpen ? <SessionOverview data={bound} sessionId={sessionId} modelRef={modelRef} running={running} pending={pending}
        onSelect={(requestId) => setSelection({ sessionId: sessionId!, requestId })} /> : null}
      {!request ? <div className="context-inspector-empty"><h2>{!sessionId ? '尚未发送消息' : pending ? '正在加载上下文' : '暂无可用 Trace'}</h2>
        <p>发送消息后，可在这里查看已载入请求的诊断。没有数据时不会估算或补成零。</p>
        </div> : detailOpen ? <>
        <h2>请求 #{request.requestIndex} · {request.conversationRequest ? '会话' : '辅助请求'}</h2>
        <div className="context-inspector-cards">
          <Metric label="模型" value={request.modelRef} detail="所选请求使用的模型" />
          <Metric label="快照时间" value={snapshotTime(request.createdAt)} detail={historical ? '历史请求' : '最近会话请求'} />
          <Metric label={historical ? '所选快照输入（历史）' : '最近请求上下文输入'} value={historical ? tokenValue(localTokens ?? usage?.promptTokens) : tokenValue(occupancy.tokens)}
            detail={historical ? '不代表当前窗口占用' : occupancy.source === 'local' ? '本地精确计数优先' : occupancy.source === 'provider' ? 'Provider 实报' : '无可用计数'} />
          <Metric label="模型上下文窗口" value={tokenValue(windowTokens)} detail="容量，非累计用量" />
          <Metric label="本地 Token 计数" value={tokenValue(localTokens)} detail={localTokens === undefined ? '精确账本不可用' : snapshotTime(request.localCountedAt)} />
          <Metric label="Provider 输入" value={tokenValue(usage?.promptTokens)} detail={usage ? snapshotTime(request.providerReportedAt) : 'Provider 尚未提供 Usage'} />
        </div>
        <h2>Provider 使用情况</h2>
        <div className="context-inspector-cards">
          <Metric label="输入 Token" value={tokenValue(usage?.promptTokens)} detail="所选单次请求" />
          <Metric label="输出 Token" value={tokenValue(usage?.completionTokens)} detail="所选单次请求" />
          <Metric label="缓存读取" value={tokenValue(usage?.cachedPromptTokens)} detail="输入子集，不减少上下文占用" />
          <Metric label="缓存写入" value={tokenValue(usage?.cacheWriteTokens)} detail="仅展示 Provider 实报" />
          <Metric label="缓存未命中" value={tokenValue(usage?.uncachedPromptTokens)} detail="缺失时保持不可用" />
          <Metric label="推理 Token" value={tokenValue(usage?.reasoningTokens)} detail="输出子集，不重复累计" />
        </div>
        <h2>上下文构成</h2>
        <p className="context-inspector-note">{request.trace.messageCount} 条消息 · {request.trace.toolCount} 个原生工具。以下为来源条目与字符统计，不是逐组件 Token 归因。</p>
        {partial ? <p className="context-inspector-notice">快照存在截断或未识别项，来源表只覆盖可用数据。</p> : null}
        <div className="context-inspector-table-scroll"><table><thead><tr><th>来源 / kind</th><th>作用域</th><th>source</th><th>包含 / 省略条目</th><th>包含 / 省略字符</th></tr></thead><tbody>
          {request.trace.sources.map((source) => <tr key={`${source.kind}:${source.scope}`}>
            <td>{KIND_LABELS[source.kind]}<small>{source.kind}</small></td><td>{SCOPE_LABELS[source.scope]}<small>{source.scope}</small></td>
            <td>{source.sourceKinds?.join(' / ') || '不可用'}</td><td>{source.includedItems} / {source.omittedItems}</td>
            <td>{tokenValue(source.includedCharactersUnavailable ? undefined : source.includedCharacters)} / {tokenValue(source.omittedCharactersUnavailable ? undefined : source.omittedCharacters)}</td>
          </tr>)}
        </tbody></table></div>
        <p className="context-inspector-note">字符按 UTF-16 计数。原生工具 schema 大小、逐来源 Token 暂不可用；scope 表示请求片段作用域，不是记忆共享权限。</p>
      </> : null}
      <footer className="context-inspector-note">
        {bound ? `已载入 ${bound.requests.length} 个请求快照，其中 ${bound.requests.filter((item) => item.trace.tokens.provider.status === 'reported').length} 个含 Provider Usage。` : '尚无已载入的请求统计。'}
        {bound?.truncated ? ' 请求列表已截断。' : ''} 这是有限的已载入历史，不是会话累计 Token 或完整请求时间线。
        <p>仅展示脱敏元数据。</p>
      </footer>
    </div>
  </section>
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="context-inspector-card"><span>{label}</span><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</div>
}

export function SessionOverview({ data, sessionId, modelRef, running, pending, onSelect }: {
  data: ContextInspection | null; sessionId: string | null; modelRef?: string; running: boolean; pending: boolean;
  onSelect: (requestId: string) => void;
}) {
  const bound = data?.sessionId === sessionId ? data : null
  const latest = selectContextRequest(bound, sessionId, modelRef)
  const occupancy = contextOccupancy(latest, modelRef)
  const capacity = (latest?.modelRef === modelRef ? latest?.maxContextTokens : undefined)
    ?? (getContextWindowForModelRef(modelRef) || undefined)
  const usage = loadedContextUsage(bound)
  const total = (item: { value?: number; partial: boolean }) => `${tokenValue(item.value)}${item.value !== undefined && item.partial ? '（部分）' : ''}`
  const date = (value?: number) => value !== undefined && Number.isFinite(value) ? snapshotTime(new Date(value).toISOString()) : '不可用'
  return <div className="context-inspector-overview">
    <div className="context-inspector-cards">
      <Metric label="会话" value={bound?.session?.title || (sessionId ? '当前会话' : '新会话')} />
      <Metric label="状态" value={running || bound?.active ? '运行中' : pending ? '加载中' : '空闲'} />
      <Metric label="当前模型" value={modelRef || '不可用'} />
      <Metric label="上下文窗口" value={tokenValue(capacity)} />
      <Metric label={`当前上下文输入${occupancy.source === 'local' ? ' · 本地' : occupancy.source === 'provider' ? ' · Provider' : ''}`} value={tokenValue(occupancy.tokens)} />
      <Metric label="上下文使用率" value={capacity && occupancy.tokens !== undefined ? `${Math.round(occupancy.tokens / capacity * 100)}%` : '不可用'} />
      <Metric label="创建时间" value={date(bound?.session?.createdAt)} />
      <Metric label="最后活动" value={date(bound?.session?.lastMessageAt)} />
      <Metric label="会话累计 Token" value="不可用" />
      <Metric label="已载入请求数" value={bound ? tokenValue(usage.requests) : '不可用'} />
    </div>
    <h2>已载入请求用量 · Provider</h2>
    <div className="context-inspector-cards">
      <Metric label="输入 Token" value={total(usage.input)} />
      <Metric label="输出 Token" value={total(usage.output)} />
      <Metric label="缓存读取" value={total(usage.cached)} />
      <Metric label="缓存写入" value={total(usage.written)} />
    </div>
    <h2>请求轨迹{bound?.truncated ? ' · 已截断' : ''}</h2>
    <div className="context-inspector-timeline">
      {bound?.requests.map((item, index) => <button key={`${item.runId}:${item.requestId}`} className="context-inspector-timeline-row" onClick={() => onSelect(item.requestId)}>
        <span>#{index + 1} · {item.conversationRequest ? '会话请求' : '辅助请求'}<small>{item.modelRef}</small></span>
        <span>{snapshotTime(item.createdAt)}<small>{item.runState === 'active' ? '运行中' : '已记录'}{Object.values(item.trace.coverage).includes('partial') ? ' · 部分数据' : ''}</small></span>
        <span aria-hidden="true">›</span>
      </button>)}
      {!bound?.requests.length ? <p className="context-inspector-note">暂无可用请求轨迹</p> : null}
    </div>
  </div>
}
