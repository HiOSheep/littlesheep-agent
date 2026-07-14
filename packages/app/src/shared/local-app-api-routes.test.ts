import { describe, expect, it } from 'vitest'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
  matchLocalAppApiItemPath,
} from './local-app-api-routes'

describe('Local App API route catalog', () => {
  it('keeps static routes unique and normalized', () => {
    const routes = Object.values(LOCAL_APP_API_ROUTES)
    expect(new Set(routes).size).toBe(routes.length)
    expect(routes.every((route) => route.startsWith('/') && !route.endsWith('/'))).toBe(true)
  })

  it('keeps dynamic prefixes normalized and encodes item ids', () => {
    const prefixes = Object.values(LOCAL_APP_API_PREFIXES)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    expect(prefixes.every((prefix) => prefix.startsWith('/') && prefix.endsWith('/'))).toBe(true)
    expect(localAppApiItemPath(LOCAL_APP_API_PREFIXES.projects, 'project/a', '/rebind'))
      .toBe('/projects/project%2Fa/rebind')
    expect(matchLocalAppApiItemPath('/projects/project%2Fa/rebind', LOCAL_APP_API_PREFIXES.projects, '/rebind'))
      .toBe('project/a')
    expect(matchLocalAppApiItemPath('/projects/a/extra/rebind', LOCAL_APP_API_PREFIXES.projects, '/rebind'))
      .toBeNull()
  })
})
