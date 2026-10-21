// Installs the CJK font the document suites need on a clean hosted runner.
//
// PDF generation and extraction tests assert real Chinese text. The hosted
// Windows image ships Latin fonts only, so `resolvePdfFont` in
// packages/documents/src/write-pdf.ts fell through to a Latin font and the
// extracted text came back as mojibake. The font is pinned by commit and
// sha256 so the CI run is reproducible and a corrupted download fails here
// with a clear error instead of surfacing as a confusing PDF assertion later.
//
// `--source-file=<path>` installs from an already-downloaded copy; it exists so
// the digest/install path can be validated on hosts whose network cannot reach
// raw.githubusercontent.com (the hosted runner downloads normally).
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PDF_FONT_FILE = 'NotoSansSC-VF.ttf';
export const PDF_FONT_URL = 'https://raw.githubusercontent.com/google/fonts/'
  + '2894aab31764f10f29c421bdfd2340d3b382d384/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf';
export const PDF_FONT_SHA256 = 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da';

function fail(code, message) {
  console.error(JSON.stringify({ status: 'failed', code, message }));
  process.exit(1);
}

async function downloadWithRetries(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000 * attempt));
    }
  }
  throw lastError;
}

async function install() {
  const sourceFileArg = process.argv.find((value) => value.startsWith('--source-file='));
  const bytes = sourceFileArg
    ? await readFile(sourceFileArg.slice('--source-file='.length))
    : await downloadWithRetries(PDF_FONT_URL).catch((error) => {
      fail('PDF_FONT_DOWNLOAD_FAILED', `${PDF_FONT_URL}: ${error instanceof Error ? error.message : String(error)}`);
    });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== PDF_FONT_SHA256) {
    fail('PDF_FONT_DIGEST_MISMATCH', `sha256 ${sha256} does not match the pinned ${PDF_FONT_SHA256}`);
  }

  const windowsDir = process.env.WINDIR ?? 'C:\\Windows';
  const fontsDir = process.env.LITTLESHEEP_PDF_FONT_DIR ?? join(windowsDir, 'Fonts');
  const targetPath = join(fontsDir, PDF_FONT_FILE);
  await mkdir(fontsDir, { recursive: true });
  await writeFile(targetPath, bytes);
  console.log(JSON.stringify({ status: 'installed', font: targetPath, bytes: bytes.length, sha256 }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await install();
}
