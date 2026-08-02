import { timingSafeEqual } from 'node:crypto'

/** Constant-time comparison for startup-scoped loopback control tokens. */
export function hasBearerToken(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}
