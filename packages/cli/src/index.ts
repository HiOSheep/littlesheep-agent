﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿// @littlesheep/cli — index.ts
// CLI orchestrator: parse argv, load config+branding, create runner, dispatch.

import {
  loadConfig,
  defaultConfigWithOpenAI,
  parseModelRef,
  getProvider,
  resolveApiKey,
} from '@littlesheep/config';
import { loadBranding, dataSubdirs } from '@littlesheep/branding';
import { createRunner, prepareAuthoritativeRunnerResult, resolveLlm } from '@littlesheep/runner';
import { asSessionId, formatWebEvidenceSources } from '@littlesheep/types';
import { parseArgs, USAGE, VERSION } from './args.js';
import { startRepl } from './repl.js';
import { parseMemoryRollbackFlags, runMemoryRollback } from './commands/memory.js';
import { parseImportRepoFlags, runImportRepo } from './commands/import-repo.js';
import { ExperienceStore } from '@littlesheep/experience';

/** Run the CLI with the given argv (typically process.argv.slice(2)). */
export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (args.version) {
    process.stdout.write(VERSION + '\n');
    return;
  }
  if (args.retiredCommand === 'memory archive') {
    process.stderr.write(
      'The legacy "memory archive" command is retired under Memory v3 because it bypassed the Atom repository and local vector catalog. Existing archive/vector files are preserved. Use the Memory v3 runtime; structured compaction will use the unified write and recovery gates.\n',
    );
    process.exitCode = 2;
    return;
  }
  if (args.unknown.length > 0) {
    process.stderr.write(`Unknown flags: ${args.unknown.join(', ')}\n\n`);
    process.stderr.write(USAGE + '\n');
    process.exitCode = 2;
    return;
  }

  // 1. Load branding + config.
  const branding = await loadBranding();
  const dataDir = dataSubdirs(branding);

  // Subcommand: 'memory rollback' (needs branding only, not config/providers/LLM).
  if (args.memoryRollback !== undefined) {
    const flags = parseMemoryRollbackFlags(args.memoryRollback);
    await runMemoryRollback({
      dataRoot: dataDir.root,
      backupsDir: dataDir.backups,
      flags,
    });
    return;
  }

  // Subcommand: 'memory experience decay' (needs branding's experience dir only).
  if (args.memoryExperience !== undefined) {
    const store = new ExperienceStore({ rootDir: dataDir.experience });
    const result = await store.decay();
    process.stdout.write(`Decay: ${result.before} → ${result.after} entries\n`);
    return;
  }

  // Subcommand: 'memory import-repo' (needs config + LLM + ExperienceStore).
  // Reuses the same fail-fast provider/apiKey verification as the main flow
  // (via resolveLlm), but loads its own config so the main path stays untouched.
  if (args.memoryImportRepo !== undefined) {
    const flags = parseImportRepoFlags(args.memoryImportRepo);
    let config = await loadConfig({ dataDir: dataDir.root });
    if (config.providers.length === 0) config = defaultConfigWithOpenAI();
    const model = flags.model ?? config.agents.defaults.model;
    try {
      const { llm } = resolveLlm(config, model);
      const experienceStore = new ExperienceStore({ rootDir: dataDir.experience });
      await runImportRepo({ flags, llm, model, experienceStore });
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  let config = await loadConfig({ dataDir: dataDir.root });

  // 2. If no providers configured, synthesize a default OpenAI provider (MVP).
  if (config.providers.length === 0) {
    config = defaultConfigWithOpenAI();
  }

  // 3. Resolve model override.
  const model = args.model ?? config.agents.defaults.model;

  // 4. Verify provider + API key exist (fail fast with helpful message).
  const { provider: providerId } = parseModelRef(model);
  const provider = getProvider(config, providerId);
  if (!provider) {
    process.stderr.write(`No provider "${providerId}" configured.\n`);
    process.stderr.write(`Edit ${dataDir.config}/config.json or pass --model <provider/model>.\n`);
    process.exitCode = 1;
    return;
  }
  const apiKey = resolveApiKey(provider.apiKey);
  if (!apiKey) {
    const envName = provider.apiKey && provider.apiKey.startsWith('$')
      ? provider.apiKey.slice(1)
      : 'OPENAI_API_KEY';
    process.stderr.write(`Provider "${providerId}" has no apiKey.\n`);
    process.stderr.write(`Set ${envName} env var or edit ${dataDir.config}/config.json.\n`);
    process.exitCode = 1;
    return;
  }

  // 5. Create runner.
  const runner = await createRunner({
    config,
    branding,
    model,
    bootstrapDir: dataDir.root,
    containerRoot: dataDir.root,
    durableHarnessMode: config.agents.defaults.durableHarnessMode,
  });

  // 6. Dispatch: single-shot or REPL.
  if (args.text !== undefined) {
    const result = await runner.run({
      sessionId: args.session ? asSessionId(args.session) : undefined,
      text: args.text,
      origin: 'cli',
    });
    const publishedResult = runner.durableHarnessMode === 'next'
      ? await prepareAuthoritativeRunnerResult(runner, result)
      : result;
    if (!publishedResult) throw new Error('runner returned no result')
    const reply = publishedResult.finalReplySettlement?.status === 'settled'
      ? publishedResult.finalReplySettlement.reply
      : publishedResult.finalReplySettlement
        ? ''
        : publishedResult.reply;
    process.stdout.write(`${reply || '(no reply)'}\n`);
    const sources = formatWebEvidenceSources(publishedResult.webEvidence);
    if (sources) process.stdout.write(`${sources}\n`);
    if (publishedResult.status === 'error') {
      process.exitCode = 1;
    }
    await runner.shutdown();
  } else {
    await startRepl({
      runner,
      branding,
      sessionId: args.session ? asSessionId(args.session) : undefined,
    });
  }
}

export { parseArgs, USAGE, VERSION } from './args.js';
export { startRepl } from './repl.js';
export type { ParsedArgs } from './args.js';
export type { ReplOptions } from './repl.js';
