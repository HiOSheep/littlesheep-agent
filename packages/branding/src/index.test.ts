import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  parseBranding,
  DEFAULT_BRANDING,
  dataRootLocatorPath,
  dataSubdirs,
  parseDataRootLocator,
  readDataRootLocator,
  resolveDataDir,
} from './index.js';

let locatorRoot: string;

beforeEach(() => {
  locatorRoot = mkdtempSync(join(tmpdir(), 'ls-branding-locator-'));
  process.env.LITTLESHEEP_DATA_LOCATOR = join(locatorRoot, 'location.json');
  delete process.env.LITTLESHEEP_DATA_DIR;
});

afterEach(() => {
  delete process.env.LITTLESHEEP_DATA_LOCATOR;
  delete process.env.LITTLESHEEP_DATA_DIR;
  rmSync(locatorRoot, { recursive: true, force: true });
});

describe('branding', () => {
  it('parseBranding accepts valid config', () => {
    const cfg = parseBranding({
      name: 'TestSheep',
      cliName: 'testsheep',
      dataDir: '.testsheep',
    });
    expect(cfg.name).toBe('TestSheep');
    expect(cfg.emoji).toBe(DEFAULT_BRANDING.emoji);
    expect(cfg.displayName).toBe('TestSheep'); // falls back to name
  });

  it('parseBranding rejects missing required fields', () => {
    expect(() => parseBranding({ name: 'X' })).toThrow(/cliName/);
    expect(() => parseBranding(null)).toThrow();
  });

  it('resolveDataDir handles relative dataDir', () => {
    const cfg = { ...DEFAULT_BRANDING, dataDir: '.littlesheep' };
    const dir = resolveDataDir(cfg);
    expect(dir).toContain('.littlesheep');
  });

  it('resolveDataDir handles absolute path', () => {
    const cfg = { ...DEFAULT_BRANDING, dataDir: 'D:\\tmp\\sheep' };
    const dir = resolveDataDir(cfg);
    expect(dir).toBe('D:\\tmp\\sheep');
  });

  it('dataSubdirs returns expected layout', () => {
    const cfg = { ...DEFAULT_BRANDING, dataDir: '.littlesheep' };
    const subs = dataSubdirs(cfg);
    expect(subs.root).toMatch(/.littlesheep$/);
    expect(subs.sessions).toMatch(/sessions$/);
    expect(subs.memory).toMatch(/memory$/);
    expect(subs.quarantine).toMatch(/quarantine$/);
    expect(subs.backups).toMatch(/backups$/);
    expect(subs.experience).toMatch(/experience$/);
    expect(subs.archive).toMatch(/archive$/);
    expect(subs.vectors).toMatch(/vectors$/);
    expect(subs.executionLogs).toMatch(/execution-logs$/);
    expect(subs.channels).toMatch(/channels$/);
    expect(subs.attachmentCache).toMatch(/attachment-cache$/);
    expect(subs.workplace).toMatch(/workplace$/);
  });

  it('uses a valid locator unless an explicit environment override is present', () => {
    const located = join(locatorRoot, 'moved-data');
    writeFileSync(dataRootLocatorPath(DEFAULT_BRANDING), JSON.stringify({
      version: 1,
      activeDataDir: located,
    }), 'utf8');
    expect(readDataRootLocator(DEFAULT_BRANDING)?.activeDataDir).toBe(located);
    expect(resolveDataDir(DEFAULT_BRANDING)).toBe(located);

    const overridden = join(locatorRoot, 'env-data');
    process.env.LITTLESHEEP_DATA_DIR = overridden;
    expect(resolveDataDir(DEFAULT_BRANDING)).toBe(overridden);
  });

  it('parses resumable migration and rollback metadata', () => {
    const parsed = parseDataRootLocator({
      version: 1,
      activeDataDir: join(locatorRoot, 'active'),
      pendingMigration: {
        id: 'move-1',
        sourceDir: join(locatorRoot, 'active'),
        targetDir: join(locatorRoot, 'target'),
        stageDir: join(locatorRoot, '.target.stage'),
        phase: 'committing',
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:01:00.000Z',
        attempts: 1,
        fileCount: 3,
        totalBytes: 42,
        manifestHash: 'abc',
      },
      pendingRollback: {
        id: 'rollback-1',
        fromDir: join(locatorRoot, 'target'),
        toDir: join(locatorRoot, 'active'),
        createdAt: '2026-07-14T00:02:00.000Z',
      },
    });

    expect(parsed?.pendingMigration).toMatchObject({
      phase: 'committing',
      fileCount: 3,
      totalBytes: 42,
      manifestHash: 'abc',
    });
    expect(parsed?.pendingRollback?.id).toBe('rollback-1');
  });
});
