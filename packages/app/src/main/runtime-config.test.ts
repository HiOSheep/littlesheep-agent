// @littlesheep/app — runtime-config.test.ts

import { describe, expect, it } from 'vitest'
import { resolveRuntimeWorkspaceDefault } from './runtime-config.js'

describe('resolveRuntimeWorkspaceDefault', () => {
  const workplace = 'C:\\Users\\me\\.littlesheep\\workplace'
  const cwd = 'D:\\workspace\\littlesheep'

  it('uses the LittleSheep workplace when config has no workspace', () => {
    expect(resolveRuntimeWorkspaceDefault('', workplace, cwd)).toEqual({
      workspace: workplace,
      migrated: true,
    })
  })

  it('uses the LittleSheep workplace when config still points at process cwd', () => {
    expect(resolveRuntimeWorkspaceDefault('D:/workspace/littlesheep/', workplace, cwd)).toEqual({
      workspace: workplace,
      migrated: true,
    })
  })

  it('migrates a retired hidden application workspace', () => {
    expect(resolveRuntimeWorkspaceDefault('C:/Users/me/.legacy-app/workspace', workplace, cwd)).toEqual({
      workspace: workplace,
      migrated: true,
    })
  })

  it('keeps a LittleSheep workspace path', () => {
    const selected = 'C:/Users/me/.littlesheep/workspace'
    expect(resolveRuntimeWorkspaceDefault(selected, workplace, cwd)).toEqual({
      workspace: selected,
      migrated: false,
    })
  })

  it('keeps an explicit user-selected project workspace', () => {
    const selected = 'D:\\projects\\client-app'
    expect(resolveRuntimeWorkspaceDefault(selected, workplace, cwd)).toEqual({
      workspace: selected,
      migrated: false,
    })
  })
})
