import { describe, expect, it } from 'vitest'
import { StreamingMarkdownPartitioner } from './streaming-markdown'

describe('streaming Markdown partitioner', () => {
  it('freezes completed blocks and keeps only the unstable tail live', () => {
    const partitioner = new StreamingMarkdownPartitioner()
    const first = partitioner.update('# One\n\nA\n\n## Two\n\nB\n\n## Three\n\nC')

    expect(first.frozen).toHaveLength(1)
    expect(first.frozen[0]?.source).toContain('## Two')
    expect(first.tail).toContain('## Three')
    expect(first.tail).not.toContain('## Two')

    const originalFrozen = first.frozen[0]
    const next = partitioner.update('# One\n\nA\n\n## Two\n\nB\n\n## Three\n\nC\n\nMore')

    expect(next.frozen[0]).toBe(originalFrozen)
    expect(next.tail).toContain('More')
  })

  it('resets frozen blocks when a provisional answer is replaced', () => {
    const partitioner = new StreamingMarkdownPartitioner()
    partitioner.update('A\n\nB\n\nC\n\nD')

    const replaced = partitioner.update('Replacement answer')

    expect(replaced.frozen).toEqual([])
    expect(replaced.tail).toBe('Replacement answer')
  })

  it('keeps an incomplete fenced block in the reparsed tail', () => {
    const partitioner = new StreamingMarkdownPartitioner()
    const partition = partitioner.update('Intro\n\n```ts\nconst value = 1')

    expect(partition.frozen).toEqual([])
    expect(partition.tail).toContain('```ts')
  })

  it('keeps a long settled prefix out of subsequent live-tail parses', () => {
    const partitioner = new StreamingMarkdownPartitioner()
    const source = Array.from({ length: 240 }, (_, index) => `## Block ${index}\n\nValue ${index}`).join('\n\n')
    const first = partitioner.update(source)

    expect(first.frozen.length).toBeGreaterThan(0)
    expect(first.tail.length).toBeLessThan(source.length / 10)
    const stablePrefix = first.frozen[0]

    const next = partitioner.update(`${source}\n\nOne more live paragraph`)

    expect(next.frozen[0]).toBe(stablePrefix)
    expect(next.tail.length).toBeLessThan(source.length / 10)
  })
})
