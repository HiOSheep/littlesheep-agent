import { describe, expect, it } from 'vitest'
import { conversationResources } from './conversation-resources'

describe('conversation resources', () => {
  it('keeps sources separate from produced files and deduplicates Windows path variants', () => {
    const result = conversationResources([
      { role: 'user', text: '', attachments: [{ path: 'C:/work/source.txt', name: 'source.txt', kind: 'file' }] },
      { role: 'assistant', text: '', artifacts: [{ path: 'C:/work/result.txt', name: 'result.txt', action: 'created' }, { path: 'C:/work/read.txt', name: 'read.txt', action: 'attached' }] },
      { role: 'assistant', text: '', artifacts: [{ path: 'c:\\work\\RESULT.txt', name: 'updated.txt', action: 'modified' }] },
    ], [{ path: 'c:\\work\\SOURCE.txt', name: 'source.txt', kind: 'file' }])
    expect(result.outputs).toEqual([{ path: 'c:\\work\\RESULT.txt', name: 'updated.txt', action: 'modified' }])
    expect(result.sources.map(file => file.name)).toEqual(['source.txt', 'read.txt'])
  })

  it('does not turn ordinary message text or failed tool calls into file outputs', () => {
    expect(conversationResources([{ role: 'assistant', text: 'Created C:/work/claimed.txt', toolCalls: [{ name: 'write', input: { path: 'C:/work/failed.txt' }, ok: false }] }], [])).toEqual({ outputs: [], sources: [] })
  })
})
