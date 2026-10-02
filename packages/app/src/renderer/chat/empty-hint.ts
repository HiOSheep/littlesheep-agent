// What an empty conversation says (UX-8).
//
// One line of product copy is the same sentence for every reader on every day, so the empty state
// now has a handful to draw from: the greeting is chosen from the conversation itself and stays the
// same while that conversation is open. Kept in its own module so the wording is reviewable in one
// place, and so `chat-view.tsx` stays a coordinator.
//
// These are static interface strings — not agent replies. Nothing here speaks for the model, and no
// entry promises what a run will do.

export interface EmptyHint {
  title: string
  copy: string
}

export const EMPTY_HINTS: readonly EmptyHint[] = [
  {
    title: '今天要推进什么？',
    copy: '对话还是空的。想到什么就写下来吧，剩下的我来接。',
  },
  {
    title: '先从哪儿开始？',
    copy: '没有消息也没关系。随便说一句都行——一句话往往就够我开工了。',
  },
  {
    title: '有什么想做的吗？',
    copy: '写下你现在最想解决的那件事，哪怕只想了一半。',
  },
  {
    title: '今天想搞定什么？',
    copy: '空白说明还没被打扰。把目标丢进来，我来接住。',
  },
  {
    title: '我们做点什么？',
    copy: '不用写得很正式：「帮我看看 X」就是很好的开始。',
  },
  {
    title: '今天的目标是什么？',
    copy: '有想法、有文件，或者只有一点模糊的念头，都可以直接发给我。',
  },
]

/**
 * The hint for one conversation.
 *
 * Seeded rather than random so the line does not change under the reader's eyes on a re-render:
 * the same seed always answers with the same entry, and a new conversation gets a new seed.
 */
export function emptyHintFor(seed: string): EmptyHint {
  let hash = 0
  for (const character of seed) hash = (hash * 31 + character.codePointAt(0)!) % 100_000
  return EMPTY_HINTS[hash % EMPTY_HINTS.length]!
}
