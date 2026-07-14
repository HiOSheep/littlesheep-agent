import { useEffect, useRef, useState } from 'react'
import { listSkills, readSkill, type SkillDetail, type SkillMeta } from './api'
import { Markdown } from './Markdown'

interface MemorySkillsProps {
  onClose: () => void
  embedded?: boolean
}

export function MemorySkills({ onClose, embedded = false }: MemorySkillsProps) {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null)
  const mountedRef = useRef(true)
  const requestRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestRef.current += 1
    }
  }, [])

  useEffect(() => {
    void loadSkills()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function loadSkills() {
    const requestId = ++requestRef.current
    try {
      const next = await listSkills()
      if (!mountedRef.current || requestId !== requestRef.current) return
      setSkills(next)
    } catch {
      if (mountedRef.current && requestId === requestRef.current) setSkills([])
    }
  }

  async function openSkill(name: string) {
    const requestId = ++requestRef.current
    try {
      const next = await readSkill(name)
      if (!mountedRef.current || requestId !== requestRef.current) return
      setSelectedSkill(next)
    } catch {
      if (mountedRef.current && requestId === requestRef.current) setSelectedSkill(null)
    }
  }

  return (
    <div className="overlay" onClick={embedded ? undefined : onClose}>
      <div className="dialog memory-skills-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <div>
            <h2>技能</h2>
            <p className="ms-desc">本地技能会在这里集中查看，后续可继续接启用、禁用和编辑。</p>
          </div>
          {!embedded && <button className="dialog-close" onClick={onClose}>×</button>}
        </div>
        <div className="ms-content content-fade">
          {selectedSkill ? (
            <div className="content-fade" key={selectedSkill.name}>
              <button className="ms-back" onClick={() => setSelectedSkill(null)}>返回</button>
              <h3>{selectedSkill.name}</h3>
              <p className="ms-desc">{selectedSkill.description}</p>
              <div className="ms-body"><Markdown text={selectedSkill.body} /></div>
            </div>
          ) : (
            <div className="content-fade" key="skill-list">
              {skills.length === 0 && <div className="dialog-hint">暂无技能</div>}
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
