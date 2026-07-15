// Primary navigation, project/session trees, and sidebar actions.
import { useEffect, useRef, useState } from 'react'
import { CloseIcon, ProjectIcon } from '../ui/icons'
import { useDismissOnOutside } from '../ui/presence'
import { compactPath } from '../workspace/path-utils'

export const PROJECT_CREATOR_MOTION_MS = 360


export function ProjectCreatorDialog({
  show,
  defaultParentPath,
  onClose,
  onChooseExisting,
  onChooseParent,
  onCreateNew,
}: {
  show: boolean
  defaultParentPath: string
  onClose: () => void
  onChooseExisting: () => Promise<void>
  onChooseParent: () => Promise<string | null>
  onCreateNew: (parentPath: string, name: string) => Promise<void>
}) {
  const [mounted, setMounted] = useState(show)
  const [visible, setVisible] = useState(false)
  const [mode, setMode] = useState<'choose' | 'create'>('choose')
  const [parentPath, setParentPath] = useState(defaultParentPath)
  const [folderName, setFolderName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let frame = 0
    let innerFrame = 0
    let timer = 0
    if (show) {
      setVisible(false)
      setMounted(true)
      setError(null)
      setParentPath(defaultParentPath)
      frame = window.requestAnimationFrame(() => {
        innerFrame = window.requestAnimationFrame(() => setVisible(true))
      })
    } else {
      setVisible(false)
      timer = window.setTimeout(() => {
        setMounted(false)
        setMode('choose')
        setFolderName('')
        setError(null)
      }, PROJECT_CREATOR_MOTION_MS)
    }
    return () => {
      window.cancelAnimationFrame(frame)
      window.cancelAnimationFrame(innerFrame)
      window.clearTimeout(timer)
    }
  }, [defaultParentPath, show])

  useDismissOnOutside(mounted && visible, [dialogRef], onClose, 'click')

  if (!mounted) return null

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      if (!mountedRef.current) return
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  async function pickParent() {
    const selected = await onChooseParent()
    if (mountedRef.current && selected) setParentPath(selected)
  }

  async function submitCreate() {
    const name = folderName.trim()
    if (!parentPath || !name) return
    await onCreateNew(parentPath, name)
  }

  return (
    <div className={`project-creator-layer ${visible ? 'visible' : ''}`} aria-hidden={!visible}>
      <div className="project-creator-scrim" />
      <div
        ref={dialogRef}
        className="project-creator-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="创建项目"
      >
        <div className="project-creator-header">
          <span>
            <strong>新项目</strong>
            <small>选择一个项目工作区，之后的对话会归入这个项目。</small>
          </span>
          <button className="project-creator-close" type="button" aria-label="关闭" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className={`project-creator-body ${mode === 'create' ? 'creating' : ''}`}>
          <button
            className="project-creator-option"
            type="button"
            disabled={busy}
            onClick={() => void run(onChooseExisting)}
          >
            <span className="project-creator-option-icon"><ProjectIcon /></span>
            <span>
              <strong>选择目标文件夹</strong>
              <small>使用已有文件夹作为项目</small>
            </span>
          </button>

          <button
            className={`project-creator-option ${mode === 'create' ? 'active' : ''}`}
            type="button"
            disabled={busy}
            onClick={() => setMode((value) => (value === 'create' ? 'choose' : 'create'))}
          >
            <span className="project-creator-option-icon">+</span>
            <span>
              <strong>创建新文件夹</strong>
              <small>在指定位置新建项目文件夹</small>
            </span>
          </button>

          <div className={`project-create-panel ${mode === 'create' ? 'visible' : ''}`}>
            <button className="project-parent-picker" type="button" disabled={busy} onClick={() => void run(pickParent)}>
              <span>
                <strong>存放位置</strong>
                <small>{parentPath ? compactPath(parentPath) : '选择父文件夹'}</small>
              </span>
              <span className="project-parent-arrow" aria-hidden="true" />
            </button>
            <label className="project-name-input">
              <span>文件夹名称</span>
              <input
                value={folderName}
                disabled={busy}
                onChange={(event) => setFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void run(submitCreate)
                  }
                }}
                placeholder="例如 LittleSheep Research"
              />
            </label>
            <button
              className="project-create-submit"
              type="button"
              disabled={busy || !parentPath || !folderName.trim()}
              onClick={() => void run(submitCreate)}
            >
              {busy ? '创建中' : '创建项目'}
            </button>
          </div>
        </div>

        {error && <div className="project-creator-error">{error}</div>}
      </div>
    </div>
  )
}
