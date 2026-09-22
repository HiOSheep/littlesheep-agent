// Task composer controls, attachments, runtime selection, and sizing.
import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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
import { describeRuntimeAvailability } from './runtime-availability'


export interface SelectedRuntimeModel {
  provider: RuntimeProvider
  model: string
  ref: string
}

interface RuntimeMenuPosition {
  left: number
  bottom: number
  width: number
  submenuWidth: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function RuntimePicker({
  runtime,
  runtimeError,
  providers,
  selected,
  onModelChange,
  onReasoningChange,
  onConfigureModel,
  onRetryModelConfig,
}: {
  runtime: RuntimeState | null
  /** Composer-level Runtime error; with a null runtime it means the
   *  configuration could not be read. */
  runtimeError: string | null
  providers: RuntimeProvider[]
  selected: SelectedRuntimeModel | null
  onModelChange: (model: string) => void
  onReasoningChange: (value: RuntimeReasoning) => void
  /** Opens 设置 → 模型供应商 without dropping the current draft. */
  onConfigureModel: () => void
  /** Re-reads the Runtime configuration after a failed load. */
  onRetryModelConfig: () => void
}) {
  const [open, setOpen] = useState(false)
  const [activeProviderId, setActiveProviderId] = useState('')
  const [activeSubmenu, setActiveSubmenu] = useState<'model' | 'provider' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuShellRef = useRef<HTMLDivElement>(null)
  const submenuCloseTimerRef = useRef<number>()
  const menuPositionFrameRef = useRef<number>()
  const [menuPosition, setMenuPosition] = useState<RuntimeMenuPosition | null>(null)
  const [closedWidth, setClosedWidth] = useState<number | null>(null)
  // A failed configuration load stays clickable: the menu is where the retry
  // and the path to the provider settings live.
  const availability = describeRuntimeAvailability({
    runtime,
    runtimeError,
    selectableProviderCount: providers.length,
    hasSelectableModel: selected !== null,
  })
  const disabled = !runtime && availability.kind === 'loading'
  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? providers[0]
  const activeModels = activeProvider?.models ?? []
  const selectedEntry = selected?.provider.models.find((model) => model.id === selected.model)
  const reasoning = runtime?.reasoning ?? 'auto'
  const supportedReasoningIds = useMemo(
    // The runtime payload already carries declared options for user-declared
    // models; the built-in registry only fills in the presets.
    () => selectedEntry?.reasoningOptions
      ?? getSupportedReasoningOptions(selected?.provider.id ?? '', selected?.model ?? ''),
    [selectedEntry, selected?.model, selected?.provider.id],
  )
  const effectiveReasoning = supportedReasoningIds.includes(reasoning) ? reasoning : 'auto'
  const visibleReasoningOptions = REASONING_OPTIONS.filter((item) => supportedReasoningIds.includes(item.id))
  const reasoningOption = REASONING_OPTIONS.find((item) => item.id === effectiveReasoning) ?? REASONING_OPTIONS[0]
  const modelLabel = selected
    ? selectedEntry?.declared && selectedEntry.name !== selectedEntry.id
      ? selectedEntry.name
      : formatRuntimeModelLabel(selected.model, selected.provider.id, selected.provider.name)
    : availability.kind === 'ready' ? '选择模型' : availability.label

  useEffect(() => {
    if (providers.length === 0) {
      setActiveProviderId('')
      setActiveSubmenu(null)
      // The empty menu stays openable: it is the only place that offers the
      // "配置模型" / "重试读取" action. Outside click and Escape still close it.
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

  useLayoutEffect(() => {
    const updateMenuPosition = () => {
      const anchor = rootRef.current
      if (!anchor) return

      const rect = anchor.getBoundingClientRect()
      const margin = 12
      const gap = 8
      const minimumMenuWidth = 176
      const maximumMenuWidth = 208
      const minimumSubmenuWidth = 143
      const maximumSubmenuWidth = 220
      const availableWidth = Math.max(320, window.innerWidth - margin * 2)
      const width = Math.min(maximumMenuWidth, Math.max(
        minimumMenuWidth,
        availableWidth - gap - minimumSubmenuWidth,
      ))
      const submenuWidth = Math.min(maximumSubmenuWidth, Math.max(
        minimumSubmenuWidth,
        availableWidth - width - gap,
      ))
      const maxLeft = window.innerWidth - margin - width - gap - submenuWidth

      setMenuPosition({
        left: clamp(rect.right - width, margin, Math.max(margin, maxLeft)),
        bottom: Math.max(margin, window.innerHeight - rect.top + 10),
        width,
        submenuWidth,
      })
    }

    if (!open) {
      const trigger = triggerRef.current
      if (trigger && !trigger.matches(':hover') && !trigger.matches(':focus-visible')) {
        const width = trigger.getBoundingClientRect().width
        if (width > 0) {
          setClosedWidth((current) => current === width ? current : width)
        }
      }
      updateMenuPosition()
      return
    }

    const scheduleUpdate = () => {
      if (menuPositionFrameRef.current !== undefined) return
      menuPositionFrameRef.current = window.requestAnimationFrame(() => {
        menuPositionFrameRef.current = undefined
        updateMenuPosition()
      })
    }

    updateMenuPosition()
    window.addEventListener('resize', scheduleUpdate)
    window.addEventListener('scroll', scheduleUpdate, true)
    return () => {
      window.removeEventListener('resize', scheduleUpdate)
      window.removeEventListener('scroll', scheduleUpdate, true)
      if (menuPositionFrameRef.current !== undefined) {
        window.cancelAnimationFrame(menuPositionFrameRef.current)
        menuPositionFrameRef.current = undefined
      }
    }
  }, [modelLabel, open, reasoningOption?.id])

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

  useDismissOnOutside(open, [rootRef, menuShellRef], closePicker)

  const renderedMenuPosition = menuPosition ?? {
    left: 0,
    bottom: 0,
    width: 208,
    submenuWidth: 220,
  }

  const menuShell = (
    <div
      ref={menuShellRef}
      className={`runtime-menu-shell ${open ? 'open' : ''}`}
      style={{
        left: `${renderedMenuPosition.left}px`,
        bottom: `${renderedMenuPosition.bottom}px`,
        width: `${renderedMenuPosition.width}px`,
        '--runtime-submenu-width': `${renderedMenuPosition.submenuWidth}px`,
      } as CSSProperties}
      aria-hidden={!open}
      {...(!open ? { inert: '' } : {})}
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
          <div className="runtime-empty">
            <span>{availability.label}</span>
            <small>{availability.detail}</small>
            {availability.action !== 'none' && (
              <button
                type="button"
                className="runtime-menu-item runtime-configure-action"
                role="menuitem"
                onClick={() => {
                  closePicker()
                  if (availability.action === 'retry') onRetryModelConfig()
                  else onConfigureModel()
                }}
              >
                {availability.actionLabel}
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            className={`runtime-menu-item runtime-submenu-trigger ${activeSubmenu === 'model' ? 'active' : ''}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeSubmenu === 'model'}
            onMouseEnter={() => openRuntimeSubmenu('model')}
            onFocus={() => openRuntimeSubmenu('model')}
            onClick={() => openRuntimeSubmenu('model')}
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
              onFocus={() => openRuntimeSubmenu('provider')}
              onClick={() => openRuntimeSubmenu('provider')}
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
        {...(!activeSubmenu || providers.length === 0 ? { inert: '' } : {})}
        onMouseEnter={cancelRuntimeSubmenuClose}
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
              const ref = `${activeProvider?.id}/${model.id}`
              const isActive = ref === runtime?.model
              const displayModel = model.declared && model.name !== model.id
                ? model.name
                : formatRuntimeModelLabel(model.id, activeProvider?.id, activeProvider?.name)
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
                  <span>{displayModel}</span>
                  <span className="runtime-menu-check" aria-hidden="true">{isActive ? '✓' : ''}</span>
                </button>
              )
            })}
        </div>
      </div>
    </div>
  )

  return (
    <>
      <div
        ref={rootRef}
        className={`runtime-picker ${open ? 'open' : ''}`}
        style={{
          '--runtime-picker-open-width': `${menuPosition?.width ?? 208}px`,
          '--runtime-picker-closed-width': closedWidth ? `${closedWidth}px` : undefined,
        } as CSSProperties}
      >
        <button
          {...transientTriggerProps()}
          type="button"
          className="runtime-picker-trigger composer-tab-control"
          ref={triggerRef}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`模型 ${modelLabel}, 推理 ${reasoningOption?.label ?? effectiveReasoning}`}
          title={availability.kind === 'ready' ? undefined : availability.detail}
          onClick={() => {
            if (open) {
              closePicker()
              return
            }

            window.dispatchEvent(new CustomEvent(COMPOSER_MENU_EVENT, { detail: 'runtime' }))
            setOpen(true)
          }}
        >
          <span className="runtime-picker-label-group">
            <span className="runtime-picker-model">{modelLabel}</span>
            <span className="runtime-picker-reasoning">{reasoningOption?.label ?? effectiveReasoning}</span>
          </span>
        </button>
      </div>
      {menuShell && (typeof document === 'undefined' ? menuShell : createPortal(menuShell, document.body))}
    </>
  )
}


export function splitModelRef(ref: string): { providerId: string; model: string } {
  const idx = ref.indexOf('/')
  if (idx < 0) return { providerId: '', model: ref }
  return { providerId: ref.slice(0, idx), model: ref.slice(idx + 1) }
}

export function formatRuntimeModelLabel(
  model: string,
  providerId?: string,
  providerName?: string,
): string {
  const value = model.trim()
  if (!value) return model

  const providerLabels = [...new Set([providerId, providerName]
    .map((label) => label?.trim())
    .filter((label): label is string => Boolean(label)))]

  for (const provider of providerLabels) {
    const escaped = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = value.match(new RegExp(`^${escaped}[\\s._:/-]+(.+)$`, 'i'))
    const modelOnly = match?.[1]?.trim()
    if (modelOnly) return modelOnly
  }

  return value
}
