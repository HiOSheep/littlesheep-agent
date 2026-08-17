import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'packages', 'app')
const chunksDir = join(appRoot, 'out', 'main', 'chunks')
const appRequire = createRequire(join(appRoot, 'package.json'))
const documentsRequire = createRequire(join(repoRoot, 'packages', 'documents', 'package.json'))

async function main() {
  await app.whenReady()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-electron-documents-'))
  try {
    const chunkPath = await findDocumentRuntimeChunk()
    const runtime = appRequire(chunkPath)
    assert.equal(typeof runtime.createDocument, 'function')
    assert.equal(typeof runtime.extractDocument, 'function')

    const generated = await createGeneratedDocuments(runtime, root)
    const readMatrix = await createAndReadInputMatrix(runtime, root)
    await verifyTextlessPdf(runtime, root)
    await verifyLegacyOfficeErrors(runtime, root)

    const workerChunks = (await readdir(chunksDir)).filter((name) => /^pdf\.worker-.*\.js$/u.test(name))
    assert.ok(workerChunks.length > 0, 'Electron build did not emit the bundled PDF.js worker module')

    console.log(JSON.stringify({
      check: 'electron-document-runtime',
      ok: true,
      documentChunk: chunkPath,
      workerChunks,
      generated,
      readMatrix,
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  app.exit(0)
}

async function findDocumentRuntimeChunk() {
  const entries = await readdir(chunksDir)
  for (const name of entries.filter((entry) => entry.endsWith('.js'))) {
    const path = join(chunksDir, name)
    const source = await readFile(path, 'utf8')
    if (source.includes('exports.createDocument = createDocument;')
      && source.includes('exports.extractDocument = extractDocument;')) {
      return path
    }
  }
  throw new Error(`Could not find the bundled document runtime in ${chunksDir}`)
}

async function createGeneratedDocuments(runtime, root) {
  const pdf = join(root, 'generated.pdf')
  const docx = join(root, 'generated.docx')
  const xlsx = join(root, 'generated.xlsx')
  const csv = join(root, 'generated.csv')

  await runtime.createDocument({
    filePath: pdf,
    format: 'pdf',
    title: 'Electron 中文 PDF',
    blocks: [{ type: 'paragraph', text: '打包后的主进程可以生成并重新读取中文。' }],
  })
  await runtime.createDocument({
    filePath: docx,
    format: 'docx',
    title: 'Electron Word 文档',
    blocks: [{ type: 'paragraph', text: 'DOCX 生成与正文提取正常。' }],
  })
  await runtime.createDocument({
    filePath: xlsx,
    format: 'xlsx',
    sheets: [{
      name: '模型',
      rows: [
        ['单价', '数量', '合计'],
        [12.5, 4, { formula: 'A2*B2', value: 50, numberFormat: '#,##0.00' }],
      ],
    }],
  })
  await runtime.createDocument({
    filePath: csv,
    format: 'csv',
    sheets: [{ name: '数据', rows: [['名称', '数量'], ['中文', 3]] }],
  })

  const pdfRead = await runtime.extractDocument(pdf)
  const docxRead = await runtime.extractDocument(docx)
  const xlsxRead = await runtime.extractDocument(xlsx)
  const csvRead = await runtime.extractDocument(csv)
  assert.match(pdfRead.text, /打包后的主进程/u)
  assert.equal(pdfRead.metadata.pageCount, 1)
  assert.match(docxRead.text, /DOCX 生成与正文提取正常/u)
  assert.match(xlsxRead.text, /12\.5\t4\t50\.00/u)
  assert.deepEqual(csvRead.sections[0].rows, [['名称', '数量'], ['中文', '3']])
  assert.deepEqual([...new Uint8Array(await readFile(csv)).slice(0, 3)], [0xEF, 0xBB, 0xBF])

  const XLSX = documentsRequire('xlsx')
  const workbook = XLSX.read(await readFile(xlsx), { type: 'buffer', cellFormula: true })
  assert.equal(workbook.Sheets['模型'].C2.f, 'A2*B2')
  assert.equal(workbook.Sheets['模型'].C2.v, 50)

  return ['pdf', 'docx', 'xlsx', 'csv']
}

async function createAndReadInputMatrix(runtime, root) {
  const XLSX = documentsRequire('xlsx')
  const JSZip = documentsRequire('jszip')

  const xls = join(root, 'legacy.xls')
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['项目', '金额'],
    ['历史预算', 320],
  ]), '预算')
  await writeFile(xls, XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }))

  const tsv = join(root, 'records.tsv')
  await writeFile(tsv, '\uFEFF名称\t状态\n文档\t已完成\n', 'utf8')

  const pptx = join(root, 'review.pptx')
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    '<p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/>',
    '<a:p><a:r><a:t>季度复盘</a:t></a:r></a:p>',
    '<a:p><a:r><a:t>营收增长 18%</a:t></a:r></a:p>',
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  ].join(''))
  await writeFile(pptx, await zip.generateAsync({ type: 'nodebuffer' }))

  const xlsRead = await runtime.extractDocument(xls)
  const tsvRead = await runtime.extractDocument(tsv)
  const pptxRead = await runtime.extractDocument(pptx)
  assert.match(xlsRead.text, /历史预算\t320/u)
  assert.deepEqual(tsvRead.sections[0].rows, [['名称', '状态'], ['文档', '已完成']])
  assert.match(pptxRead.text, /季度复盘/u)
  assert.equal(pptxRead.metadata.slideCount, 1)
  return ['xls', 'tsv', 'pptx']
}

async function verifyTextlessPdf(runtime, root) {
  const path = join(root, 'scan.pdf')
  await writeFile(path, textlessPdf(), 'ascii')
  const extracted = await runtime.extractDocument(path)
  assert.equal(extracted.text, '')
  assert.match(extracted.notes.join(' '), /OCR/u)
}

async function verifyLegacyOfficeErrors(runtime, root) {
  for (const extension of ['.doc', '.ppt', '.pps']) {
    const path = join(root, `legacy${extension}`)
    await assert.rejects(
      runtime.extractDocument(path),
      (error) => error instanceof Error && /DOCX.*PPTX/u.test(error.message),
    )
  }
}

function textlessPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ]
  let content = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(content, 'ascii'))
    content += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(content, 'ascii')
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  content += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  return `${content}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
}

main().catch((error) => {
  console.error(JSON.stringify({
    check: 'electron-document-runtime',
    ok: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    appBuildExists: existsSync(join(appRoot, 'out', 'main', 'index.js')),
  }))
  app.exit(1)
})
