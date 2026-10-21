import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PDF_FONT_FILE,
  PDF_FONT_SHA256,
  PDF_FONT_URL,
} from './install-pdf-font.mjs';

const scriptPath = fileURLToPath(new URL('./install-pdf-font.mjs', import.meta.url));

describe('pinned PDF font installer', () => {
  it('pins an immutable font URL, a full sha256 and the expected file name', () => {
    expect(PDF_FONT_FILE).toBe('NotoSansSC-VF.ttf');
    expect(PDF_FONT_URL).toMatch(/^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/[0-9a-f]{40}\//u);
    expect(PDF_FONT_SHA256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects a downloaded file whose digest does not match and installs nothing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-pdf-font-'));
    const source = join(directory, 'downloaded.ttf');
    const targetDirectory = join(directory, 'Fonts');
    await writeFile(source, 'not the pinned font', 'utf8');
    try {
      const result = spawnSync(process.execPath, [scriptPath, `--source-file=${source}`], {
        encoding: 'utf8',
        env: { ...process.env, LITTLESHEEP_PDF_FONT_DIR: targetDirectory },
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({ code: 'PDF_FONT_DIGEST_MISMATCH' });
      await expect(readFile(join(targetDirectory, PDF_FONT_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
