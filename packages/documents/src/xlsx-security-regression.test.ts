// Security and format regression for the SheetJS xlsx upgrade (0.18.5 -> 0.20.2).
// Guards CVE-2023-30533 (prototype pollution) and CVE-2024-22363 (ReDoS) plus
// the workbook read budgets and the full spreadsheet format matrix.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { extractDocument } from './index.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete (Object.prototype as Record<string, unknown>).polluted
  delete (Object.prototype as Record<string, unknown>).hijacked
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ls-xlsx-sec-'))
  tempDirs.push(dir)
  return dir
}

function versionParts(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  return [major, minor, patch]
}

function prototypeIsClean(): boolean {
  const proto = Object.prototype as Record<string, unknown>
  return proto.polluted === undefined && proto.hijacked === undefined
}

describe('xlsx security regression (CVE-2023-30533 / CVE-2024-22363)', () => {
  it('resolves to a version that clears both advisories (>= 0.20.2)', () => {
    const version = (XLSX as unknown as { version?: string }).version ?? ''
    const [major, minor, patch] = versionParts(version)
    const atLeast0202 = major > 0 || (major === 0 && (minor > 20 || (minor === 20 && patch >= 2)))
    expect(atLeast0202, `resolved xlsx version must be >= 0.20.2, got ${version || 'unknown'}`).toBe(true)
  })

  it('does not pollute Object.prototype when parsing crafted workbook names and cells', () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([
      ['名称', '值'],
      ['键', '__proto__'],
      ['构造', 'constructor'],
    ])
    // Inject attacker-shaped keys before serialization to exercise the read path.
    ;(sheet as Record<string, unknown>)['__proto__.polluted'] = 'x'
    ;(sheet as Record<string, unknown>)['constructor.prototype.hijacked'] = 'x'
    XLSX.utils.book_append_sheet(workbook, sheet, '正常')
    ;(workbook as unknown as { Workbook?: Record<string, unknown> }).Workbook = {
      Names: ['__proto__.polluted', 'constructor.prototype.hijacked'],
    }

    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    XLSX.read(bytes, { type: 'buffer', dense: true })
    XLSX.read(bytes, { type: 'buffer', dense: false })

    expect(prototypeIsClean()).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('handles corrupted workbook bytes without polluting the prototype', () => {
    const corrupted = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // zip local file header magic + junk
      Buffer.alloc(512, 0xff),
    ])

    let outcome: unknown = null
    try {
      outcome = XLSX.read(corrupted, { type: 'buffer' })
    } catch (error) {
      outcome = error
    }

    // Either a parsed workbook or a controlled error is acceptable; the invariant
    // is that attacker-controlled bytes never pollute the shared prototype.
    expect(outcome).not.toBeNull()
    expect(prototypeIsClean()).toBe(true)
  })

  it('truncates oversized workbooks to the row budget', async () => {
    const filePath = join(tempDir(), 'rows.xlsx')
    const rows = Array.from({ length: 510 }, (_, row) => [`r${row}`, 'x'])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '超大')
    writeFileSync(filePath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))

    const extracted = await extractDocument(filePath)

    expect(extracted.format).toBe('xlsx')
    expect(extracted.sections[0]?.rows?.length).toBe(500) // DEFAULT_MAX_ROWS_PER_SHEET
    expect(extracted.notes.join(' ')).toContain('截断')
  })

  it('truncates oversized workbooks to the column budget', async () => {
    const filePath = join(tempDir(), 'cols.xlsx')
    const rows = Array.from({ length: 3 }, (_, row) => (
      Array.from({ length: 300 }, (_, column) => (row === 0 ? `c${column}` : 'x'))
    ))
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '宽表')
    writeFileSync(filePath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))

    const extracted = await extractDocument(filePath)

    expect(extracted.format).toBe('xlsx')
    expect(extracted.sections[0]?.rows?.every((row) => row.length <= 256)).toBe(true) // MAX_CREATE_COLUMNS
    expect(extracted.notes.join(' ')).toContain('截断')
  })
})

describe('xlsx post-upgrade format regression', () => {
  const spreadsheetCases: Array<{ extension: string; bookType: 'xlsx' | 'xlsb' | 'biff8' }> = [
    { extension: '.xlsx', bookType: 'xlsx' },
    { extension: '.xlsm', bookType: 'xlsx' },
    { extension: '.xltx', bookType: 'xlsx' },
    { extension: '.xlsb', bookType: 'xlsb' },
    { extension: '.xls', bookType: 'biff8' },
    { extension: '.xlt', bookType: 'biff8' },
  ]

  it.each(spreadsheetCases)('round-trips spreadsheet content for %s', ({ bookType }) => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['项目', '金额'],
      ['依赖安全', 2024],
    ]), '表')

    const parsed = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType }), { type: 'buffer' })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(parsed.Sheets['表'] ?? {}, { header: 1, defval: '' })

    expect(rows[0]).toEqual(['项目', '金额'])
    expect(rows[1]).toEqual(['依赖安全', 2024])
  })

  it('round-trips CSV and TSV content', () => {
    const source = XLSX.utils.aoa_to_sheet([['名称', '数量'], ['中文', 3]])
    const csv = XLSX.utils.sheet_to_csv(source, { FS: ',', RS: '\n' })
    const tsv = XLSX.utils.sheet_to_csv(source, { FS: '\t', RS: '\n' })

    const csvRows = XLSX.utils.sheet_to_json<unknown[]>(
      XLSX.read(csv, { type: 'string' }).Sheets.Sheet1 ?? {}, { header: 1, defval: '' },
    )
    const tsvRows = XLSX.utils.sheet_to_json<unknown[]>(
      XLSX.read(tsv, { type: 'string', FS: '\t' }).Sheets.Sheet1 ?? {}, { header: 1, defval: '' },
    )

    expect(csvRows[1]).toEqual(['中文', 3])
    expect(tsvRows[1]).toEqual(['中文', 3])
  })
})
