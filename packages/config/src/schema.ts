// @littlesheep/config — schema.ts
// Zod schema for the full LittleSheep config.
//
// Config file location: ~/.littlesheep/config.json (or LITTLESHEEP_CONFIG env).
// The schema is LittleSheep-owned and versioned with the runtime.

import { z } from 'zod';

/** A model provider (OpenAI-compatible API). */
export const ModelProviderSchema = z.object({
  /** Provider id (e.g. "openai", "openrouter", "ollama"). */
  id: z.string(),
  /** Display name. */
  name: z.string().optional(),
  /** API base URL. */
  baseURL: z.string().url(),
  /** API key (or env var name prefixed with $). */
  apiKey: z.string().optional(),
  /** Provider-specific HTTP timeout in seconds. */
  timeoutSeconds: z.number().positive().optional(),
  /** Models this provider exposes (for resolution). */
  models: z.array(z.string()).optional(),
});

/** Agent defaults. */
export const AgentDefaultsSchema = z.object({
  /** Workspace directory (cwd for tools). Defaults to process.cwd(). */
  workspace: z.string().default(() => process.cwd()),
  /** Default model ref (provider/model). */
  model: z.string().default('openai/gpt-5.6'),
  /** Default reasoning budget exposed to the UI. */
  reasoning: z.enum(['auto', 'low', 'medium', 'high', 'ultra']).default('auto'),
  /** Default behavior profile: prompt-level specialization, not permissions. */
  profile: z.enum(['general', 'coding']).default('general'),
  /** Agent run timeout in seconds (default: 172800 = 48h). */
  timeoutSeconds: z.number().positive().default(172800),
  /** Max recovery attempts before escalation. */
  maxRecoveryAttempts: z.number().int().positive().default(3),
  /** User timezone (e.g. "Asia/Shanghai"). */
  userTimezone: z.string().optional(),
  /** Time format: auto | 12 | 24. */
  timeFormat: z.enum(['auto', '12', '24']).default('auto'),
  /** Bootstrap max chars per file. */
  bootstrapMaxChars: z.number().int().positive().default(20000),
  /** Bootstrap total max chars. */
  bootstrapTotalMaxChars: z.number().int().positive().default(60000),
  /** Context occupancy ratio that recommends compaction (0.5-0.95). */
  contextCompressionThresholdRatio: z.number().min(0.5).max(0.95).default(0.8),
  /** Hard provider-call ceiling for one run, including retries and compaction. */
  maxModelCallsPerRun: z.number().int().min(1).max(128).default(32),
  /** Which harness to use (default: "core-flow"). */
  harness: z.string().default('core-flow'),
}).default({});

/** Electron desktop lifecycle preferences. */
export const DesktopConfigSchema = z.object({
  /** What closing the last visible window means. */
  closePolicy: z.enum([
    'always-background',
    'background-while-active',
    'always-quit',
  ]).default('background-while-active'),
}).default({});

/** Tools config. */
export const ToolsConfigSchema = z.object({
  exec: z.object({
    /** Commands that auto-approve (read-only whitelist). */
    whitelist: z.array(z.string()).default([
      'git status', 'git log', 'git diff', 'git branch',
      'ls', 'dir', 'Get-ChildItem', 'pwd', 'echo',
      'node --version', 'npm --version', 'pnpm --version',
    ]),
    /** Commands that are always rejected (dangerous). */
    blacklist: z.array(z.string()).default([
      'rm -rf /', 'format', 'mkfs', 'dd if=', 'shutdown', 'reboot',
    ]),
    /** Approval mode for non-whitelisted commands. */
    approvalMode: z.enum(['interactive', 'auto-approve', 'auto-deny']).default('interactive'),
  }),
  /** Max output chars before sanitization truncates. */
  maxOutputChars: z.number().int().positive().default(10000),
  /** Strip image base64 to placeholder. */
  stripImages: z.boolean().default(true),
  /** Maximum independent tool calls executed concurrently. */
  maxParallel: z.number().int().min(1).max(8).default(4),
});

/** Memory config. */
export const MemoryConfigSchema = z.object({
  /** Experimental repository backend. v3 also requires an isolated-data marker in the selected data root. */
  repositoryBackend: z.enum(['v2', 'v3']).default('v2'),
  /** Legacy migration setting; daily memory is no longer injected every turn. */
  preludeDays: z.number().int().positive().default(3),
  /** Max chars per daily file in prelude. */
  preludeMaxCharsPerDay: z.number().int().positive().default(2000),
  /** Total max chars for prelude block. */
  preludeTotalMaxChars: z.number().int().positive().default(8000),
  /** Whether to auto-distill old daily files to MEMORY.md. */
  autoDistill: z.boolean().default(true),
  /** Days after which a daily file is eligible for distillation. */
  distillAfterDays: z.number().int().positive().default(7),
  /** Search tool max results. */
  searchMaxResults: z.number().int().positive().default(20),
  /** Total token budget for all memory-tree interventions in one run. */
  treeRunTokenBudget: z.number().int().min(512).max(32000).default(3200),
  /** Token budget for one branch in one run. */
  treeBranchTokenBudget: z.number().int().min(256).max(16000).default(1200),
  /** Stable root-index character ceiling (does not scale with memory volume). */
  treeRootIndexMaxChars: z.number().int().min(600).max(4000).default(1600),
  /** Balanced default threshold for autonomous experience learning. */
  experienceWriteThreshold: z.number().min(0).max(1).default(0.65),
  /** CAPTURE uses deterministic source records by default instead of another model call. */
  llmCapture: z.boolean().default(false),
  /** EVOLVE calls the model only when the verified run has reusable value by default. */
  llmEvolve: z.enum(['adaptive', 'always', 'never']).default('adaptive'),
});

/** Local shadow-Git checkpoint policy. */
export const VersioningConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxCheckpoints: z.number().int().min(16).max(2048).default(256),
  maxFileBytes: z.number().int().min(1024).max(128 * 1024 * 1024).default(8 * 1024 * 1024),
  maxWorkspaceFiles: z.number().int().min(100).max(200000).default(20000),
  maxWorkspaceBytes: z.number().int().min(1024 * 1024).max(8 * 1024 * 1024 * 1024).default(512 * 1024 * 1024),
});

/** Safety config (Phase A: injection defence + quarantine + prelude sanitization). */
export const SafetyConfigSchema = z.object({
  /** Master switch. When false, SafeMemoryStore + sanitizePrelude are skipped. */
  enabled: z.boolean().default(true),
  /** Max chars per memory entry before rejection (matchedPatternId='too_long'). */
  maxEntryChars: z.number().int().positive().default(500),
  /** Subdirectory under data root for quarantined writes. */
  quarantineDir: z.string().default('quarantine'),
  /** Whether to scan writes against INJECTION_PATTERNS with severity 'block'. */
  blockInjectionPatterns: z.boolean().default(true),
  /** Whether to wrap injected prelude in <memory_block> trust envelope. */
  sanitizePrelude: z.boolean().default(true),
});

/** Compaction config. */
export const CompactionConfigSchema = z.object({
  /** Compaction threshold (message count). */
  threshold: z.number().int().positive().default(100),
  /** Compaction: messages to keep unsummarized. */
  keepRecent: z.number().int().positive().default(20),
});

/** Session config. */
export const SessionConfigSchema = z.object({
  /** Session write lock acquire timeout in ms. */
  writeLock: z.object({
    acquireTimeoutMs: z.number().int().positive().default(60000),
  }).default({}),
  /** Compaction config. */
  compaction: CompactionConfigSchema.default({}),
});

/** Skills config. */
export const SkillsConfigSchema = z.object({
  /** Extra skill directories to load. */
  extraDirs: z.array(z.string()).default([]),
  /** Skills gated off (by name). */
  disabled: z.array(z.string()).default([]),
});

/** Runtime plugin discovery and trust policy. */
export const PluginsConfigSchema = z.object({
  /** Installed plugin ids that must not activate. */
  disabled: z.array(z.string()).default([]),
  /** Additional local plugin roots besides the user-data plugins directory. */
  extraDirs: z.array(z.string()).default([]),
  /** Local JavaScript runs in-process and therefore requires explicit trust. */
  allowLocalCode: z.boolean().default(false),
});

/** MCP server config. */
export const McpServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  /** Auto-start when the MCP extension is activated. */
  autoStart: z.boolean().default(true),
});

/** MCP config. */
export const McpConfigSchema = z.object({
  servers: z.array(McpServerSchema).default([]),
});

// ── Channel config (Phase 4) ───────────────────────────────────────────

/**
 * Conversation policy — controls who can talk to the agent via a channel.
 * Discriminated by `type`:
 *   - pairing:    requires a shared secret to pair first (then allowed)
 *   - allowlist:  only pre-approved external user ids can talk
 *   - open:       anyone can talk (public bots)
 *   - disabled:   channel is receive-only or fully muted
 */
export const ConversationPolicySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pairing'),
    /** Shared secret presented by the user to pair their external id. */
    secret: z.string().min(1),
  }),
  z.object({
    type: z.literal('allowlist'),
    /** External user ids allowed to converse (e.g. Telegram user ids). */
    allowedIds: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal('open'),
  }),
  z.object({
    type: z.literal('disabled'),
  }),
]);

/** Config for a single channel instance. */
export const ChannelConfigSchema = z.object({
  /** Channel instance id (unique within config, e.g. "tg-home-bot"). */
  id: z.string().min(1),
  /** Channel type (matches a registered ChannelPlugin type: 'qqbot'|'feishu'|'webhook'|'telegram'). */
  type: z.string().min(1),
  /** Display name for UI/logs. */
  name: z.string().optional(),
  /** Whether this channel should be started. */
  enabled: z.boolean().default(true),
  /** DM (direct message) conversation policy. */
  dmPolicy: ConversationPolicySchema.default({ type: 'open' }),
  /** Group conversation policy. */
  groupPolicy: ConversationPolicySchema.default({ type: 'disabled' }),
  /** Model override for this channel (provider/model). Falls back to agent default. */
  model: z.string().optional(),
  /** Secret references: { envVarName: '$ENV_VAR' } — resolved at runtime. */
  secrets: z.record(z.string()).default({}),
  /** Channel-specific options (validated by the plugin's optionsSchema). */
  options: z.record(z.unknown()).default({}),
});

/** Top-level channels config. */
export const ChannelsConfigSchema = z.object({
  channels: z.array(ChannelConfigSchema).default([]),
});

/** Full config schema. */
export const ConfigSchema = z.object({
  /** Config schema version. */
  version: z.number().default(1),
  /** Model providers. */
  providers: z.array(ModelProviderSchema).default([]),
  /** Agent defaults. */
  agents: z.object({
    defaults: AgentDefaultsSchema,
  }).default({}),
  /** Desktop shell lifecycle preferences; ignored by non-desktop adapters. */
  desktop: DesktopConfigSchema,
  /** Tools config. */
  tools: ToolsConfigSchema.default({ exec: {} }),
  /** Memory config. */
  memory: MemoryConfigSchema.default({}),
  /** Safety config (Phase A: injection defence + quarantine). */
  safety: SafetyConfigSchema.default({}),
  /** Session config. */
  sessions: SessionConfigSchema.default({}),
  /** Skills config. */
  skills: SkillsConfigSchema.default({}),
  /** Plugin discovery, enablement, and local-code trust policy. */
  plugins: PluginsConfigSchema.default({}),
  /** MCP config. */
  mcp: McpConfigSchema.default({}),
  /** Channels config (Phase 4: multi-channel message routing). */
  channels: ChannelsConfigSchema.default({}),
  /** Local data and workspace rollback checkpoints. */
  versioning: VersioningConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type DesktopConfig = z.infer<typeof DesktopConfigSchema>;
export type DesktopClosePolicy = DesktopConfig['closePolicy'];
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;
export type PluginsConfig = z.infer<typeof PluginsConfigSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type ConversationPolicy = z.infer<typeof ConversationPolicySchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;
export type VersioningConfig = z.infer<typeof VersioningConfigSchema>;
