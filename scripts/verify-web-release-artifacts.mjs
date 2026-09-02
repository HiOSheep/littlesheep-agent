import { existsSync } from 'node:fs';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAll } from '@electron/asar';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultRoots = [
  'packages/app/out',
  'packages/web/dist',
  'packages/types/dist',
];

const rules = [
  { id: 'provider-secret-literal', pattern: /(?:tvly-|tavily[_-]?api[_-]?key\s*[:=]\s*["'][^"']+|Bearer\s+[A-Za-z0-9._-]{16,})/iu },
  { id: 'fixture-private-marker', pattern: /(?:fixture[-_ ]private|sensitive[-_ ]query[-_ ]marker|web[-_ ]cache[-_ ]body[-_ ]fixture)/iu },
  { id: 'embedded-user-memory', pattern: /(?:migration rehearsal marker|user memory fixture|private memory fixture|personal memory fixture)/iu },
  // pdf.js embeds this fixed worker account; it is not an LS user path.
  { id: 'absolute-user-path', pattern: /(?:[A-Za-z]:[\\/](?:Users|Documents)[\\/]|(?:^|["'`\s])\/Users\/|(?:^|["'`\s])\/home\/(?!web_user(?:[\/"'`\s]|$)))/u },
];

async function main() {
  const roots = parseRoots(process.argv.slice(2));
  const files = [];
  const archives = [];
  const skipped = { missingRoots: 0, sourceMaps: 0, tests: 0, unsupported: 0 };
  for (const root of roots) {
    if (!existsSync(root)) {
      skipped.missingRoots += 1;
      continue;
    }
    await collect(root, files, archives, skipped);
  }

  const hits = new Map(rules.map((rule) => [rule.id, 0]));
  const hitSamples = new Map(rules.map((rule) => [rule.id, []]));
  const readErrorSamples = [];
  let readErrors = 0;
  for (const file of files) {
    let content;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      readErrors += 1;
      if (readErrorSamples.length < 5) readErrorSamples.push(relative(repoRoot, file));
      continue;
    }
    for (const rule of rules) {
      if (rule.pattern.test(content)) recordHit(rule.id, relative(repoRoot, file), hits, hitSamples);
    }
  }

  let archiveEntries = 0;
  for (const archive of archives) {
    const extractionRoot = await mkdtemp(join(tmpdir(), 'littlesheep-release-scan-'));
    try {
      extractAll(archive, extractionRoot);
      const extractedFiles = [];
      await collectExtractedFiles(extractionRoot, extractedFiles);
      for (const file of extractedFiles) {
        const entry = file.slice(extractionRoot.length + 1);
        if (!isTextEntry(entry, skipped)) continue;
        archiveEntries += 1;
        let content;
        try {
          content = await readFile(file, 'utf8');
        } catch {
          readErrors += 1;
          if (readErrorSamples.length < 5) readErrorSamples.push(`${relative(repoRoot, archive)}::${entry}`);
          continue;
        }
        for (const rule of rules) {
          if (rule.pattern.test(content)) recordHit(rule.id, `${relative(repoRoot, archive)}::${entry}`, hits, hitSamples);
        }
      }
    } catch {
      readErrors += 1;
    } finally {
      await rm(extractionRoot, { recursive: true, force: true });
    }
  }

  const hitSummary = Object.fromEntries(hits);
  const failed = skipped.missingRoots > 0 || readErrors > 0 || Object.values(hitSummary).some((count) => count > 0);
  print({
    check: 'web-release-artifacts',
    status: failed ? 'failed' : 'passed',
    ok: !failed,
    roots: roots.map((root) => relative(repoRoot, root)),
    scannedFiles: files.length,
    archives: archives.map((archive) => relative(repoRoot, archive)),
    scannedArchiveEntries: archiveEntries,
    skipped,
    readErrors,
    readErrorSamples,
    hitCounts: hitSummary,
    hitSamples: Object.fromEntries(hitSamples),
    excluded: ['source maps', 'test/spec files', 'unsupported binary extensions'],
  });
  return failed ? 1 : 0;
}

async function collect(directory, files, archives, skipped) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(file, files, archives, skipped);
      continue;
    }
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (lower.endsWith('.asar')) {
      archives.push(file);
      continue;
    }
    if (!isTextEntry(lower, skipped)) continue;
    files.push(file);
  }
}

function isTextEntry(fileName, skipped) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.map')) {
    skipped.sourceMaps += 1;
    return false;
  }
  if (/(?:\.test\.|\.spec\.|__tests__|tests?[-_])/iu.test(lower)) {
    skipped.tests += 1;
    return false;
  }
  if (!/\.(?:js|cjs|mjs|ts|d\.ts|json|html|css|txt)$/iu.test(lower)) {
    skipped.unsupported += 1;
    return false;
  }
  return true;
}

function recordHit(ruleId, location, hits, hitSamples) {
  hits.set(ruleId, hits.get(ruleId) + 1);
  const samples = hitSamples.get(ruleId);
  if (samples.length < 5) samples.push(location);
}

async function collectExtractedFiles(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectExtractedFiles(file, files);
    } else if (entry.isFile()) {
      files.push(file);
    }
  }
}

function parseRoots(argv) {
  const requested = argv.filter((value) => value.startsWith('--root=')).map((value) => value.slice('--root='.length));
  return (requested.length > 0 ? requested : defaultRoots).map((value) => resolve(repoRoot, value));
}

function print(value) { console.log(JSON.stringify(value)); }

main().then((code) => { process.exitCode = code; }).catch((error) => {
  print({ check: 'web-release-artifacts', status: 'failed', ok: false, errorKind: error?.name || 'Error' });
  process.exitCode = 1;
});
