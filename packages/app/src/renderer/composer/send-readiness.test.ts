import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { RuntimeAvailability } from './runtime-availability'
import { describeComposerSendReadiness } from './send-readiness'

function availability(overrides: Partial<RuntimeAvailability> = {}): RuntimeAvailability {
  return {
    kind: 'ready',
    label: '',
    detail: '',
    action: 'none',
    actionLabel: '',
    ...overrides,
  }
}

const unconfigured = availability({
  kind: 'unconfigured',
  label: '还没有配置模型',
  detail: '还没有配置任何供应商；在 设置 → 模型供应商 里添加服务、密钥和模型。',
  action: 'configure',
  actionLabel: '配置模型',
})

describe('composer send readiness', () => {
  it('sends when the Runtime is ready and a usable model is selected', () => {
    const readiness = describeComposerSendReadiness({ availability: availability(), executionReason: null })
    expect(readiness).toMatchObject({ blocked: false, reason: null, executionReason: null, modelReason: null })
  })

  it('refuses to send with no model configured, and says what to do', () => {
    // The measured case: the default model ref pointed at a provider with no key
    // and the run streamed nothing for over a minute.
    const readiness = describeComposerSendReadiness({ availability: unconfigured, executionReason: null })
    expect(readiness.blocked).toBe(true)
    expect(readiness.modelReason).toContain('设置 → 模型供应商')
    expect(readiness.reason).toBe(readiness.modelReason)
    expect(readiness.action).toBe('configure')
    expect(readiness.actionLabel).toBe('配置模型')
  })

  it('refuses while the configuration has not been read yet', () => {
    // The composer renders before the Runtime answers; until then "a usable model
    // is selected" is not a fact, and the default ref is the unusable one.
    const readiness = describeComposerSendReadiness({
      availability: availability({ kind: 'loading', label: '正在读取模型配置', detail: '正在读取模型配置，完成后这里会显示可用模型。' }),
      executionReason: null,
    })
    expect(readiness.blocked).toBe(true)
  })

  it('refuses while execution itself is unavailable, and keeps that as the reason', () => {
    const readiness = describeComposerSendReadiness({
      availability: unconfigured,
      executionReason: '正在准备运行能力',
    })
    expect(readiness.blocked).toBe(true)
    // The Runtime's readiness owns the control while it is unavailable; the model
    // reason waits behind it instead of competing for the same row.
    expect(readiness.reason).toBe('正在准备运行能力')
    expect(readiness.executionReason).toBe('正在准备运行能力')
    expect(readiness.modelReason).toContain('设置 → 模型供应商')
  })

  it('keeps the fix a saved-but-unusable provider needs', () => {
    const readiness = describeComposerSendReadiness({
      availability: availability({
        kind: 'unusable',
        detail: '供应商已保存，但还没有可选择的模型：可能缺少 API 密钥，或没有填写模型条目。保存配置不等于已经验证可以调用。',
        action: 'configure',
        actionLabel: '检查供应商配置',
      }),
      executionReason: null,
    })
    expect(readiness.blocked).toBe(true)
    expect(readiness.actionLabel).toBe('检查供应商配置')
  })

  it('keeps the pending-selection case out of the provider page', () => {
    const readiness = describeComposerSendReadiness({
      availability: availability({
        kind: 'no-selection',
        label: '还没有选择模型',
        detail: '供应商已经可以使用；打开这个菜单选一个模型。',
        action: 'none',
        actionLabel: '',
      }),
      executionReason: null,
    })
    expect(readiness.blocked).toBe(true)
    expect(readiness.action).toBe('none')
    expect(readiness.reason).toContain('选一个模型')
  })
})

describe('send entry wiring', () => {
  it('refuses both entries and states the reason next to them', async () => {
    const [composer, chat] = await Promise.all([
      readFile(new URL('../app-shell/composer-view.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../app-shell/chat-view.tsx', import.meta.url), 'utf8'),
    ])

    // The button and Enter are the same entry: neither may dispatch past the gate.
    expect(composer).toContain('disabled={sendReadiness.blocked || (!loading && !hasPendingInput)}')
    expect(composer).toContain('if (sendReadiness.blocked) return')
    expect(composer).toContain('aria-label={sendReadiness.reason ?? sendTip}')
    // A disabled control never says why, so the reason has its own inline surface.
    expect(composer).toContain('<ComposerSendBlockNotice')
    expect(composer).toContain('modelReason={sendReadiness.modelReason}')
    // The empty conversation is where the user is most likely to try, so it
    // states the same fact instead of inviting a send that cannot run.
    expect(chat).toContain('describeComposerSendReadiness({')
    expect(chat).toContain('{emptyCopy}')
  })
})
