import { useEffect, useReducer, useRef } from 'react'
import { listSkills, readSkill } from './api'
import { Markdown } from './Markdown'
import { useEscapeScope } from './ui/modal-surface'
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
        <div className="dialog-header">
          <div>
            <h2>技能</h2>
            <p className="ms-desc">本地技能会在这里集中查看。当前版本只能查看内容，不能在界面里启用、禁用或编辑技能。</p>
          </div>
          {!embedded && <button className="dialog-close" onClick={onClose}>×</button>}
        </div>
        <div className="ms-content content-fade">
          {selected ? (
            <div className="content-fade" key={selected.name}>
              <button className="ms-back" onClick={() => dispatch({ type: 'detail-close' })}>返回</button>
              <h3>{selected.name}</h3>
              <p className="ms-desc">{selected.description}</p>
              <div className="ms-body"><Markdown text={selected.body} /></div>
            </div>
          ) : (
            <div className="content-fade" key="skill-list">
              {status === 'loading' && <div className="dialog-hint">正在加载技能…</div>}
              {status === 'error' && (
                <div className="ms-feedback">
                  <div className="ms-feedback-text error" role="alert">技能列表加载失败：{loadError}</div>
                  <button className="ms-feedback-action" type="button" onClick={() => void loadSkills()}>重试</button>
                </div>
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
              {status === 'ready' && skills.length === 0 && <div className="dialog-hint">暂无技能</div>}
              {skills.map((s) => (
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
