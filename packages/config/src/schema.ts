// @littlesheep/config — schema.ts
// Zod schema for the full LittleSheep config.
//
// Config file location: ~/.littlesheep/config.json (or LITTLESHEEP_CONFIG env).
// The schema is LittleSheep-owned and versioned with the runtime.

import { z } from 'zod';

/** Runtime reasoning levels a user-declared model may advertise. */
export const MODEL_REASONING_OPTIONS = ['auto', 'low', 'medium', 'high', 'ultra'] as const;

/**
 * A user-declared model entry.
 *
 * LS never invents capability numbers: when a model is not in the built-in
 * registry, only the metadata declared here is used, and anything left out
 * stays unknown (no context window, no fabricated reasoning levels).
 */
export const ModelEntrySchema = z.object({
  /** Provider-side model id sent on the wire (e.g. "deepseek-flash"). */
  id: z.string().min(1).max(200),
  /** Display name used by the model picker. Defaults to the id. */
  name: z.string().min(1).max(200).optional(),
  /** Declared context window in tokens. */
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
  /** Declared max output tokens. */
  maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
  /** Runtime reasoning levels this model accepts; defaults to ["auto"]. */
  reasoningOptions: z.array(z.enum(MODEL_REASONING_OPTIONS)).min(1).max(5).optional(),
  /** Provider reasoning effort used when the user picks "ultra". */
  ultraEffort: z.enum(['high', 'xhigh', 'max']).optional(),
  /** Whether the model accepts image input. */
  vision: z.boolean().optional(),
  /** Optional documentation link for the declared numbers. */
  sourceUrl: z.string().url().optional(),
});

/** A model entry as written in config: a bare id or a metadata object. */
export const ProviderModelSchema = z.union([
  z.string().min(1).max(200),
  ModelEntrySchema,
]);

/**
 * A model provider.
 *
 * `api` is explicitly enumerated: LS only implements OpenAI-compatible chat
 * completions, and an unknown protocol is rejected instead of being sent as
 * if it were compatible.
 */
export const ModelProviderSchema = z.object({
  /** Provider id (e.g. "openai", "openrouter", "ollama"). */
  id: z.string().min(1).max(64),
  /** Display name. */
  name: z.string().min(1).max(120).optional(),
  /** API base URL. */
  baseURL: z.string().url(),
  /** API key (or env var name prefixed with $). */
  apiKey: z.string().optional(),
  /** Wire protocol. Only the implemented OpenAI-compatible shape is accepted. */
  api: z.enum(['openai-chat-completions']).optional(),
  /** Extra request headers (e.g. gateway routing headers). */
  headers: z.record(z.string().max(1000)).optional(),
  /** Provider-specific HTTP timeout in seconds. */
  timeoutSeconds: z.number().positive().optional(),
  /** Models this provider exposes, with optional declared metadata. */
  models: z.array(ProviderModelSchema).optional(),
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
  /** Durable Harness rollout mode: shadow audits only; next is authoritative. */
  durableHarnessMode: z.enum(['shadow', 'next']).default('next'),
  /** Per-session durable Harness overrides; unlisted sessions use durableHarnessMode. */
  durableHarnessSessionOverrides: z.record(z.enum(['shadow', 'next'])).default({}),
  /** Per-request-origin durable Harness overrides; session overrides take precedence. */
  durableHarnessOriginOverrides: z.record(z.enum(['shadow', 'next'])).default({}),
  /** Per-behavior-profile durable Harness overrides; session/origin overrides take precedence. */
  durableHarnessProfileOverrides: z.record(z.enum(['shadow', 'next'])).default({}),
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
  /** Runtime ceiling for one hosted tool invocation; long jobs remain bounded by the run timeout. */
  invocationTimeoutMs: z.number().int().min(1_000).max(24 * 60 * 60_000).default(120_000),
});

const WebProviderOptionValueSchema = z.union([
  z.string().max(2_048),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** Search-provider adapter configuration. API keys are references, not execution-log data. */
export const WebProviderConfigSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/u),
  type: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/u),
  baseURL: z.string().url().max(2_048).optional(),
  apiKeyRef: z.string().trim().min(1).max(256).optional(),
  options: z.record(WebProviderOptionValueSchema).default({}),
});

export const WebCacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ttlSeconds: z.number().int().min(0).max(7 * 24 * 60 * 60).default(300),
  maxBytes: z.number().int().min(0).max(1024 * 1024 * 1024).default(64 * 1024 * 1024),
}).default({});

/** Network retrieval is opt-in and provider-neutral. Missing legacy fields resolve to disabled. */
export const WebConfigSchema = z.object({
  enabled: z.boolean().default(false),
  defaultProvider: z.string().trim().min(1).max(64).optional(),
  readMode: z.enum(['disabled', 'public_anonymous', 'configured_allowlist']).default('public_anonymous'),
  strictReadApproval: z.boolean().default(false),
  allowDomains: z.array(z.string().trim().min(1).max(253)).max(128).default([]),
  blockDomains: z.array(z.string().trim().min(1).max(253)).max(128).default([]),
  dnsResolver: z.enum(['system', 'cloudflare_doh']).default('system'),
  maxQueryChars: z.number().int().min(1).max(2_000).default(2_000),
  maxResults: z.number().int().min(1).max(20).default(10),
  maxFetchesPerRun: z.number().int().min(0).max(32).default(4),
  maxQueriesPerRun: z.number().int().min(0).max(32).default(4),
  maxConcurrentRequests: z.number().int().min(1).max(8).default(4),
  searchTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
  fetchTimeoutMs: z.number().int().min(1_000).max(120_000).default(20_000),
  totalTimeoutMs: z.number().int().min(1_000).max(10 * 60_000).default(90_000),
  maxResponseBytes: z.number().int().min(1_024).max(32 * 1024 * 1024).default(2 * 1024 * 1024),
  maxExtractedChars: z.number().int().min(1_000).max(500_000).default(40_000),
  maxRedirects: z.number().int().min(0).max(10).default(5),
  cache: WebCacheConfigSchema,
  browserFallback: z.enum(['disabled', 'approval_required', 'full_only']).default('approval_required'),
  sensitiveQueryPolicy: z.enum(['allow', 'redact', 'approve', 'deny']).default('approve'),
  providers: z.array(WebProviderConfigSchema).max(16).default([]),
}).superRefine((value, ctx) => {
  const providerIds = new Set<string>();
  for (const [index, provider] of value.providers.entries()) {
    if (providerIds.has(provider.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providers', index, 'id'],
        message: `duplicate web provider id: ${provider.id}`,
      });
    }
    providerIds.add(provider.id);
  }
}).default({});

/** Memory config. */
export const MemoryConfigSchema = z.object({
  /** Experimental repository backend. v3 also requires an isolated-data marker in the selected data root. */
  repositoryBackend: z.enum(['v2', 'v3']).default('v2'),
  /** Total token budget for all memory-tree interventions in one run. */
  treeRunTokenBudget: z.number().int().min(512).max(32000).default(3200),
  /** Token budget for one branch in one run. */
  treeBranchTokenBudget: z.number().int().min(256).max(16000).default(1200),
  /** Stable root-index character ceiling (does not scale with memory volume). */
  treeRootIndexMaxChars: z.number().int().min(600).max(4000).default(1600),
  /** Balanced default threshold for autonomous experience learning. */
  experienceWriteThreshold: z.number().min(0).max(1).default(0.65),
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
  threshold: z.number().int().positive().default(400),
  /**
   * Compaction: messages to keep unsummarized.
   *
   * This is also the verbatim history a run receives (HARNESS reads
   * `readRecent(sessionId, keepRecent)`), and a Provider prefix cache only
   * matches from token zero. A small window slides on every turn, which
   * forfeits the whole history prefix; a wide one keeps the run's transcript
   * append-only between compactions.
   */
  keepRecent: z.number().int().positive().default(200),
  /** Run soft automatic compaction after the result is published instead of blocking the run. */
  background: z.boolean().default(false),
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
  /** Opt-in public network retrieval. */
  web: WebConfigSchema,
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
export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type ProviderModel = z.infer<typeof ProviderModelSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type DesktopConfig = z.infer<typeof DesktopConfigSchema>;
export type DesktopClosePolicy = DesktopConfig['closePolicy'];
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type WebProviderConfig = z.infer<typeof WebProviderConfigSchema>;
export type WebCacheConfig = z.infer<typeof WebCacheConfigSchema>;
export type WebConfig = z.infer<typeof WebConfigSchema>;
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
