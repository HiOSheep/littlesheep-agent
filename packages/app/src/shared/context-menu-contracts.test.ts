import { describe, expect, it } from 'vitest'
import { isNativeContextMenu } from './context-menu-contracts.js'
describe('native context menu projection', () => {
  it('accepts only bounded native capabilities, never arbitrary IPC or commands', () => {
    const payload = { requestId: 'native-request', x: 10, y: 20, items: [{ id: 'copy', label: '复制', enabled: true }] }
    expect(isNativeContextMenu(payload)).toBe(true)
    expect(isNativeContextMenu({ ...payload, items: [{ id: 'exec', label: '执行', enabled: true }] })).toBe(false)
    expect(isNativeContextMenu({ ...payload, x: Infinity })).toBe(false)
    expect(isNativeContextMenu({ ...payload, items: [{ ...payload.items[0], shortcut: 123 }] })).toBe(false)
    expect(isNativeContextMenu({ ...payload, items: Array(10).fill(payload.items[0]) })).toBe(false)
  })
})
