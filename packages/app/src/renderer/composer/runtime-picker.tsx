// Task composer controls, attachments, runtime selection, and sizing.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getSupportedReasoningOptions,
  type RuntimeReasoning
} from '../../shared/model-capabilities'
import {
  type RuntimeState
} from '../api'
import { REASONING_OPTIONS } from '../runtime/options'
import { useDismissOnOutside } from '../ui/presence'
import { COMPOSER_MENU_EVENT, transientTriggerProps } from '../ui/transient'
import { RuntimeProvider } from './context-usage-indicator'


export interface SelectedRuntimeModel {
  provider: RuntimeProvider
  model: string
  ref: string
}


export function RuntimePicker({
  runtime,
  providers,
  selected,
  onModelChange,
  onReasoningChange,
}: {
  runtime: RuntimeState | null
  providers: RuntimeProvider[]
  selected: SelectedRuntimeModel | null
  onModelChange: (model: string) => void
  onReasoningChange: (value: RuntimeReasoning) => void
}) {
  const [open, setOpen] = useState(false)
  const [activeProviderId, setActiveProviderId] = useState('')
  const [activeSubmenu, setActiveSubmenu] = useState<'model' | 'provider' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const submenuCloseTimerRef = useRef<number>()
  const disabled = !runtime
  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? providers[0]
  const activeModels = activeProvider?.models ?? []
  const reasoning = runtime?.reasoning ?? 'auto'
  const supportedReasoningIds = useMemo(
    () => getSupportedReasoningOptions(selected?.provider.id ?? '', selected?.model ?? ''),
    [selected?.model, selected?.provider.id],
  )
  const effectiveReasoning = supportedReasoningIds.includes(reasoning) ? reasoning : 'auto'
  const visibleReasoningOptions = REASONING_OPTIONS.filter((item) => supportedReasoningIds.includes(item.id))
  const reasoningOption = REASONING_OPTIONS.find((item) => item.id === effectiveReasoning) ?? REASONING_OPTIONS[0]
  const modelLabel = selected?.model ?? (providers.length === 0 ? '无可用模型' : '选择模型')

  useEffect(() => {
    if (providers.length === 0) {
      setActiveProviderId('')
      setActiveSubmenu(null)
      setOpen(false)
      return
    }
    const selectedProviderId = selected?.provider.id
    setActiveProviderId((current) => {
      if (selectedProviderId && providers.some((provider) => provider.id === selectedProviderId)) {
        return selectedProviderId
      }
      if (providers.some((provider) => provider.id === current)) return current
      return providers[0]?.id ?? ''
    })
  }, [providers, selected?.provider.id])

  useEffect(() => {
    if (!open) setActiveSubmenu(null)
  }, [open])

  useEffect(() => () => window.clearTimeout(submenuCloseTimerRef.current), [])

  useEffect(() => {
    if (!runtime || reasoning === effectiveReasoning) return
    onReasoningChange(effectiveReasoning)
  }, [effectiveReasoning, reasoning, runtime?.model])

  useEffect(() => {
    const handleComposerMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== 'runtime') {
        setActiveSubmenu(null)
        setOpen(false)
      }
    }
    window.addEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
    return () => window.removeEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
  }, [])

  function closePicker() {
    window.clearTimeout(submenuCloseTimerRef.current)
    setActiveSubmenu(null)
    setOpen(false)
  }

  function openRuntimeSubmenu(submenu: 'model' | 'provider') {
    window.clearTimeout(submenuCloseTimerRef.current)
    setActiveSubmenu(submenu)
  }

  function scheduleRuntimeSubmenuClose(delay = 140) {
    window.clearTimeout(submenuCloseTimerRef.current)
    submenuCloseTimerRef.current = window.setTimeout(() => {
      setActiveSubmenu(null)
    }, delay)
  }

  function cancelRuntimeSubmenuClose() {
    window.clearTimeout(submenuCloseTimerRef.current)
  }

  useDismissOnOutside(open, [rootRef], closePicker)

  return (
    <div ref={rootRef} className={`runtime-picker ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        type="button"
        className="runtime-picker-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`模型 ${modelLabel}, 推理 ${reasoningOption?.label ?? effectiveReasoning}`}
        onClick={() => {
          setOpen((value) => {
            const next = !value
            if (next) window.dispatchEvent(new CustomEvent(COMPOSER_MENU_EVENT, { detail: 'runtime' }))
            return next
          })
        }}
      >
        <span className="runtime-picker-model">{modelLabel}</span>
        <span className="runtime-picker-reasoning">{reasoningOption?.label ?? effectiveReasoning}</span>
      </button>
      <div
        className="runtime-menu-shell"
        aria-hidden={!open}
        onMouseEnter={cancelRuntimeSubmenuClose}
        onMouseLeave={() => scheduleRuntimeSubmenuClose(80)}
      >
        <div className="runtime-picker-panel runtime-menu-panel" role="menu" aria-label="模型和推理选择">
          <div className="runtime-section-title">推理程度</div>
          <div
            className="runtime-menu-list"
            role="group"
            aria-label="推理强度"
            onMouseEnter={() => scheduleRuntimeSubmenuClose(80)}
          >
            {visibleReasoningOptions.map((item) => {
              const isActive = item.id === effectiveReasoning
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`runtime-menu-item runtime-reasoning-option ${isActive ? 'active' : ''}`}
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => {
                    if (!isActive) onReasoningChange(item.id)
                    closePicker()
                  }}
                >
                  <span>{item.label}</span>
                  <small>{item.desc}</small>
                  <span className="runtime-menu-check" aria-hidden="true">{isActive ? '✓' : ''}</span>
                </button>
              )
            })}
          </div>
          <div className="runtime-menu-divider" />
          {providers.length === 0 ? (
            <div className="runtime-empty">没有已配置的可用模型</div>
          ) : (
            <button
              type="button"
              className={`runtime-menu-item runtime-submenu-trigger ${activeSubmenu === 'model' ? 'active' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={activeSubmenu === 'model'}
              onMouseEnter={() => openRuntimeSubmenu('model')}
              onMouseLeave={() => scheduleRuntimeSubmenuClose()}
              onFocus={() => openRuntimeSubmenu('model')}
              onClick={() => setActiveSubmenu((value) => (value === 'model' ? null : 'model'))}
            >
              <span>模型</span>
              <small>{modelLabel}</small>
              <span className="runtime-submenu-arrow" aria-hidden="true">&gt;</span>
            </button>
          )}
          {providers.length > 0 && (
            <>
              <div className="runtime-menu-divider" />
              <button
                type="button"
                className={`runtime-menu-item runtime-submenu-trigger ${activeSubmenu === 'provider' ? 'active' : ''}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={activeSubmenu === 'provider'}
                onMouseEnter={() => openRuntimeSubmenu('provider')}
                onMouseLeave={() => scheduleRuntimeSubmenuClose()}
                onFocus={() => openRuntimeSubmenu('provider')}
                onClick={() => setActiveSubmenu((value) => (value === 'provider' ? null : 'provider'))}
              >
                <span>厂商</span>
                <small>{activeProvider?.name ?? '选择厂商'}</small>
                <span className="runtime-submenu-arrow" aria-hidden="true">&gt;</span>
              </button>
            </>
          )}
        </div>
        <div
          className={`runtime-submenu runtime-${activeSubmenu ?? 'model'}-menu ${activeSubmenu && providers.length > 0 ? 'visible' : ''}`}
          role="menu"
          aria-label={
            activeSubmenu === 'provider'
              ? '供应商'
              : activeProvider ? `${activeProvider.name} 模型` : '模型'
          }
          aria-hidden={!activeSubmenu || providers.length === 0}
          onMouseEnter={cancelRuntimeSubmenuClose}
          onMouseLeave={() => scheduleRuntimeSubmenuClose()}
        >
          <div className="runtime-menu-list">
            {activeSubmenu === 'provider'
              ? providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={`runtime-menu-item runtime-provider-option ${
                    provider.id === activeProvider?.id ? 'active' : ''
                  }`}
                  role="menuitemradio"
                  aria-checked={provider.id === activeProvider?.id}
                  onMouseEnter={() => setActiveProviderId(provider.id)}
                  onFocus={() => setActiveProviderId(provider.id)}
                  onClick={() => setActiveProviderId(provider.id)}
                >
                  <span>{provider.name}</span>
                  <small>{provider.models.length}</small>
                </button>
              ))
              : activeModels.map((model) => {
                const ref = `${activeProvider?.id}/${model}`
                const isActive = ref === runtime?.model
                return (
                  <button
                    key={ref}
                    type="button"
                    className={`runtime-menu-item runtime-model-option ${isActive ? 'active' : ''}`}
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => {
                      if (!isActive) onModelChange(ref)
                      closePicker()
                    }}
                  >
                    <span>{model}</span>
                    <span className="runtime-menu-check" aria-hidden="true">{isActive ? '✓' : ''}</span>
                  </button>
                )
              })}
          </div>
        </div>
      </div>
    </div>
  )
}


export function splitModelRef(ref: string): { providerId: string; model: string } {
  const idx = ref.indexOf('/')
  if (idx < 0) return { providerId: '', model: ref }
  return { providerId: ref.slice(0, idx), model: ref.slice(idx + 1) }
}
