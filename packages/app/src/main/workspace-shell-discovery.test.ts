// UX-29: shell discovery must be honest about what this machine can actually run.
//
// The injectable file/WSL seams cover every branch deterministically; the last test runs the
// real discovery on the machine and asserts only invariants that hold wherever it runs.
import { describe, expect, it } from 'vitest'
import {
  cmdArgs,
  defaultWorkspaceShellProfile,
  discoverWorkspaceShells,
  findWorkspaceShellProfile,
  gitBashArgs,
  isGitBashPath,
  powershellArgs,
  wslArgs,
} from './workspace-shell-discovery'

const WINDOWS_ENV: NodeJS.ProcessEnv = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  PATH: 'C:\\Windows\\System32;C:\\Program Files\\Git\\bin',
}

function discovery(options: {
  files?: string[]
  distros?: string[]
  env?: NodeJS.ProcessEnv
}) {
  const files = new Set((options.files ?? []).map((path) => path.toLowerCase()))
  return discoverWorkspaceShells({
    platform: 'win32',
    env: options.env ?? WINDOWS_ENV,
    fileExists: (path) => files.has(path.toLowerCase()),
    listWslDistributions: async () => options.distros ?? [],
  })
}

describe('workspace shell discovery', () => {
  it('offers PowerShell 7, Windows PowerShell and cmd when they exist', async () => {
    const profiles = await discovery({
      files: [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'C:\\Windows\\System32\\cmd.exe',
      ],
    })
    const byId = new Map(profiles.map((profile) => [profile.id, profile]))

    expect(byId.get('powershell-7')).toMatchObject({ available: true, label: 'PowerShell 7' })
    expect(byId.get('windows-powershell')).toMatchObject({ available: true })
    expect(byId.get('cmd')).toMatchObject({ available: true })
    expect(byId.get('powershell-7')?.args).toEqual(powershellArgs())
    expect(byId.get('cmd')?.args).toEqual(cmdArgs())
  })

  it('keeps a missing shell in the list with a reason and a configuration path', async () => {
    const profiles = await discovery({ files: ['C:\\Windows\\System32\\cmd.exe'] })
    const powershell7 = profiles.find((profile) => profile.id === 'powershell-7')

    expect(powershell7).toMatchObject({ available: false })
    expect(powershell7?.reason).toContain('pwsh.exe')
    expect(powershell7?.configHint).toContain('PowerShell 7')
    // Unavailable profiles never carry an executable to run by accident.
    expect(powershell7?.executable).toBeUndefined()
  })

  it('never mistakes the WSL launcher in System32 for Git Bash', async () => {
    const profiles = await discovery({
      files: ['C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\System32\\cmd.exe'],
      env: { ...WINDOWS_ENV, PATH: 'C:\\Windows\\System32' },
    })
    const gitBash = profiles.find((profile) => profile.id === 'git-bash')

    expect(gitBash).toMatchObject({ available: false })
    expect(gitBash?.reason).toContain('WSL')
    expect(isGitBashPath('C:\\Windows\\System32\\bash.exe')).toBe(false)
  })

  it('accepts a real Git for Windows bash and gives it bash arguments', async () => {
    const profiles = await discovery({
      files: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\cmd.exe'],
    })
    const gitBash = profiles.find((profile) => profile.id === 'git-bash')

    expect(gitBash).toMatchObject({
      available: true,
      executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
    })
    expect(gitBash?.args).toEqual(gitBashArgs())
    expect(gitBash?.args).not.toEqual(powershellArgs())
    expect(isGitBashPath('C:\\Program Files\\Git\\usr\\bin\\bash.exe')).toBe(true)
  })

  it('lists one entry per real WSL distribution and says so when there are none', async () => {
    const withDistros = await discovery({ files: [], distros: ['Ubuntu', 'Debian'] })
    const wslProfiles = withDistros.filter((profile) => profile.kind === 'wsl')

    expect(wslProfiles.map((profile) => profile.id)).toEqual(['wsl:Ubuntu', 'wsl:Debian'])
    expect(wslProfiles.every((profile) => profile.available)).toBe(true)
    expect(wslProfiles[0]?.label).toBe('WSL · Ubuntu')
    expect(wslProfiles[0]?.args).toEqual(wslArgs('Ubuntu'))

    const withoutDistros = await discovery({ files: [], distros: [] })
    const wsl = withoutDistros.find((profile) => profile.kind === 'wsl')
    expect(wsl).toMatchObject({ id: 'wsl', available: false })
    expect(wsl?.configHint).toContain('wsl --install')
  })

  it('validates the id the renderer sends back and picks a sane default', async () => {
    const profiles = await discovery({
      files: [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Windows\\System32\\cmd.exe',
      ],
      distros: ['Ubuntu'],
    })

    expect(findWorkspaceShellProfile(profiles, 'powershell-7')?.label).toBe('PowerShell 7')
    // Unavailable or unknown ids are refused rather than run.
    expect(findWorkspaceShellProfile(profiles, 'git-bash')).toBeNull()
    expect(findWorkspaceShellProfile(profiles, 'rm -rf /')).toBeNull()
    expect(findWorkspaceShellProfile(profiles, 42)).toBeNull()
    expect(defaultWorkspaceShellProfile(profiles)?.id).toBe('powershell-7')

    const noPwsh = await discovery({ files: ['C:\\Windows\\System32\\cmd.exe'] })
    expect(defaultWorkspaceShellProfile(noPwsh)?.id).toBe('cmd')
  })

  it('describes this machine truthfully', async () => {
    const profiles = await discoverWorkspaceShells()
    const byId = new Map(profiles.map((profile) => [profile.id, profile]))

    // Whatever is available must carry an executable and arguments as arrays, never a string.
    for (const profile of profiles) {
      if (!profile.available) {
        expect(profile.reason, `${profile.id} needs a reason`).toBeTruthy()
        continue
      }
      expect(profile.executable, `${profile.id} needs an executable`).toBeTruthy()
      expect(Array.isArray(profile.args)).toBe(true)
    }
    // Git Bash is only ever a Git-owned bash, and a default shell always exists on Windows.
    const gitBash = byId.get('git-bash')
    if (gitBash?.executable) expect(isGitBashPath(gitBash.executable)).toBe(true)
    expect(defaultWorkspaceShellProfile(profiles)).not.toBeNull()
  }, 30_000)
})
