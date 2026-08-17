import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  APP_CONTROLLER_VIEW_FIELDS,
  projectAppController,
} from './app-controller-projections'
import type { AppController } from './use-app-controller'

describe('AppController view projections', () => {
  it('copies only the fields declared for each view boundary', () => {
    const controller = new Proxy({}, {
      get: (_target, field) => field,
    }) as AppController
    const projected = projectAppController(controller)

    expectScalarKeys(projected, APP_CONTROLLER_VIEW_FIELDS.app, ['coreWorkspace', 'overlays', 'sidebar'])
    expectScalarKeys(projected.sidebar, APP_CONTROLLER_VIEW_FIELDS.sidebar, ['conversation', 'resizer'])
    expectScalarKeys(projected.sidebar.conversation, APP_CONTROLLER_VIEW_FIELDS.conversation)
    expectScalarKeys(projected.sidebar.resizer, APP_CONTROLLER_VIEW_FIELDS.sidebarResizer)
    expectScalarKeys(projected.coreWorkspace, APP_CONTROLLER_VIEW_FIELDS.coreWorkspace, [
      'chat',
      'composer',
      'workspaceDock',
    ])
    expectScalarKeys(projected.coreWorkspace.chat, APP_CONTROLLER_VIEW_FIELDS.chat)
    expectScalarKeys(projected.coreWorkspace.composer, APP_CONTROLLER_VIEW_FIELDS.composer)
    expectScalarKeys(projected.coreWorkspace.workspaceDock, APP_CONTROLLER_VIEW_FIELDS.workspaceDock)
    expectScalarKeys(projected.overlays, APP_CONTROLLER_VIEW_FIELDS.overlays)
  })

  it('keeps complete AppController imports out of renderer views', () => {
    const viewFiles = [
      'app-view.tsx',
      'chat-view.tsx',
      'composer-view.tsx',
      'conversation-section-view.tsx',
      'core-workspace-view.tsx',
      'overlays-view.tsx',
      'sidebar-resizer-view.tsx',
      'sidebar-view.tsx',
      'workspace-dock-view.tsx',
    ]

    for (const file of viewFiles) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, file).not.toContain('AppController')
    }
  })
})

function expectScalarKeys(
  projection: object,
  expected: readonly string[],
  nested: readonly string[] = [],
): void {
  expect(Object.keys(projection).sort()).toEqual([...expected, ...nested].sort())
  for (const field of expected) {
    expect((projection as Record<string, unknown>)[field]).toBe(field)
  }
}
