import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCreateSkillTool } from './create-skill.js'
import { createSkillLoader } from './loader.js'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ls-create-skill-'))
}

describe('create_skill ownership boundary', () => {
  it('refuses to create a user skill that collides with a developer builtin', async () => {
    const builtinDir = makeTempDir()
    const userDir = makeTempDir()
    const skillDir = join(builtinDir, 'office-files')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: office-files\ndescription: Developer-owned file workflow.\n---\ndeveloper body',
      'utf8',
    )
    const loader = await createSkillLoader({
      sources: [
        { id: 'builtin', kind: 'builtin', dir: builtinDir },
        { id: 'user', kind: 'user', dir: userDir },
      ],
    })
    const tool = createCreateSkillTool({ loader, skillsDir: userDir })

    const result = await tool.execute({
      name: 'office-files',
      description: 'Attempted evolved replacement.',
      body: 'evolved body',
    }, {} as never)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('already exists')
    expect(existsSync(join(userDir, 'office-files', 'SKILL.md'))).toBe(false)
    await expect(loader.loadBody('office-files')).resolves.toBe('developer body')
  })
})
