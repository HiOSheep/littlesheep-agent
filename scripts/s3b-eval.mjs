#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveS3bProviderProfile, hasS3bLiveRunAcknowledgement } from './lib/s3b-provider-config.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\//u, '').replaceAll('/', '\\');
const args = process.argv.slice(2);
const profile = resolveS3bProviderProfile(process.env);
const publicProfile = { ready: profile.ready, missing: profile.missing, provider: profile.provider };
const sha256 = value => createHash('sha256').update(value).digest('hex');

function usage() {
  process.stderr.write([
    'Usage:',
    '  node scripts/s3b-eval.mjs --preflight',
    '  node scripts/s3b-eval.mjs --verify-provider-metering',
    '  node scripts/s3b-eval.mjs --run-controlled --task=<ID>',
    '  node scripts/s3b-eval.mjs --run-real --task=<CODE-01|FILE-02|DELIV-01|MULTI-01> --trial=<N>',
  ].join('\n') + '\n');
}

function verifyProviderMetering() {
  const result = spawnSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', 'test/s3b-provider-metering.test.ts',
  ], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(`${JSON.stringify({
    test: 'S3B real Provider metering via local fake HTTP responses',
    network: 'no external network; injected fake fetch only',
    exitCode: result.status,
    outputSha256: sha256(output),
    output: output.replaceAll(process.env.S3B_API_KEY ?? '\u0000', '[redacted]'),
  }, null, 2)}\n`);
  if (result.status !== 0) process.exitCode = 1;
}

if (args.length !== 1 || (!args.includes('--preflight') && !args.includes('--verify-provider-metering'))) {
  usage();
  process.exitCode = 2;
} else if (args.includes('--preflight')) {
  process.stdout.write(`${JSON.stringify({
    state: profile.ready ? 'configured_but_not_authorized' : 'real_provider_pending',
    provider: publicProfile,
    liveRunAcknowledgementPresent: hasS3bLiveRunAcknowledgement(process.env),
    liveCallsMade: false,
    note: 'Preflight reads only sanitized environment metadata. It never sends a Provider request. A direct user authorization and explicit request/cost budget are still required before any live trial.',
  }, null, 2)}\n`);
} else {
  verifyProviderMetering();
}
