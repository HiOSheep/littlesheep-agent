// Definitions for runtimes and toolchains that LittleSheep can manage.

import type {
  DevelopmentEnvironmentId,
  DevelopmentEnvironmentInfo,
} from '../shared/development-environment-contracts.js'

export interface EnvironmentDefinition {
  id: DevelopmentEnvironmentId
  label: string
  description: string
  category: DevelopmentEnvironmentInfo['category']
  executableNames: string[]
  managedCandidates: string[]
  versionArgs: string[]
  builtin?: boolean
}

export const ENVIRONMENT_DEFINITIONS: readonly EnvironmentDefinition[] = [
  {
    id: 'node',
    label: 'Node.js',
    description: 'JavaScript/TypeScript 运行时；LS 使用当前 Electron 内置 Node。',
    category: 'runtime',
    executableNames: ['node'],
    managedCandidates: ['node.exe', 'node.cmd', 'bin/node.exe', 'bin/node', 'node'],
    versionArgs: ['--version'],
    builtin: true,
  },
  {
    id: 'python',
    label: 'Python',
    description: 'Python 解释器与常用脚本工具。',
    category: 'runtime',
    executableNames: ['python', 'python3'],
    managedCandidates: ['python.exe', 'python', 'bin/python.exe', 'bin/python'],
    versionArgs: ['--version'],
  },
  {
    id: 'java',
    label: 'Java / JDK',
    description: 'Java 虚拟机和 JDK 开发工具。',
    category: 'runtime',
    executableNames: ['java'],
    managedCandidates: ['bin/java.exe', 'bin/java'],
    versionArgs: ['-version'],
  },
  {
    id: 'go',
    label: 'Go',
    description: 'Go 编译器、格式化和模块工具。',
    category: 'compiler',
    executableNames: ['go'],
    managedCandidates: ['bin/go.exe', 'bin/go'],
    versionArgs: ['version'],
  },
  {
    id: 'rust',
    label: 'Rust',
    description: 'Rust 编译器和 Cargo 工具链。',
    category: 'compiler',
    executableNames: ['rustc'],
    managedCandidates: ['bin/rustc.exe', 'bin/rustc'],
    versionArgs: ['--version'],
  },
  {
    id: 'cpp',
    label: 'C / C++',
    description: 'C/C++ 编译器工具链；支持 LLVM 或 GNU 风格目录。',
    category: 'compiler',
    executableNames: ['clang', 'gcc', 'cl'],
    managedCandidates: ['bin/clang.exe', 'bin/clang', 'bin/gcc.exe', 'bin/gcc', 'bin/cl.exe'],
    versionArgs: ['--version'],
  },
  {
    id: 'dotnet',
    label: '.NET',
    description: '.NET SDK、运行时和 dotnet CLI。',
    category: 'runtime',
    executableNames: ['dotnet'],
    managedCandidates: ['dotnet.exe', 'dotnet'],
    versionArgs: ['--version'],
  },
  {
    id: 'ruby',
    label: 'Ruby',
    description: 'Ruby 解释器与 Bundler 工具。',
    category: 'runtime',
    executableNames: ['ruby'],
    managedCandidates: ['ruby.exe', 'ruby', 'bin/ruby.exe', 'bin/ruby'],
    versionArgs: ['--version'],
  },
  {
    id: 'php',
    label: 'PHP',
    description: 'PHP CLI 运行时。',
    category: 'runtime',
    executableNames: ['php'],
    managedCandidates: ['php.exe', 'php', 'bin/php.exe', 'bin/php'],
    versionArgs: ['--version'],
  },
  {
    id: 'git',
    label: 'Git',
    description: '版本控制和 LS 工作区回退所需的 Git 客户端。',
    category: 'tooling',
    executableNames: ['git'],
    managedCandidates: ['cmd/git.exe', 'bin/git.exe', 'cmd/git', 'bin/git'],
    versionArgs: ['--version'],
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    description: 'Windows 默认终端；LS 会保留宿主 PowerShell 作为系统降级。',
    category: 'tooling',
    executableNames: ['pwsh', 'powershell'],
    managedCandidates: ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'],
    versionArgs: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  },
]

export const DEFINITION_BY_ID = new Map(
  ENVIRONMENT_DEFINITIONS.map((definition) => [definition.id, definition]),
)

export function developmentEnvironmentLabel(id: string): string {
  return ENVIRONMENT_DEFINITIONS.find((definition) => definition.id === id)?.label ?? id
}
