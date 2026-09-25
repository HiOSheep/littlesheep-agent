import { describe, expect, it } from 'vitest'
import { describeFileMode, diffMetadataLabel, diffMetadataValue } from './review-diff-metadata'

describe('review diff metadata labels', () => {
  it('names the extended headers a person reads', () => {
    expect(diffMetadataLabel('rename from')).toBe('重命名自')
    expect(diffMetadataLabel('rename to')).toBe('重命名为')
    expect(diffMetadataLabel('similarity index')).toBe('相似度')
    // An unknown key stays as Git printed it rather than disappearing.
    expect(diffMetadataLabel('something new')).toBe('something new')
  })

  it('explains a mode number next to the raw value', () => {
    expect(diffMetadataValue({ key: 'new mode', value: '100755' })).toBe('100755（可执行文件）')
    expect(diffMetadataValue({ key: 'old mode', value: '100644' })).toBe('100644（普通文件）')
    // A mode the table does not know stays raw, without a made-up explanation.
    expect(diffMetadataValue({ key: 'new mode', value: '100777' })).toBe('100777')
  })

  it('leaves path values untouched', () => {
    expect(diffMetadataValue({ key: 'rename to', value: 'src/app.ts' })).toBe('src/app.ts')
    expect(diffMetadataValue({ key: 'similarity index', value: '100%' })).toBe('100%')
  })

  it('describes the modes Git documents', () => {
    expect(describeFileMode('100644')).toBe('普通文件')
    expect(describeFileMode('100755')).toBe('可执行文件')
    expect(describeFileMode('120000')).toBe('符号链接')
    expect(describeFileMode('160000')).toBe('子模块')
    expect(describeFileMode('100000')).toBeNull()
  })
})
