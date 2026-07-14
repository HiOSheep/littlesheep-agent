import { z } from 'zod'
import type { AgentTool } from '@littlesheep/types'
import type { ChannelPluginFactory } from './channel/types.js'

export const PLUGIN_API_VERSION = 1 as const

export const PluginCapabilitySchema = z.enum([
  'channel',
  'tool',
  'skill',
])

export const PluginPermissionSchema = z.enum([
  'agent:run',
  'channels:register',
  'tools:register',
  'skills:register',
  'network',
  'process',
  'secrets',
  'filesystem:plugin-data',
  'filesystem:workspace',
])

export const PluginContributionsSchema = z.object({
  channels: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string().min(1)).default([]),
}).default({})

export const PluginActivationEventSchema = z.union([
  z.literal('onStartup'),
  z.string().regex(/^onChannel:[a-z0-9][a-z0-9._-]*$/),
])

export const PluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.literal(PLUGIN_API_VERSION),
  description: z.string().default(''),
  publisher: z.string().optional(),
  capabilities: z.array(PluginCapabilitySchema).min(1),
  permissions: z.array(PluginPermissionSchema).default([]),
  activationEvents: z.array(PluginActivationEventSchema).min(1).default(['onStartup']),
  contributes: PluginContributionsSchema,
  /** Local plugins resolve this path relative to their manifest directory. */
  main: z.string().min(1).optional(),
}).superRefine((manifest, ctx) => {
  validateUnique(manifest.capabilities, 'capabilities', ctx)
  validateUnique(manifest.permissions, 'permissions', ctx)
  validateUnique(manifest.activationEvents, 'activationEvents', ctx)
  validateUnique(manifest.contributes.channels, 'contributes.channels', ctx)
  validateUnique(manifest.contributes.tools, 'contributes.tools', ctx)
  validateUnique(manifest.contributes.skills, 'contributes.skills', ctx)

  const declaresChannels = manifest.contributes.channels.length > 0
  const declaresTools = manifest.contributes.tools.length > 0
  const declaresSkills = manifest.contributes.skills.length > 0

  if (declaresChannels && !manifest.capabilities.includes('channel')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'channel contributions require capability "channel"' })
  }
  if (declaresChannels && !manifest.permissions.includes('channels:register')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'channel contributions require permission "channels:register"' })
  }
  if (manifest.capabilities.includes('channel') && !declaresChannels) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'capability "channel" requires at least one channel contribution' })
  }
  if (declaresTools && !manifest.capabilities.includes('tool')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool contributions require capability "tool"' })
  }
  if (declaresTools && !manifest.permissions.includes('tools:register')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool contributions require permission "tools:register"' })
  }
  if (manifest.capabilities.includes('tool') && !declaresTools) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'capability "tool" requires at least one tool contribution' })
  }
  if (declaresSkills && !manifest.capabilities.includes('skill')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'skill contributions require capability "skill"' })
  }
  if (declaresSkills && !manifest.permissions.includes('skills:register')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'skill contributions require permission "skills:register"' })
  }
  if (manifest.capabilities.includes('skill') && !declaresSkills) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'capability "skill" requires at least one skill contribution' })
  }

  const startsWithHost = manifest.activationEvents.includes('onStartup')
  for (const channelType of manifest.contributes.channels) {
    if (!startsWithHost && !manifest.activationEvents.includes(`onChannel:${channelType}`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `channel contribution "${channelType}" has no reachable activation event`,
      })
    }
  }
  if (declaresTools && !declaresChannels && !startsWithHost) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'tool-only plugins must activate onStartup',
    })
  }
  if (declaresSkills && !startsWithHost) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'plugins that contribute skills must activate onStartup',
    })
  }
})

export type PluginCapability = z.infer<typeof PluginCapabilitySchema>
export type PluginPermission = z.infer<typeof PluginPermissionSchema>
export type PluginManifest = z.infer<typeof PluginManifestSchema>

export interface PluginDisposable {
  dispose(): void | Promise<void>
}

export interface PluginActivationContext {
  readonly pluginId: string
  readonly dataDir: string
  registerChannelType(type: string, factory: ChannelPluginFactory): PluginDisposable
  registerTool(tool: AgentTool): PluginDisposable
  log(level: 'info' | 'warn' | 'error', message: string): void
}

export interface LittleSheepPlugin {
  readonly manifest: PluginManifest
  activate(context: PluginActivationContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

export interface PluginSource {
  readonly kind: 'builtin' | 'local'
  readonly manifest: PluginManifest
  readonly location?: string
  load(): Promise<LittleSheepPlugin>
}

export type PluginRuntimeState = 'disabled' | 'inactive' | 'activating' | 'active' | 'blocked' | 'failed'

export interface PluginStatus {
  id: string
  name: string
  version: string
  description: string
  publisher?: string
  source: PluginSource['kind']
  location?: string
  enabled: boolean
  state: PluginRuntimeState
  capabilities: PluginCapability[]
  permissions: PluginPermission[]
  activationEvents: string[]
  contributes: PluginManifest['contributes']
  error?: string
}

export interface PluginDiagnostic {
  source: string
  message: string
}

export function parsePluginManifest(input: unknown): PluginManifest {
  return PluginManifestSchema.parse(input)
}

export function pluginManifestsMatch(expected: PluginManifest, actual: PluginManifest): boolean {
  const { main: _expectedMain, ...expectedRuntime } = expected
  const { main: _actualMain, ...actualRuntime } = actual
  return JSON.stringify(expectedRuntime) === JSON.stringify(actualRuntime)
}

function validateUnique(
  values: readonly string[],
  field: string,
  ctx: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must not contain duplicates` })
  }
}
