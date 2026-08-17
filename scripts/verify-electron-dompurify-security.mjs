import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRequire = createRequire(join(repoRoot, 'packages', 'app', 'package.json'))

async function main() {
  await app.whenReady()
  const monacoEntry = appRequire.resolve('monaco-editor')
  const monacoRequire = createRequire(monacoEntry)
  const domPurifyScript = monacoRequire.resolve('dompurify/purify.min.js')
  const source = await readFile(domPurifyScript, 'utf8')

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  try {
    await window.loadURL('data:text/html;charset=utf-8,<title>DOMPurify security probe</title>')
    await window.webContents.executeJavaScript(`${source}\nvoid 0`)
    const report = await window.webContents.executeJavaScript(rendererProbeSource())

    assert.equal(report.version, '3.4.13')
    assert.equal(report.cases.length, 4)
    for (const result of report.cases) {
      assert.deepEqual(result.dangerousAttributes, [], `${result.id} retained a dangerous attribute`)
      assert.equal(result.scriptElements, 0, `${result.id} retained a script element`)
    }

    console.log(JSON.stringify({
      check: 'electron-dompurify-security',
      ok: true,
      domPurifyScript,
      ...report,
      runtime: { node: process.versions.node, electron: process.versions.electron },
    }))
  } finally {
    window.destroy()
  }
  app.exit(0)
}

function rendererProbeSource() {
  return String.raw`(() => {
    const payloads = [
      {
        id: 'event-attributes',
        input: '<img src="x" onerror="alert(1)"><div onclick="alert(2)">content</div>',
      },
      {
        id: 'dangerous-protocols',
        input: '<a href="javascript:alert(1)">link</a><form action="javascript:alert(2)"></form>',
      },
      {
        id: 'svg-and-custom-elements',
        input: '<svg><script>alert(1)</script><a xlink:href="javascript:alert(2)">x</a></svg><safe-widget onload="alert(3)"></safe-widget>',
        options: {
          CUSTOM_ELEMENT_HANDLING: {
            tagNameCheck: /^safe-widget$/,
            attributeNameCheck: null,
            allowCustomizedBuiltInElements: false,
          },
        },
      },
      {
        id: 'mutation-xss',
        input: '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=alert(1)>">',
      },
    ]

    const inspect = (root) => {
      const dangerousAttributes = []
      let scriptElements = 0
      const visit = (node) => {
        for (const child of node.children ?? []) {
          if (child.localName === 'script') scriptElements += 1
          for (const attribute of child.attributes) {
            const name = attribute.name.toLowerCase()
            const value = attribute.value.trim().toLowerCase()
            if (name.startsWith('on')
              || (['href', 'src', 'action', 'xlink:href'].includes(name)
                && (value.startsWith('javascript:') || value.startsWith('data:text/html')))) {
              dangerousAttributes.push({ element: child.localName, name, value })
            }
          }
          visit(child)
          if (child.localName === 'template') visit(child.content)
        }
      }
      visit(root)
      return { dangerousAttributes, scriptElements }
    }

    return {
      version: globalThis.DOMPurify.version,
      cases: payloads.map(({ id, input, options }) => {
        const sanitized = globalThis.DOMPurify.sanitize(input, options)
        const template = document.createElement('template')
        template.innerHTML = sanitized
        return { id, sanitized, ...inspect(template.content) }
      }),
    }
  })()`
}

main().catch((error) => {
  console.error(JSON.stringify({
    check: 'electron-dompurify-security',
    ok: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }))
  app.exit(1)
})
