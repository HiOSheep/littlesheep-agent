import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { RuntimeProvider, RuntimeState } from '../../shared/runtime-api-contracts'
import { describeRuntimeAvailability } from './runtime-availability'

function provider(overrides: Partial<RuntimeProvider> = {}): RuntimeProvider {
  return {
    id: 'my-gw',
    name: 'My Gateway',
    baseURL: 'https://gw.example.com/v1',
    api: 'openai-chat-completions',
    models: [{ id: 'gw-large', name: 'gw-large', declared: false, reasoningOptions: [] }],
    headerNames: [],
    envVar: 'MY_GW_API_KEY',
    requiresKey: true,
    hasKey: true,
    builtin: false,
    ...overrides,
  }
}

function runtime(providers: RuntimeProvider[]): RuntimeState {
  return {
    model: 'my-gw/gw-large',
    reasoning: 'auto',
    profile: 'general',
    contextCompressionThresholdRatio: 0.8,
    closePolicy: 'background-while-active',
    workspace: 'C:\\work',
    workplace: 'C:\\work',
    providers,
    web: {
      enabled: false,
      status: 'disabled',
      providerConfigured: false,
      readMode: 'disabled',
      dnsResolver: 'system',
      strictReadApproval: false,
      allowDomains: [],
      blockDomains: [],
      cacheEnabled: false,
      cacheTtlSeconds: 0,
      cacheMaxBytes: 0,
      browserFallback: 'disabled',
      sensitiveQueryPolicy: 'approve',
      egress: ['query_to_search_provider', 'url_to_target_site', 'evidence_to_current_llm_provider'],
    },
  }
}

describe('runtime availability', () => {
  it('separates a failed configuration load from a first-run empty state', () => {
    const failed = describeRuntimeAvailability({
      runtime: null,
      runtimeError: 'Local app API error: 500',
      selectableProviderCount: 0,
      hasSelectableModel: false,
    })
    expect(failed).toMatchObject({ kind: 'load-failed', action: 'retry', actionLabel: '重试读取' })
    expect(failed.detail).toContain('Local app API error: 500')

    const loading = describeRuntimeAvailability({
      runtime: null,
      runtimeError: null,
      selectableProviderCount: 0,
      hasSelectableModel: false,
    })
    expect(loading).toMatchObject({ kind: 'loading', action: 'none' })
  })

  it('offers the configuration path when nothing is configured', () => {
    const state = describeRuntimeAvailability({
      runtime: runtime([]),
      runtimeError: null,
      selectableProviderCount: 0,
      hasSelectableModel: false,
    })

    expect(state).toMatchObject({ kind: 'unconfigured', action: 'configure', actionLabel: '配置模型' })
    expect(state.detail).toContain('设置 → 模型供应商')
  })

  it('keeps a saved but unusable provider out of the ready state', () => {
    const customWithoutKey = provider({ hasKey: false, models: [] })
    const state = describeRuntimeAvailability({
      runtime: runtime([customWithoutKey]),
      runtimeError: null,
      selectableProviderCount: 0,
      hasSelectableModel: false,
    })

    expect(state).toMatchObject({ kind: 'unusable', action: 'configure', actionLabel: '检查供应商配置' })
    // A saved key must not read as a verified working connection.
    expect(state.detail).toContain('保存配置不等于已经验证可以调用')
  })

  it('agrees with the provider page about what counts as configured', () => {
    // An unconfigured built-in preset stays in the add-provider picker on the
    // settings page, so the composer must call it "not configured" too — not
    // "configured but broken".
    const builtinWithoutKey = provider({ id: 'openai', builtin: true, hasKey: false })
    const unconfigured = describeRuntimeAvailability({
      runtime: runtime([builtinWithoutKey]),
      runtimeError: null,
      selectableProviderCount: 0,
      hasSelectableModel: false,
    })

    expect(unconfigured.kind).toBe('unconfigured')

    // A configured built-in (key saved) without usable models is the unusable case.
    const configuredWithoutModels = provider({ id: 'openai', builtin: true, hasKey: true, models: [] })
    const unusable = describeRuntimeAvailability({
      runtime: runtime([configuredWithoutModels]),
      runtimeError: null,
      selectableProviderCount: 0,
      hasSelectableModel: false,
    })

    expect(unusable.kind).toBe('unusable')
  })

  it('is ready only with a selectable provider and a resolvable model', () => {
    const ready = describeRuntimeAvailability({
      runtime: runtime([provider()]),
      runtimeError: null,
      selectableProviderCount: 1,
      hasSelectableModel: true,
    })
    expect(ready).toMatchObject({ kind: 'ready', action: 'none', label: '' })

    // Providers exist but the selected model cannot be resolved: not ready.
    const unresolved = describeRuntimeAvailability({
      runtime: runtime([provider()]),
      runtimeError: null,
      selectableProviderCount: 1,
      hasSelectableModel: false,
    })
    expect(unresolved.kind).toBe('unusable')
  })
})

describe('runtime availability wiring', () => {
  it('offers the action inside the empty picker menu instead of only a title', async () => {
    const picker = await readFile(new URL('./runtime-picker.tsx', import.meta.url), 'utf8')

    expect(picker).toContain('describeRuntimeAvailability({')
    expect(picker).toContain('runtime-configure-action')
    expect(picker).toContain('if (availability.action === \'retry\') onRetryModelConfig()')
    expect(picker).toContain('else onConfigureModel()')
    expect(picker).toContain("title={availability.kind === 'ready' ? undefined : availability.detail}")
    // The empty menu has to stay openable, or the action is unreachable.
    expect(picker).not.toContain('setOpen(false)\n      return')
  })

  it('opens the provider settings without dropping the current draft', async () => {
    const [composer, controller] = await Promise.all([
      readFile(new URL('../app-shell/composer-view.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../app-shell/use-app-controller.ts', import.meta.url), 'utf8'),
    ])

    expect(composer).toContain("onConfigureModel={() => openSettingsPage('api')}")
    expect(composer).toContain('onRetryModelConfig={refreshRuntime}')
    // Only a route change: the composer text and attachments are untouched.
    expect(composer).not.toMatch(/onConfigureModel=\{[\s\S]{0,80}setInput/u)
    // Returning from settings re-reads the Runtime, so a saved provider shows up.
    expect(controller).toMatch(/wasSettingsOpenRef\.current && !settingsOpen\) void refreshRuntime\(\)/u)
  })
})
