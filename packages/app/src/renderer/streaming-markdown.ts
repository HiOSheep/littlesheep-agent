import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const UNSTABLE_TAIL_BLOCKS = 2
const parser = unified().use(remarkParse).use(remarkGfm)

interface PositionedNode {
  position?: {
    end?: { offset?: number }
  }
}

interface ParsedRoot {
  children: PositionedNode[]
}

export interface FrozenMarkdownSegment {
  key: string
  source: string
}

export interface StreamingMarkdownPartition {
  frozen: readonly FrozenMarkdownSegment[]
  tail: string
}

/**
 * Append-only Markdown partitioner. Completed top-level blocks are frozen,
 * leaving only the last two blocks to be reparsed while provider text grows.
 */
export class StreamingMarkdownPartitioner {
  private generation = 0
  private frozen: FrozenMarkdownSegment[] = []
  private frozenOffset = 0
  private previousText = ''
  private snapshot: StreamingMarkdownPartition = { frozen: this.frozen, tail: '' }

  update(text: string): StreamingMarkdownPartition {
    if (text === this.previousText) return this.snapshot
    if (!text.startsWith(this.previousText) || text.length < this.frozenOffset) this.reset()

    const sourceTail = text.slice(this.frozenOffset)
    const root = parser.parse(sourceTail) as ParsedRoot
    const freezeIndex = root.children.length - UNSTABLE_TAIL_BLOCKS - 1
    const stableEnd = freezeIndex >= 0
      ? root.children[freezeIndex]?.position?.end?.offset
      : undefined

    if (
      typeof stableEnd === 'number'
      && stableEnd > 0
      && stableEnd <= sourceTail.length
    ) {
      const start = this.frozenOffset
      const end = start + stableEnd
      this.frozen = [
        ...this.frozen,
        {
          key: `${this.generation}:${start}:${end}`,
          source: sourceTail.slice(0, stableEnd),
        },
      ]
      this.frozenOffset = end
    }

    this.previousText = text
    this.snapshot = {
      frozen: this.frozen,
      tail: text.slice(this.frozenOffset),
    }
    return this.snapshot
  }

  private reset(): void {
    this.generation += 1
    this.frozen = []
    this.frozenOffset = 0
    this.previousText = ''
    this.snapshot = { frozen: this.frozen, tail: '' }
  }
}
