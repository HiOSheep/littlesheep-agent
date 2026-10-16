import { useEffect, useReducer, useRef, useState } from 'react'
import { listSkills, readSkill } from './api'
import { Markdown } from './Markdown'
import { useEscapeScope } from './ui/modal-surface'
import { StateView } from './ui/state-view'
import {
  initialSkillCatalogState,
  skillCatalogReducer,
  skillErrorMessage,
} from './skill-catalog-state'

interface MemorySkillsProps {
  onClose: () => void
  embedded?: boolean
}

export function MemorySkills({ onClose, embedded = false }: MemorySkillsProps) {
  const [query, setQuery] = useState('')
  const [state, dispatch] = useReducer(skillCatalogReducer, undefined, initialSkillCatalogState)
  const mountedRef = useRef(true)
  const listRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const {
    status, skills, loadError, stale, selected, failedDetailName, detailError,
  } = state

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    void loadSkills()
  }, [])

  // Page-level scope: Escape returns to settings only when no dialog or popover
  // is stacked above this page.
  useEscapeScope(onClose)

  async function loadSkills() {
    const requestId = ++listRequestRef.current
    dispatch({ type: 'load-start', requestId })
    try {
      const next = await listSkills()
      if (!mountedRef.current) return
      dispatch({ type: 'load-success', requestId, skills: next })
    } catch (error) {
      if (!mountedRef.current) return
      dispatch({ type: 'load-failure', requestId, message: skillErrorMessage(error) })
    }
  }

  async function openSkill(name: string) {
    const requestId = ++detailRequestRef.current
    dispatch({ type: 'detail-start', requestId, name })
    try {
      const next = await readSkill(name)
      if (!mountedRef.current) return
      dispatch({ type: 'detail-success', requestId, detail: next })
    } catch (error) {
      if (!mountedRef.current) return
      dispatch({ type: 'detail-failure', requestId, name, message: skillErrorMessage(error) })
    }
  }

  return (
    <div className="overlay" onClick={embedded ? undefined : onClose}>
      <div className="dialog memory-skills-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header settings-module-heading">
          <div>
            <h2>技能</h2>
            <p className="ms-desc">浏览本地技能与可复用的工作方法。<span className="settings-readonly-label">只读</span></p>
          </div>
          {/*
            A reload the user can actually start. Without it the "kept the list, marked it as not
            refreshed" branch was unreachable: the only buttons that reload appear *after* a
            failure, so a successful page could never be refreshed (UX-04 acceptance).
          */}
          <button
            className="ms-feedback-action"
            type="button"
            disabled={status === 'loading'}
            onClick={() => void loadSkills()}
          >
            {status === 'loading' ? '正在加载…' : '刷新'}
          </button>
          {!embedded && <button className="dialog-close" onClick={onClose}>×</button>}
        </div>
        <div className="ms-content">
          {selected ? (
            <div className="skill-detail-transition" key={selected.name}>
              <button className="ms-back" onClick={() => dispatch({ type: 'detail-close' })}>返回</button>
              <h3>{selected.name}</h3>
              <p className="ms-desc">{selected.description}</p>
              <div className="ms-body"><Markdown text={selected.body} /></div>
            </div>
          ) : (
            <div className="skill-detail-transition" key="skill-list">
              {status === 'loading' && <StateView state="loading" title="正在加载技能" />}
              {status === 'error' && (
                // A first load that failed is this area's failure state: the shared
                // view owns the danger glyph, the reason and the one retry, instead of
                // a hint line that looked like the empty list below it.
                <StateView
                  state="failure"
                  title="技能列表加载失败"
                  description={loadError ?? undefined}
                  action={(
                    <button className="ms-feedback-action" type="button" onClick={() => void loadSkills()}>
                      重试
                    </button>
                  )}
                />
              )}
              {stale && (
                <div className="ms-feedback">
                  <div className="ms-feedback-text warning" role="status">
                    未能刷新技能列表，以下仍是上次成功加载的内容：{loadError}
                  </div>
                  <button className="ms-feedback-action" type="button" onClick={() => void loadSkills()}>重新加载</button>
                </div>
              )}
              {detailError && (
                <div className="ms-feedback">
                  <div className="ms-feedback-text error" role="alert">读取技能详情失败：{detailError}</div>
                  {failedDetailName && (
                    <button className="ms-feedback-action" type="button" onClick={() => void openSkill(failedDetailName)}>
                      重试
                    </button>
                  )}
                </div>
              )}
              {status === 'ready' && skills.length === 0 && (
                // Loaded and genuinely empty: the neutral tray, not the loading line
                // and not a failure (all three used to be one `dialog-hint` box).
                <StateView state="empty" title="暂无技能" />
              )}
              <input className="skill-catalog-search" aria-label="搜索技能" placeholder="按名称或用途搜索技能" value={query} onChange={(event) => setQuery(event.target.value)} />
              {status === 'ready' && skills.length > 0 && !skills.some((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <StateView state="empty" title="没有匹配的技能" description="试试其他名称或用途。" />}
              {skills.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((s) => (
                <button key={s.name} className="ms-item" type="button" onClick={() => void openSkill(s.name)}>
                  <div className="ms-item-name">{s.name}</div>
                  <div className="ms-item-desc">{s.description}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
