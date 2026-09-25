// Real-environment baseline for HTML files in the extended workspace (taskbook UX-24).
//
// The user reported that an HTML game shows a blank page inside LS ("全白，或白底
// 带些字，无法游玩"), and that Git review and the missing PowerShell/Bash choice
// also misbehave. Before changing anything this gate fixes the entry points and
// what each of them is *supposed* to show, so later tasks (UX-25/26) can be judged
// against measured behaviour instead of the source alone.
//
// Three fixtures are written into an isolated workspace and opened three ways:
//   1. an ordinary installed browser (Chrome, else Edge) at a loopback HTTP URL,
//      which is the reference for "what the page really does";
//   2. the LS file preview (`<iframe sandbox="" srcdoc=...>` after DOMPurify);
//   3. the LS browser tab (real `webview` guest) at the same loopback URL.
//
// For each entry the gate records the rendered title/text, canvas pixels and game
// state, every subresource the document requested, script count, and the first
// console/CSP error — plus screenshots. It asserts only what the current contract
// claims, so a real regression in either entry fails the gate.
//
// Honesty boundary: the user's original HTML was never provided. These fixtures
// are synthetic and are labelled as such; nothing here claims the original file
// is fixed.
//
// Usage:
//   node scripts/verify-html-preview-baseline.mjs [--keep]

import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import * as os from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 25_000 })
const WINDOW = { width: 1280, height: 860 }
const FIXTURE_LABEL = '合成夹具（用户原例未提供）'

const STATIC_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>静态页夹具</title>
  <style>
    body { margin: 0; font-family: "Microsoft YaHei UI", sans-serif; background: #101418; color: #e8e8e8; }
    .panel { padding: 24px; background-image: url('assets/tile.svg'); background-repeat: repeat; }
    .card { background: #1c1c1c; border: 1px solid #343434; border-radius: 10px; padding: 16px; }
    .accent { color: #d8b45c; font-weight: 700; }
    #dynamic { color: #6fd08c; }
  </style>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('dynamic').textContent = '脚本已运行';
    });
  </script>
</head>
<body>
  <div class="panel">
    <div class="card">
      <h1>静态页夹具</h1>
      <p class="accent">CSS、背景图与中文都要保留。</p>
      <p id="dynamic">脚本未运行</p>
      <img id="sprite" src="assets/tile.svg" width="64" height="64" alt="sprite">
    </div>
  </div>
</body>
</html>
`

const CANVAS_GAME = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Canvas 小游戏夹具</title>
  <style>
    html, body { margin: 0; background: #05070a; color: #e8e8e8; font-family: "Microsoft YaHei UI", sans-serif; }
    canvas { display: block; margin: 12px; background: #123456; }
    #hud { margin: 0 12px 12px; }
  </style>
</head>
<body>
  <canvas id="stage" width="320" height="240"></canvas>
  <p id="hud">分数: 0</p>
  <script>
    (() => {
      const canvas = document.getElementById('stage');
      const ctx = canvas.getContext('2d');
      const state = { x: 20, y: 180, score: 0, frames: 0, ready: false };
      window.__gameState = state;
      function draw() {
        ctx.fillStyle = '#123456';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#6fd08c';
        ctx.fillRect(state.x, state.y, 24, 24);
        ctx.fillStyle = '#e8e8e8';
        ctx.font = '16px sans-serif';
        ctx.fillText('分数: ' + state.score, 12, 24);
        state.frames += 1;
      }
      function hud() { document.getElementById('hud').textContent = '分数: ' + state.score; }
      window.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight' || event.key === 'd') state.x += 8;
        if (event.key === 'ArrowLeft' || event.key === 'a') state.x -= 8;
        if (event.key === ' ') { state.score += 1; hud(); }
        draw();
      });
      canvas.addEventListener('click', () => { state.score += 1; hud(); draw(); });
      draw();
      state.ready = true;
    })();
  </script>
</body>
</html>
`

const MULTI_INDEX = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>多文件夹具</title>
  <link rel="stylesheet" href="game.css">
</head>
<body>
  <main class="board">
    <h1 class="title">多文件夹具</h1>
    <img class="sprite" src="sprite.svg" alt="sprite" width="48" height="48">
    <p class="level">关卡: <span id="level">加载中</span></p>
    <button id="step" type="button">前进一步</button>
    <p class="steps">步数: <span id="steps">0</span></p>
  </main>
  <script type="module" src="game.js"></script>
</body>
</html>
`

const MULTI_CSS = `.board {
  padding: 20px;
  background: #1c2a1f;
  color: #e8e8e8;
  font-family: "Microsoft YaHei UI", sans-serif;
}

.title {
  color: #d8b45c;
}

.sprite {
  display: block;
  margin: 8px 0;
}
`

const MULTI_JS = `const state = { steps: 0, level: null, ready: false };
window.__multiState = state;

fetch('./level.json')
  .then((response) => response.json())
  .then((data) => {
    state.level = data.level;
    document.getElementById('level').textContent = String(data.level);
  })
  .catch((error) => {
    state.fetchError = String(error);
    document.getElementById('level').textContent = '加载失败';
  });

document.getElementById('step').addEventListener('click', () => {
  state.steps += 1;
  document.getElementById('steps').textContent = String(state.steps);
});

state.ready = true;
`

const MULTI_LEVEL = '{ "level": 7, "target": 3 }\n'

const SPRITE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <rect width="64" height="64" fill="#2f6f4f"/>
  <circle cx="32" cy="32" r="14" fill="#d8b45c"/>
</svg>
`

const GAME_COLOR = { r: 0x12, g: 0x34, b: 0x56 }

/** Everything one entry point can report about the document it rendered. */
const PAGE_PROBE = `(() => {
  const canvas = document.querySelector('canvas');
  const sample = canvas ? (() => {
    try {
      const data = canvas.getContext('2d').getImageData(4, 4, 1, 1).data;
      return [data[0], data[1], data[2], data[3]];
    } catch (error) {
      return 'error:' + error.name;
    }
  })() : null;
  const image = document.querySelector('img');
  const computed = (selector) => {
    const node = document.querySelector(selector);
    return node ? getComputedStyle(node).backgroundColor : null;
  };
  return {
    url: location.href,
    readyState: document.readyState,
    htmlLength: document.documentElement ? document.documentElement.outerHTML.length : -1,
    title: document.title,
    text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
    scripts: document.scripts.length,
    styleSheets: document.styleSheets.length,
    bodyBackground: document.body ? getComputedStyle(document.body).backgroundColor : null,
    styles: {
      body: computed('body'),
      board: computed('.board'),
      canvas: computed('canvas'),
      heading: document.querySelector('h1') ? getComputedStyle(document.querySelector('h1')).color : null,
    },
    canvas: canvas ? {
      width: canvas.width,
      height: canvas.height,
      sample,
      gameState: window.__gameState ? { ...window.__gameState } : null,
      multiState: window.__multiState ? { ...window.__multiState } : null,
    } : null,
    image: image ? { complete: image.complete, naturalWidth: image.naturalWidth } : null,
    dynamic: document.getElementById('dynamic')?.textContent?.trim() ?? null,
    level: document.getElementById('level')?.textContent?.trim() ?? null,
    steps: document.getElementById('steps')?.textContent?.trim() ?? null,
    resources: performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name.replace(location.origin, ''),
      initiatorType: entry.initiatorType,
      transferSize: entry.transferSize,
      duration: Math.round(entry.duration),
    })),
  };
})()`

function createRecorder() {
  const observations = []
  const failures = []
  return {
    note: (entry) => observations.push(entry),
    check: (condition, check, detail) => {
      if (!condition) failures.push({ check, detail })
      return Boolean(condition)
    },
    failures,
    observations,
  }
}

async function writeFixtures(workspaceDir) {
  await Promise.all([
    mkdir(join(workspaceDir, 'assets'), { recursive: true }),
    mkdir(join(workspaceDir, 'multi-file'), { recursive: true }),
  ])
  await writeFile(join(workspaceDir, 'static-page.html'), STATIC_PAGE, 'utf8')
  await writeFile(join(workspaceDir, 'canvas-game.html'), CANVAS_GAME, 'utf8')
  await writeFile(join(workspaceDir, 'assets', 'tile.svg'), SPRITE_SVG, 'utf8')
  await writeFile(join(workspaceDir, 'multi-file', 'index.html'), MULTI_INDEX, 'utf8')
  await writeFile(join(workspaceDir, 'multi-file', 'game.css'), MULTI_CSS, 'utf8')
  await writeFile(join(workspaceDir, 'multi-file', 'game.js'), MULTI_JS, 'utf8')
  await writeFile(join(workspaceDir, 'multi-file', 'level.json'), MULTI_LEVEL, 'utf8')
  await writeFile(join(workspaceDir, 'multi-file', 'sprite.svg'), SPRITE_SVG, 'utf8')
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** Loopback static server: the controlled local HTTP address of the task. */
async function startStaticServer(root) {
  const requests = []
  const server = createServer(async (request, response) => {
    const requested = new URL(request.url ?? '/', 'http://127.0.0.1')
    const relative = normalize(decodeURIComponent(requested.pathname)).replace(/^[\\/]+/u, '')
    const target = join(root, relative)
    requests.push({ path: requested.pathname })
    if (target !== root && !target.startsWith(root + sep)) {
      response.writeHead(403).end('forbidden')
      return
    }
    try {
      const body = await readFile(target)
      response.writeHead(200, { 'content-type': MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream' })
      response.end(body)
    } catch {
      response.writeHead(404).end('not found')
    }
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  }
}

const BROWSER_CANDIDATES = [
  { name: 'Chrome', executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'Chrome', executable: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'Edge', executable: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'Edge', executable: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
]

function findSystemBrowser() {
  return BROWSER_CANDIDATES.find((candidate) => existsSync(candidate.executable)) ?? null
}

async function connectTarget(port, predicate, label, { timeoutMs = 45_000 } = {}) {
  const target = await harness.waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined)
    if (!response?.ok) return undefined
    const values = await response.json()
    return values.find((candidate) => candidate.webSocketDebuggerUrl && predicate(candidate))
  }, timeoutMs, label)
  const client = new harness.CdpClient(target.webSocketDebuggerUrl)
  await client.send('Runtime.enable')
  await client.send('Log.enable')
  await client.send('Page.enable')
  return { client, target }
}

/** Launch the ordinary browser headless and connect to the fixture page target. */
async function launchSystemBrowser({ browser, url, port, profileDir }) {
  const child = spawn(browser.executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--window-size=1024,720',
    url,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.resume()
  child.stderr.resume()
  const { client } = await connectTarget(port, (target) => target.url.startsWith(url), `${browser.name} fixture page`)
  return { child, client }
}

async function evaluate(client, expression) {
  return client.evaluate(expression)
}

/** Console/CSP/exception entries the client has seen since an index. */
function readEvents(client, fromIndex) {
  return client.events.slice(fromIndex).flatMap((message) => {
    if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry
      return [{
        kind: 'log',
        level: entry.level,
        source: entry.source,
        text: String(entry.text).slice(0, 200),
        url: entry.url ?? null,
      }]
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      return [{
        kind: 'exception',
        text: String(details.exception?.description ?? details.text).slice(0, 200),
        url: details.url ?? null,
      }]
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      return [{
        kind: 'console',
        level: message.params.type,
        text: message.params.args.map((argument) => argument.value ?? argument.description ?? '').join(' ').slice(0, 200),
      }]
    }
    return []
  }).filter((entry) => entry.level !== 'verbose')
}

async function captureScreenshot(client, dir, name) {
  await mkdir(dir, { recursive: true })
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(dir, name), Buffer.from(shot.data, 'base64'))
  return join(dir, name)
}

async function seedPreferences(client, workspaceDir, filePath) {
  const fileTab = `file:${encodeURIComponent(workspaceDir)}|${encodeURIComponent(filePath)}`
  const layout = {
    collapsed: false,
    fullscreen: true,
    activeTab: fileTab,
    openTabs: [fileTab],
    openRequest: { root: workspaceDir, path: filePath },
    fileNavigatorCollapsed: false,
    fileNavigatorWidth: 214,
    reviewNavigatorWidth: 214,
    expandedPaths: [],
    drafts: {},
    browserTabs: [],
  }
  const preferences = {
    'littlesheep.ui.workspacePanelCollapsed': 'false',
    'littlesheep.ui.workspacePanelFullscreen': 'true',
    'littlesheep.ui.workspacePanelTab': fileTab,
    'littlesheep.ui.workspacePanelOpenTabs': JSON.stringify([fileTab]),
    'littlesheep.ui.workspacePanelOpenRoot': workspaceDir,
    'littlesheep.ui.workspacePanelOpenPath': filePath,
    'littlesheep.ui.workspaceFileNavigatorCollapsed': 'false',
    'littlesheep.ui.workspaceSessionLayouts': JSON.stringify({ __draft__: layout }),
  }
  await client.evaluate(`(() => {
    const values = ${JSON.stringify(preferences)};
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    return true;
  })()`)
}

/** Open a workspace file through the real file tree row (waiting for the tree). */
async function openFileFromTree(client, name) {
  const clicked = await harness.waitFor(async () => {
    const done = await client.evaluate(`(() => {
      const row = [...document.querySelectorAll('.workspace-tree-row.file')]
        .find((node) => node.querySelector('.workspace-tree-name')?.textContent?.trim() === ${JSON.stringify(name)});
      if (!(row instanceof HTMLElement)) return false;
      row.click();
      return true;
    })()`)
    return done ? true : undefined
  }, 20_000, `workspace file row ${name}`)
  return clicked
}

async function expandDirectory(client, name) {
  const clicked = await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('.workspace-tree-row.directory')]
      .find((node) => node.querySelector('.workspace-tree-name')?.textContent?.trim() === ${JSON.stringify(name)});
    if (!(row instanceof HTMLElement)) return false;
    if (row.getAttribute('aria-expanded') !== 'true') row.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`workspace directory row not available: ${name}`)
}

/**
 * Probe the sandboxed preview document.
 *
 * `sandbox=""` gives the frame an opaque origin, so the app document cannot read
 * it, and Electron runs it out of process (`/json/list` shows an `iframe` target
 * whose url is `about:srcdoc`), so the page target reports no child frames. The
 * gate therefore attaches to that frame target directly and falls back to a CDP
 * isolated world for same-process frames.
 */
/**
 * Read every preview document through its own debug target.
 *
 * `sandbox=""` gives the frame an opaque origin, so the app document cannot read
 * it, and Electron runs each preview as an out-of-process frame whose own target
 * (`/json/list`, type `iframe`, url `about:srcdoc`) is the only place the rendered
 * document can be observed. The page target reports no child frames at all.
 */
async function probeAllPreviewFrames(debuggingPort) {
  const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
  const targets = await response.json()
  const documents = []
  for (const target of targets.filter((candidate) => candidate.type === 'iframe' && candidate.webSocketDebuggerUrl)) {
    const frameClient = new harness.CdpClient(target.webSocketDebuggerUrl)
    try {
      await frameClient.send('Runtime.enable')
      documents.push(await frameClient.evaluate(PAGE_PROBE))
    } catch (error) {
      documents.push({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      frameClient.close()
    }
  }
  return documents
}

/** Every mounted preview iframe with the sanitized document it was given. */
async function readPreviewFrames(client) {
  return client.evaluate(`(() => {
    return [...document.querySelectorAll('.workspace-preview-html')].map((node) => {
      const srcdoc = node.getAttribute('srcdoc') || '';
      const shell = node.closest('.workspace-preview-html-shell');
      return {
        title: node.getAttribute('title'),
        active: Boolean(node.closest('.workspace-tab-view.active')),
        note: shell?.querySelector('.workspace-preview-html-note')?.textContent?.trim() ?? null,
        srcdocLength: srcdoc.length,
        srcdocHead: srcdoc.slice(0, 240),
        hasScriptTag: /<script/i.test(srcdoc),
        hasCsp: srcdoc.includes('Content-Security-Policy'),
        hasBase: /<base href="file:\\/\\//i.test(srcdoc),
        hasStyleTag: /<style/i.test(srcdoc),
        hasTitleTag: /<title/i.test(srcdoc),
        sandbox: node.getAttribute('sandbox'),
      };
    });
  })()`)
}

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const recorder = createRecorder()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-html-baseline-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const browserProfileDir = join(root, 'system-browser')
  const logPath = join(root, 'electron.log')
  const screenshotDir = join(root, 'screenshots')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0 })
  const browser = findSystemBrowser()
  let electron
  let locator
  let client
  let server
  let systemBrowser
  let fingerprint = null
  try {
    await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFixtures(workspaceDir)
    // The repository exists before the app boots, so the review surface reads a
    // workspace it has always known; the changes are made later on purpose.
    const gitRepository = await gitInit(workspaceDir)
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify({
      version: 1,
      providers: [{
        id: 'acceptance',
        name: 'Acceptance',
        baseURL: provider.baseURL,
        apiKey: 'acceptance-key',
        timeoutSeconds: 10,
        models: ['slow-a'],
      }],
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: 'acceptance/slow-a',
          reasoning: 'auto',
          profile: 'general',
          timeoutSeconds: 60,
          maxRecoveryAttempts: 1,
        },
      },
      desktop: { closePolicy: 'always-background' },
    }, null, 2)}\n`, 'utf8')

    server = await startStaticServer(workspaceDir)
    recorder.note({ step: 'fixtures', root, origin: server.origin, label: FIXTURE_LABEL, browser: browser?.name ?? null })

    // 1. The reference rendering: the same files over a loopback HTTP address.
    if (!browser) {
      recorder.check(false, 'an installed ordinary browser was found for the reference rendering', null)
    } else {
      const port = await harness.reservePort()
      systemBrowser = await launchSystemBrowser({
        browser,
        url: `${server.origin}/canvas-game.html`,
        port,
        profileDir: browserProfileDir,
      })
      const version = await systemBrowser.client.send('Browser.getVersion')
      const gameReference = await harness.waitFor(
        () => evaluate(systemBrowser.client, `window.__gameState ? (${PAGE_PROBE}) : null`),
        30_000,
        'reference canvas game',
      )
      const gameShot = await captureScreenshot(systemBrowser.client, screenshotDir, 'reference-canvas-game.png')
      recorder.note({
        step: 'reference-canvas-game',
        browser: browser.name,
        product: version.product,
        probe: gameReference,
        errors: readEvents(systemBrowser.client, 0),
        screenshot: gameShot,
      })
      recorder.check(
        Array.isArray(gameReference.canvas?.sample)
        && gameReference.canvas.sample[0] === GAME_COLOR.r
        && gameReference.canvas.sample[1] === GAME_COLOR.g
        && gameReference.canvas.sample[2] === GAME_COLOR.b,
        'the reference browser really paints the game canvas (script ran)',
        { sample: gameReference.canvas?.sample ?? null },
      )
      recorder.check(
        gameReference.canvas?.gameState?.ready === true,
        'the reference browser exposes the game state',
        gameReference.canvas?.gameState ?? null,
      )

      // Interaction in the reference: keyboard moves the player, click scores.
      const before = gameReference.canvas?.gameState ?? {}
      const canvasRect = await canvasPointInViewport(systemBrowser.client)
      await dispatchGameInput(systemBrowser.client, canvasRect)
      const afterInteraction = await waitForGameChange(systemBrowser.client, before, 'reference game interaction')
      recorder.note({ step: 'reference-canvas-interaction', before, after: afterInteraction })
      recorder.check(afterInteraction.x > Number(before.x ?? 0), 'ArrowRight moves the player in the reference browser', { before: before.x ?? null, after: afterInteraction.x })
      recorder.check(afterInteraction.score > Number(before.score ?? 0), 'clicking the canvas scores in the reference browser', { before: before.score ?? null, after: afterInteraction.score })

      // Static page and multi-file page in the reference.
      for (const [step, path, settle] of [
        ['reference-static-page', 'static-page.html', `document.getElementById('dynamic')?.textContent?.trim() === '脚本已运行'`],
        ['reference-multi-file', 'multi-file/index.html', `document.getElementById('level')?.textContent?.trim() === '7'`],
      ]) {
        await systemBrowser.client.send('Page.navigate', { url: `${server.origin}/${path}` })
        // Wait for the page's own subresources, not just for the HTML to parse:
        // the first probe used to run before the stylesheet, image and fetch landed.
        const probe = await harness.waitFor(
          () => evaluate(systemBrowser.client, `document.readyState === 'complete' && (${settle}) ? (${PAGE_PROBE}) : null`),
          30_000,
          step,
        )
        const shot = await captureScreenshot(systemBrowser.client, screenshotDir, `${step}.png`)
        recorder.note({ step, browser: browser.name, probe, screenshot: shot })
        if (step === 'reference-static-page') {
          recorder.check(probe.dynamic === '脚本已运行', 'the reference browser runs the static page script', { dynamic: probe.dynamic })
          recorder.check(probe.image?.complete === true && probe.image.naturalWidth === 64, 'the reference browser loads the page image', probe.image)
          recorder.check(probe.styleSheets >= 1, 'the reference browser applies the page stylesheet', { styleSheets: probe.styleSheets })
          recorder.check(
            probe.resources.some((entry) => entry.name.endsWith('assets/tile.svg')),
            'the reference browser requests the local background/image asset',
            probe.resources,
          )
        } else {
          recorder.check(probe.level === '7', 'the reference browser loads the local JSON over fetch', { level: probe.level })
          recorder.check(probe.scripts === 1, 'the reference browser loads the module script', { scripts: probe.scripts })
          recorder.check(
            probe.resources.some((entry) => entry.name.endsWith('game.css')),
            'the reference browser requests the local stylesheet',
            probe.resources,
          )
        }
      }
    }

    // 2. The LS file preview for the same three fixtures, opened from the file tree.
    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Log.enable')
    await client.send('Page.enable')
    await harness.desktopAction(locator, 'resize', WINDOW)
    await harness.waitFor(
      () => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer textarea',
    )
    await seedPreferences(client, workspaceDir, join(workspaceDir, 'static-page.html'))
    const beforeReload = await client.evaluate('performance.timeOrigin')
    await client.send('Page.reload', { ignoreCache: false })
    await harness.waitFor(async () => {
      const state = await client.evaluate(`(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin }))()`)
        .catch(() => undefined)
      if (!state) return undefined
      return state.readyState === 'complete' && state.timeOrigin !== beforeReload ? state.timeOrigin : undefined
    }, harness.actionTimeoutMs, 'renderer reload with the HTML fixture open')
    const eventsFrom = client.events.length

    const previewSteps = [
      // UX-25 acceptance: each fixture must render its own document with its own
      // styles, whether or not its content was ready before the pane mounted.
      {
        step: 'preview-static-page',
        name: 'static-page.html',
        marker: '静态页夹具',
        title: '静态页夹具',
        documents: 1,
        seeded: true,
        style: { key: 'body', expected: 'rgb(16, 20, 24)', styleSheets: 1 },
        expand: null,
      },
      {
        step: 'preview-canvas-game',
        name: 'canvas-game.html',
        marker: '分数:',
        title: 'Canvas 小游戏夹具',
        documents: 2,
        seeded: false,
        style: { key: 'canvas', expected: 'rgb(18, 52, 86)', styleSheets: 1 },
        expand: null,
      },
      {
        // This fixture styles itself through an external stylesheet, which the
        // static preview cannot load yet (UX-25's resource half); the document
        // itself must still render.
        step: 'preview-multi-file',
        name: 'index.html',
        marker: '多文件夹具',
        title: '多文件夹具',
        documents: 3,
        seeded: false,
        style: { key: 'board', expected: null, styleSheets: 0 },
        expand: 'multi-file',
      },
    ]
    const renderOutcomes = []
    for (const entry of previewSteps) {
      if (entry.expand) await expandDirectory(client, entry.expand)
      await harness.waitFor(
        () => client.evaluate(`Boolean([...document.querySelectorAll('.workspace-tree-name')].find((node) => node.textContent?.trim() === ${JSON.stringify(entry.name)})) || null`),
        15_000,
        `${entry.name} in the file tree`,
      )
      await openFileFromTree(client, entry.name)
      const frames = await harness.waitFor(async () => {
        const mounted = await readPreviewFrames(client)
        return mounted.some((candidate) => candidate.title === `HTML 预览：${entry.name}`) ? mounted : undefined
      }, 25_000, `${entry.step} iframe`)
      const frame = frames.find((candidate) => candidate.title === `HTML 预览：${entry.name}`)
      const documents = await harness.waitFor(async () => {
        const probed = await probeAllPreviewFrames(debuggingPort)
        const newest = probed.at(-1)
        return probed.length >= entry.documents && newest?.readyState === 'complete' ? probed : undefined
      }, 25_000, `${entry.step} documents`)
      // Give a late document a chance to arrive before calling it blank.
      let settled = documents
      if (!documents.some((document) => document.text?.includes(entry.marker))) {
        await delay(3_000)
        settled = await probeAllPreviewFrames(debuggingPort)
      }
      const renderedDocument = settled.find((document) => document.text?.includes(entry.marker)) ?? null
      const newest = settled.at(-1)
      renderOutcomes.push({ step: entry.step, file: entry.name, rendered: Boolean(renderedDocument) })
      const shot = await captureScreenshot(client, screenshotDir, `${entry.step}.png`)
      recorder.note({
        step: entry.step,
        entry: `工作区文件树 → ${entry.name}`,
        seededBeforeMount: entry.seeded,
        rendered: Boolean(renderedDocument),
        mountedFrames: frames.map(({ title, active }) => ({ title, active })),
        srcdoc: frame,
        documents: settled,
        errors: readEvents(client, eventsFrom),
        screenshot: shot,
      })
      // Stable contract of the preview pipeline, for every file.
      recorder.check(frame.hasScriptTag === false, `${entry.step}: the preview strips script tags`, frame)
      recorder.check(frame.hasCsp === true && frame.hasBase === true, `${entry.step}: the preview injects its CSP and file base`, frame)
      recorder.check(frame.sandbox === '', `${entry.step}: the preview frame stays fully sandboxed`, { sandbox: frame.sandbox })
      recorder.check(
        typeof frame.note === 'string' && frame.note.includes('不运行页面脚本'),
        `${entry.step}: the static preview says it does not run page scripts`,
        { note: frame.note },
      )
      // UX-25: every fixture must render its own document and keep its styles, no
      // matter whether its content was ready before the pane mounted.
      recorder.check(Boolean(renderedDocument), `${entry.step}: the opened file renders its own document`, settled)
      if (renderedDocument) {
        recorder.check(
          renderedDocument.scripts === 0,
          `${entry.step}: no script executes in the preview document`,
          { scripts: renderedDocument.scripts },
        )
        recorder.check(
          renderedDocument.styleSheets === entry.style.styleSheets,
          entry.style.styleSheets > 0
            ? `${entry.step}: the preview keeps the document's own stylesheet`
            : `${entry.step}: an external stylesheet is still not loadable (recorded; UX-25 resource half)`,
          { styleSheets: renderedDocument.styleSheets, expected: entry.style.styleSheets, srcdoc: frame.srcdocLength },
        )
        recorder.check(
          renderedDocument.title === entry.title,
          `${entry.step}: the preview keeps the document title`,
          { title: renderedDocument.title, expected: entry.title },
        )
        if (entry.style.expected) {
          recorder.check(
            renderedDocument.styles?.[entry.style.key] === entry.style.expected,
            `${entry.step}: the document's own CSS decides the rendered colors`,
            { style: entry.style.key, value: renderedDocument.styles?.[entry.style.key] ?? null, expected: entry.style.expected },
          )
        }
        recorder.check(
          renderedDocument.canvas === null || renderedDocument.canvas?.gameState == null,
          `${entry.step}: the preview never starts page scripts`,
          renderedDocument.canvas,
        )
      }
    }
    recorder.note({ step: 'preview-render-outcomes', outcomes: renderOutcomes })
    recorder.check(
      renderOutcomes.every((entry) => entry.rendered),
      'every opened HTML file renders in the preview (UX-25: the blank-frame race is gone)',
      renderOutcomes,
    )

    // 2b. UX-25 item 3, draft half: the preview shows the edited draft, not the file
    // on disk, and a new document replaces the frame instead of reusing it.
    const draftMarker = '草稿标记-51ab'
    await openFileFromTree(client, 'static-page.html')
    await harness.waitFor(async () => {
      const mounted = await readPreviewFrames(client)
      return mounted.some((candidate) => candidate.title === 'HTML 预览：static-page.html') ? mounted : undefined
    }, 20_000, 'static page preview before editing')
    const sourceMode = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('.workspace-tab-view.active .workspace-preview-actions button')]
        .find((node) => (node.textContent || '').trim() === '编辑');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`)
    if (!sourceMode) throw new Error('the HTML edit action was not available')
    await harness.waitFor(
      () => client.evaluate(`document.querySelector('.workspace-editor-monaco .monaco-editor:not(.workspace-monaco-readonly)') ? true : null`),
      20_000,
      'HTML source editor in edit mode',
    )
    const typed = await typeIntoEditor(client, draftMarker)
    let draftRendered = null
    let draftFailure = typed === 'failed' ? 'the CDP typing gesture did not reach the editor model' : null
    let backToPreview = false
    if (typed !== 'failed') {
      backToPreview = await client.evaluate(`(() => {
        const button = [...document.querySelectorAll('.workspace-tab-view.active .workspace-preview-actions button')]
          .find((node) => /^查看(源代码|预览)$/u.test((node.textContent || '').trim()));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`)
      if (!backToPreview) throw new Error('the HTML preview toggle was not available')
      try {
        draftRendered = await harness.waitFor(async () => {
          const documents = await probeAllPreviewFrames(debuggingPort)
          const withMarker = documents.find((document) => document.text?.includes(draftMarker))
          return withMarker ?? undefined
        }, 15_000, 'draft document in the preview')
      } catch (error) {
        draftFailure = error instanceof Error ? error.message : String(error)
      }
    }
    const draftStore = await client.evaluate(`(() => {
      const layouts = JSON.parse(localStorage.getItem('littlesheep.ui.workspaceSessionLayouts') || '{}');
      const drafts = Object.values(layouts).flatMap((layout) => Object.values(layout?.drafts ?? {}));
      return {
        draftCount: drafts.length,
        markerInDraft: drafts.some((draft) => String(draft?.editorText ?? '').includes(${JSON.stringify(draftMarker)})),
      };
    })()`)
    const draftShot = await captureScreenshot(client, screenshotDir, 'preview-html-draft.png')
    recorder.note({
      step: 'preview-html-draft',
      entry: '工作区文件树 → static-page.html → 编辑 → 输入 → 预览',
      marker: draftMarker,
      typed,
      appearedInPreview: Boolean(draftRendered),
      failure: draftFailure,
      draftStore,
      document: draftRendered ?? null,
      screenshot: draftShot,
    })
    // Recorded, not asserted: the typed draft reached the editor's model and the
    // session draft store, but the mounted preview kept the on-disk document
    // (srcdoc length unchanged), so the draft-follows-preview path has no passing
    // measurement yet — see the gate limits and the UX-25 record.
    if (draftRendered) {
      recorder.check(
        draftRendered.styleSheets >= 1 && draftRendered.scripts === 0,
        'the edited draft renders with its styles and without scripts',
        { styleSheets: draftRendered.styleSheets, scripts: draftRendered.scripts },
      )
    }

    // 2c. Run entry (UX-26): the toolbar runs the *saved* page through the bounded
    // loopback service and opens it in the embedded browser. A dirty draft must be
    // asked about first; the draft is seeded through the session store because the
    // CDP typing gesture did not reach the live pane state in this build (see the
    // UX-25 record and the draft step above).
    const staticPagePath = join(workspaceDir, 'static-page.html')
    const diskText = await readFile(staticPagePath, 'utf8')
    const staticPageInfo = await stat(staticPagePath)
    await seedDraft(client, workspaceDir, staticPagePath, {
      editorText: `${diskText}\n<!-- ${draftMarker} -->\n`,
      savedText: diskText,
      // The pane only restores a draft whose modifiedAt still matches the file it
      // was taken from, so the fixture has to carry the real timestamp.
      modifiedAt: staticPageInfo.mtimeMs,
    })
    await reloadRenderer(client)
    await harness.waitFor(() => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`), harness.startTimeoutMs, 'composer after draft seeding')
    await openFileFromTree(client, 'static-page.html')
    await harness.waitFor(async () => {
      const mounted = await readPreviewFrames(client)
      return mounted.some((candidate) => candidate.title === 'HTML 预览：static-page.html') ? mounted : undefined
    }, 20_000, 'static page restored with its draft')
    const dirtyRun = await clickPreviewAction(client, '运行')
    const dirtyPrompt = dirtyRun
      ? await harness.waitFor(() => client.evaluate(`(() => {
          const node = document.querySelector('.workspace-tab-view.active .workspace-preview-run-message');
          return node ? { text: node.textContent.trim(), actions: [...document.querySelectorAll('.workspace-tab-view.active .workspace-preview-actions button')].map((b) => b.textContent.trim()) } : null;
        })()`), 10_000, 'dirty draft prompt').catch(() => null)
      : null
    const serversWhilePrompted = dirtyPrompt ? await apiJson(locator, '/workspace/preview-server') : null
    const cancelled = dirtyPrompt ? await clickPreviewAction(client, '取消') : false
    const serversAfterCancel = cancelled ? await apiJson(locator, '/workspace/preview-server') : null
    const promptShot = await captureScreenshot(client, screenshotDir, 'html-run-dirty-prompt.png')
    recorder.note({
      step: 'html-run-dirty-draft',
      entry: '工作区 → static-page.html（会话草稿：未保存修改）→ 运行',
      clicked: dirtyRun,
      prompt: dirtyPrompt,
      serversWhilePrompted: serversWhilePrompted?.servers ?? null,
      cancelled,
      serversAfterCancel: serversAfterCancel?.servers ?? null,
      screenshot: promptShot,
    })
    // Recorded, not asserted: in this build neither the CDP typing gesture nor a
    // seeded session draft made the live pane dirty, so the prompt path has no
    // passing real-window measurement yet (its rules are unit-tested in
    // html-run.test.ts). UX-26's dirty-draft item stays open.
    if (dirtyPrompt) {
      recorder.check(
        dirtyPrompt.text.includes('未保存') && dirtyPrompt.actions.includes('保存并运行') && dirtyPrompt.actions.includes('取消'),
        'a dirty draft is asked about before running, offering save-and-run or cancel',
        dirtyPrompt,
      )
      recorder.check(
        serversWhilePrompted?.servers?.length === 0 && serversAfterCancel?.servers?.length === 0,
        'no run service starts while the draft question is open or after cancelling',
        { whilePrompted: serversWhilePrompted?.servers ?? null, afterCancel: serversAfterCancel?.servers ?? null },
      )
    } else {
      // Leave no half-started service behind for the steps that follow.
      await apiJson(locator, `/workspace/preview-server?root=${encodeURIComponent(workspaceDir)}`, { method: 'DELETE' }).catch(() => undefined)
    }

    // A clean file runs: service starts, browser tab opens, the game is playable.
    await openFileFromTree(client, 'canvas-game.html')
    await harness.waitFor(async () => {
      const mounted = await readPreviewFrames(client)
      return mounted.some((candidate) => candidate.title === 'HTML 预览：canvas-game.html') ? mounted : undefined
    }, 20_000, 'canvas game preview before running')
    const startedRun = await clickPreviewAction(client, '运行')
    const runServers = await harness.waitFor(async () => {
      const payload = await apiJson(locator, '/workspace/preview-server')
      return payload.servers?.length > 0 ? payload.servers : undefined
    }, 20_000, 'preview server for the run')
    const runServer = runServers[0]
    const runTarget = await harness.waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
      // The exact URL: an earlier tab for the same service must not be mistaken for
      // this run's tab.
      return targets.find((candidate) => candidate.webSocketDebuggerUrl && candidate.url === runServer.url) ?? undefined
    }, 30_000, 'browser tab for the run')
    const runGuest = new harness.CdpClient(runTarget.webSocketDebuggerUrl)
    await runGuest.send('Runtime.enable')
    await runGuest.send('Log.enable')
    await runGuest.send('Page.enable')
    let runProbe
    try {
      runProbe = await harness.waitFor(() => runGuest.evaluate(`window.__gameState ? (${PAGE_PROBE}) : null`), 30_000, 'game running from the run entry')
    } catch (error) {
      const guestState = await runGuest.evaluate(`(() => ({
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
        html: document.documentElement ? document.documentElement.outerHTML.slice(0, 200) : null,
      }))()`).catch((probeError) => ({ error: String(probeError) }))
      const servers = await apiJson(locator, '/workspace/preview-server').catch(() => null)
      throw new Error(`${error instanceof Error ? error.message : String(error)}; guest=${JSON.stringify(guestState)}; servers=${JSON.stringify(servers?.servers ?? null)}`)
    }
    const isolation = await runGuest.evaluate(`(() => ({
      lsBridge: typeof window.littlesheep !== 'undefined' || typeof window.__DSH__ !== 'undefined',
      nodeRequire: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
      origin: location.origin,
      storageKeys: Object.keys(localStorage).length,
    }))()`)
    const runPoint = await canvasPointInViewport(runGuest)
    await dispatchGameInput(runGuest, runPoint)
    const runAfterInput = await waitForGameChange(runGuest, runProbe.canvas?.gameState ?? {}, 'game input inside the run tab')
    const runShot = await captureScreenshot(runGuest, screenshotDir, 'html-run-entry.png')
    recorder.note({
      step: 'html-run-entry',
      entry: '工作区 → canvas-game.html → 运行',
      clicked: startedRun,
      server: runServer,
      tabUrl: runTarget.url,
      probe: runProbe,
      isolation,
      interaction: { before: runProbe.canvas?.gameState ?? null, after: runAfterInput },
      screenshot: runShot,
    })
    recorder.check(
      Array.isArray(runProbe.canvas?.sample)
      && runProbe.canvas.sample[0] === GAME_COLOR.r
      && runProbe.canvas.sample[1] === GAME_COLOR.g
      && runProbe.canvas.sample[2] === GAME_COLOR.b,
      'running the page paints the game canvas',
      { sample: runProbe.canvas?.sample ?? null },
    )
    recorder.check(
      runProbe.canvas?.gameState?.ready === true && runAfterInput.score > 0,
      'the run entry produces a playable page (real input changes the game state)',
      { before: runProbe.canvas?.gameState ?? null, after: runAfterInput },
    )
    recorder.check(
      isolation.lsBridge === false && isolation.nodeRequire === false,
      'the running page gets no LS bridge and no Node integration',
      isolation,
    )

    // The service answers only its own tokenised, in-root paths.
    const runOrigin = new URL(runServer.url).origin
    const runToken = new URL(runServer.url).pathname.split('/')[1]
    const traversal = await fetch(`${runOrigin}/${runToken}/..%2F..%2Fbaseline-outside.txt`).then((r) => r.status).catch(() => 0)
    const wrongToken = await fetch(`${runOrigin}/${'0'.repeat(32)}/canvas-game.html`).then((r) => r.status).catch(() => 0)
    const entryStatus = await fetch(runServer.url).then((r) => r.status).catch(() => 0)
    // A multi-file page is the reason the run entry exists: relative CSS, module,
    // image and fetch must all answer with their real content type.
    const multiFileRun = await apiJson(locator, '/workspace/preview-server', {
      method: 'POST',
      body: { root: workspaceDir, path: join(workspaceDir, 'multi-file', 'index.html') },
    })
    const assets = {}
    for (const asset of ['multi-file/index.html', 'multi-file/game.css', 'multi-file/game.js', 'multi-file/level.json', 'multi-file/sprite.svg']) {
      const response = await fetch(`${runOrigin}/${runToken}/${asset}`).catch(() => null)
      assets[asset] = response ? { status: response.status, contentType: response.headers.get('content-type') } : { status: 0 }
    }
    recorder.note({ step: 'html-run-service-boundary', runServer, multiFileRun, entryStatus, traversal, wrongToken, assets })
    recorder.check(entryStatus === 200, 'the run service serves the entry document', { entryStatus })
    recorder.check([403, 404].includes(traversal), 'the run service refuses a traversal outside the workspace', { traversal })
    recorder.check(wrongToken === 404, 'the run service refuses a request without its token', { wrongToken })
    recorder.check(
      assets['multi-file/game.css']?.status === 200
      && assets['multi-file/game.js']?.status === 200
      && assets['multi-file/level.json']?.status === 200
      && assets['multi-file/sprite.svg']?.status === 200,
      'a running multi-file page gets its stylesheet, module, JSON and image',
      assets,
    )
    recorder.check(
      assets['multi-file/game.js']?.contentType?.startsWith('text/javascript') === true
      && assets['multi-file/level.json']?.contentType?.startsWith('application/json') === true,
      'the run service sends the content types a browser needs',
      assets,
    )
    await apiJson(locator, `/workspace/preview-server?root=${encodeURIComponent(workspaceDir)}`, { method: 'DELETE' }).catch(() => undefined)

    // Stop: the toolbar reports it and the URL stops answering.
    runGuest.close()
    await selectWorkspaceTab(client, 'canvas-game.html')
    const stopped = await clickPreviewAction(client, '停止')
    const stoppedNotice = stopped
      ? await harness.waitFor(() => client.evaluate(`(() => {
          const node = document.querySelector('.workspace-tab-view.active .workspace-preview-run-notice');
          return node ? { text: node.textContent.trim(), tone: node.getAttribute('data-tone') } : null;
        })()`), 15_000, 'stopped run notice').catch(() => null)
      : null
    const afterStop = await fetch(runServer.url).then((r) => r.status).catch(() => 0)
    const stopShot = await captureScreenshot(client, screenshotDir, 'html-run-stopped.png')
    recorder.note({ step: 'html-run-stop', clicked: stopped, notice: stoppedNotice, urlAfterStop: afterStop, screenshot: stopShot })
    recorder.check(
      stoppedNotice?.tone === 'warning' && stoppedNotice.text.includes('已停止'),
      'stopping the run says so in the toolbar',
      stoppedNotice,
    )
    recorder.check(afterStop === 0, 'the stopped run service no longer answers', { afterStop })

    // 3. The same page in the LS browser tab (webview guest, loopback HTTP URL).
    await selectWorkspaceFeature(client, '浏览器')
    await harness.waitFor(() => client.evaluate(`document.querySelector('.workspace-browser-address input') instanceof HTMLInputElement || null`), 15_000, 'browser address field')
    await submitAddress(client, `${server.origin}/canvas-game.html`)
    const { client: guest, target: guestTarget } = await connectTarget(
      debuggingPort,
      (candidate) => candidate.url.startsWith(server.origin),
      'LS browser tab guest target',
      { timeoutMs: 30_000 },
    )
    const guestProbe = await harness.waitFor(() => guest.evaluate(`window.__gameState ? (${PAGE_PROBE}) : null`), 30_000, 'LS browser tab canvas game')
    const guestShot = await captureScreenshot(guest, screenshotDir, 'ls-browser-tab-canvas-game.png')
    recorder.note({
      step: 'ls-browser-tab-canvas-game',
      entry: `工作区 → 浏览器标签 → ${server.origin}/canvas-game.html`,
      targetType: guestTarget.type,
      probe: guestProbe,
      errors: readEvents(guest, 0),
      screenshot: guestShot,
    })
    recorder.check(
      Array.isArray(guestProbe.canvas?.sample)
      && guestProbe.canvas.sample[0] === GAME_COLOR.r
      && guestProbe.canvas.sample[1] === GAME_COLOR.g
      && guestProbe.canvas.sample[2] === GAME_COLOR.b,
      'the LS browser tab paints the game canvas over the loopback URL',
      { sample: guestProbe.canvas?.sample ?? null },
    )
    const guestBefore = guestProbe.canvas?.gameState ?? {}
    // Real input goes to the guest target; the canvas can be larger than the
    // guest viewport, so the click point is the centre of the visible overlap.
    const guestPoint = await canvasPointInViewport(guest)
    await dispatchGameInput(guest, guestPoint)
    const guestAfter = await waitForGameChange(guest, guestBefore, 'LS browser tab game interaction')
    recorder.note({ step: 'ls-browser-tab-interaction', before: guestBefore, after: guestAfter, point: guestPoint })
    recorder.check(guestAfter.x > Number(guestBefore.x ?? 0), 'keyboard input reaches the game in the LS browser tab', { before: guestBefore.x ?? null, after: guestAfter.x })
    recorder.check(guestAfter.score > Number(guestBefore.score ?? 0), 'pointer input reaches the game in the LS browser tab', { before: guestBefore.score ?? null, after: guestAfter.score })
    guest.close()

    // 4. A local file path typed into the browser address bar: what does LS do?
    const fileUrl = `file:///${join(workspaceDir, 'canvas-game.html').replace(/\\/gu, '/')}`
    await submitAddress(client, fileUrl)
    await delay(1_500)
    const fileOutcome = await client.evaluate(`(() => {
      const layouts = JSON.parse(localStorage.getItem('littlesheep.ui.workspaceSessionLayouts') || '{}');
      const layout = layouts.__draft__ ?? Object.values(layouts)[0] ?? null;
      return {
        address: document.querySelector('.workspace-browser-address input')?.value ?? null,
        guestSources: [...document.querySelectorAll('webview')].map((node) => node.getAttribute('src')),
        tabs: layout?.browserTabs?.map((tab) => tab.url) ?? null,
        visibleText: (document.querySelector('.workspace-browser')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      };
    })()`)
    let fileGuest = null
    try {
      const attached = await connectTarget(
        debuggingPort,
        (candidate) => /^https:\/\/file/iu.test(candidate.url) || candidate.url.includes('file///'),
        'bogus file navigation guest',
        { timeoutMs: 15_000 },
      )
      fileGuest = await attached.client.evaluate(PAGE_PROBE)
      attached.client.close()
    } catch {
      fileGuest = null
    }
    const fileShot = await captureScreenshot(client, screenshotDir, 'ls-browser-file-address.png')
    recorder.note({
      step: 'ls-browser-file-address',
      entry: '工作区 → 浏览器标签 → 地址栏输入本地 file:// 路径',
      submitted: fileUrl,
      outcome: fileOutcome,
      guest: fileGuest,
      screenshot: fileShot,
    })
    recorder.check(
      (fileOutcome.guestSources ?? []).every((source) => !String(source).startsWith('file:')),
      'the LS browser tab never navigates to the file:// address itself',
      fileOutcome,
    )
    recorder.check(
      (fileOutcome.tabs ?? []).some((url) => /^https:\/\/file/iu.test(String(url))),
      'a local file path is silently rewritten into a bogus https host',
      fileOutcome.tabs,
    )
    recorder.check(
      fileGuest !== null
      && (fileGuest.url.startsWith('chrome-error://')
        || /无法访问|拒绝连接|ERR_|This site|网页无法打开|找不到/iu.test(`${fileGuest.title} ${fileGuest.text}`)),
      'the bogus navigation lands on a browser error page instead of the game',
      fileGuest,
    )

    // 5. Git baseline: the same change seen by the CLI, the Local App API and the UI.
    const gitCli = await gitBaseline(workspaceDir)
    const gitApi = await gitApiBaseline(locator, workspaceDir, gitCli)
    const gitUi = await gitUiBaseline(client, eventsFrom)
    recorder.note({ step: 'git-cli-vs-api-vs-ui', repository: gitRepository, cli: gitCli, api: gitApi, ui: gitUi })
    recorder.check(
      gitApi.snapshotFiles.length === gitCli.status.length,
      'the review API lists the same changed files as git status',
      { cli: gitCli.status, api: gitApi.snapshotFiles },
    )
    recorder.check(
      gitCli.addedLines.every((line) => gitApi.diffAdditions.includes(line.slice(1))),
      'the review API returns the added lines the CLI diff shows (content without the diff marker)',
      { cliAdditions: gitCli.addedLines, apiAdditions: gitApi.diffAdditions },
    )
    recorder.check(
      gitApi.untrackedLayers.some((layer) => layer.kind === 'untracked'),
      'the review API keeps an untracked file in its own layer',
      { untrackedFile: gitApi.untrackedDiffFile, layers: gitApi.untrackedLayers },
    )
    recorder.check(
      gitUi.treeFiles.length === gitCli.status.length,
      'the review tab lists the same changed files as git status',
      { cli: gitCli.status, ui: gitUi.treeFiles },
    )
    recorder.check(
      gitUi.treeStatuses.includes('M') && gitUi.treeStatuses.includes('U'),
      'the review tab distinguishes a modified file from an untracked one, like git status does',
      { statuses: gitUi.treeStatuses, rows: gitUi.treeFiles, cli: gitCli.status, staleAtMount: gitUi.staleAtMount },
    )

    // 6. Shell baseline: executable, version, cwd and PTY state of the real session.
    const shell = await terminalBaseline(locator, workspaceDir)
    recorder.note({ step: 'shell-baseline', ...shell })
    recorder.check(
      /^PowerShell/u.test(shell.snapshot.shell),
      'the workspace terminal runs the PowerShell profile',
      shell.snapshot,
    )
    recorder.check(
      shell.snapshot.cwd.toLowerCase() === workspaceDir.toLowerCase(),
      'the terminal session starts in the workspace root',
      { cwd: shell.snapshot.cwd },
    )
    recorder.check(
      shell.snapshot.backend === 'pty' || shell.snapshot.backend === 'spawn',
      'the session reports which backend it actually got',
      { backend: shell.snapshot.backend },
    )
    recorder.check(
      /^\d+\.\d+/u.test(shell.version ?? ''),
      'the running shell reports a real PowerShell version',
      { version: shell.version, line: shell.line },
    )
    recorder.check(
      String(shell.reportedCwd ?? '').toLowerCase() === workspaceDir.toLowerCase(),
      'the shell itself reports the same working directory',
      { reportedCwd: shell.reportedCwd },
    )
    // Measured baseline for UX-27's remaining items: the review tab can mount on a
    // snapshot taken before the working tree changed. Either it mounted fresh, or
    // the user's refresh has to reach the true state.
    recorder.check(
      !String(gitUi.staleAtMount ?? '').includes('没有未提交更改')
      || gitUi.treeFiles.length === gitCli.status.length,
      'a review tab that mounts stale still reaches the true state after a refresh',
      { staleAtMount: gitUi.staleAtMount, afterRefresh: gitUi.treeFiles, cli: gitCli.status },
    )

    // Fingerprint while the renderer session is still open: a CDP call after the
    // socket closed never settles (that hung the gate once).
    fingerprint = await buildFingerprint(client)
  } catch (error) {
    recorder.check(false, 'the baseline walkthrough completed without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    client?.close()
    systemBrowser?.client?.close()
    if (systemBrowser?.child && systemBrowser.child.exitCode === null) systemBrowser.child.kill()
    if (electron?.exitCode === null) await harness.forceTerminate(electron)
    await server?.close().catch(() => undefined)
    await provider.close().catch(() => undefined)
    if (!keep) await harness.removeTemporaryRoot(root)
  }

  const evidence = {
    check: 'html-preview-baseline',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    window: WINDOW,
    fingerprint: fingerprint ?? (await buildFingerprint(null)),
    fixtures: {
      label: FIXTURE_LABEL,
      files: [
        'static-page.html',
        'canvas-game.html',
        'multi-file/index.html',
        'multi-file/game.css',
        'multi-file/game.js',
        'multi-file/level.json',
        'multi-file/sprite.svg',
        'assets/tile.svg',
      ],
    },
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'The fixtures are synthetic. The user never provided the original HTML, so nothing here claims that the reported game is fixed or reproduced.',
      'The reference entry is an installed Chrome/Edge running headless; it proves what the page does outside LS, not what the user saw in their browser.',
      'The LS file preview is a sanitized `srcdoc` iframe with `sandbox=""`, and Electron runs it out of process, so its document is probed through the frame target\'s own debug session rather than from the app document.',
      'A page whose styling lives in an external stylesheet (<link>) still renders unstyled: the sanitizer drops `link` and a sandboxed frame cannot load file:// subresources. The bounded resource service for that is UX-26.',
      'The draft-preview step is recorded, not asserted: the typed draft reached the editor model and the session draft store (`markerInDraft: true`) while the mounted preview kept the on-disk document, so "the preview follows an unsaved draft" has no passing measurement yet and UX-25 item 3 stays open.',
      'Windows and Electron versions come from the running process; the source revision and build digests come from the build fingerprint written by ensure:app-build.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

/** Source revision, build digests and engine versions behind these measurements. */
async function buildFingerprint(client) {
  const manifestPath = join(repoRoot(), 'packages', 'app', 'out', '.littlesheep-build-fingerprint.json')
  const manifest = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null)
  const product = client
    ? await client.send('Browser.getVersion').then((value) => value.product).catch(() => null)
    : null
  return {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot(), encoding: 'utf8', windowsHide: true }).trim(),
    buildInputDigest: manifest?.input?.digest ?? null,
    buildOutputDigest: manifest?.output?.digest ?? null,
    electronVersion: manifest?.runtime?.electronVersion ?? null,
    rendererProduct: product,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    os: `${os.type()} ${os.release()}`,
  }
}

function repoRoot() {
  return fileURLToPath(new URL('..', import.meta.url))
}

/** Seed one file tab's unsaved draft in the session store the app itself writes. */
async function seedDraft(client, workspaceDir, filePath, texts) {
  const fileTab = `file:${encodeURIComponent(workspaceDir)}|${encodeURIComponent(filePath)}`
  await client.evaluate(`(() => {
    const layouts = JSON.parse(localStorage.getItem('littlesheep.ui.workspaceSessionLayouts') || '{}');
    const bucket = layouts.__draft__ ?? (layouts.__draft__ = { collapsed: false, fullscreen: true, activeTab: ${JSON.stringify(fileTab)}, openTabs: [${JSON.stringify(fileTab)}], fileNavigatorCollapsed: false, fileNavigatorWidth: 214, reviewNavigatorWidth: 214, expandedPaths: [], drafts: {}, browserTabs: [] });
    bucket.drafts = bucket.drafts || {};
    bucket.drafts[${JSON.stringify(fileTab)}] = {
      path: ${JSON.stringify(filePath)},
      modifiedAt: ${Number(texts.modifiedAt ?? 0)},
      editorText: ${JSON.stringify(texts.editorText)},
      savedText: ${JSON.stringify(texts.savedText)},
      editing: false,
    };
    bucket.activeTab = ${JSON.stringify(fileTab)};
    bucket.openTabs = [...new Set([...(bucket.openTabs || []), ${JSON.stringify(fileTab)}])];
    localStorage.setItem('littlesheep.ui.workspaceSessionLayouts', JSON.stringify(layouts));
    localStorage.setItem('littlesheep.ui.workspacePanelTab', ${JSON.stringify(fileTab)});
    localStorage.setItem('littlesheep.ui.workspacePanelOpenTabs', JSON.stringify(bucket.openTabs));
    localStorage.setItem('littlesheep.ui.workspacePanelOpenRoot', ${JSON.stringify(workspaceDir)});
    localStorage.setItem('littlesheep.ui.workspacePanelOpenPath', ${JSON.stringify(filePath)});
    return true;
  })()`)
}

/** Reload the renderer once and wait for the app document again. */
async function reloadRenderer(client) {
  const before = await client.evaluate('performance.timeOrigin')
  await client.send('Page.reload', { ignoreCache: false })
  await harness.waitFor(async () => {
    const state = await client.evaluate(`(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin }))()`)
      .catch(() => undefined)
    if (!state) return undefined
    return state.readyState === 'complete' && state.timeOrigin !== before ? state.timeOrigin : undefined
  }, harness.actionTimeoutMs, 'renderer reload')
}

/** Click a labelled action of the active file view; false when it is absent. */
async function clickPreviewAction(client, label) {
  return client.evaluate(`(() => {
    const button = [...document.querySelectorAll('.workspace-tab-view.active button')]
      .find((node) => (node.textContent || '').trim() === ${JSON.stringify(label)} && !node.disabled);
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`)
}

/** Bring an open workspace tab (file or browser) to the front by its label. */
async function selectWorkspaceTab(client, label) {
  const clicked = await client.evaluate(`(() => {
    const item = [...document.querySelectorAll('.workspace-active-item')]
      .find((node) => (node.textContent || '').includes(${JSON.stringify(label)}));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`workspace tab not available: ${label}`)
  await delay(600)
}

/**
 * Type into the real Monaco editor.
 *
 * Monaco 0.5x takes input through an `EditContext`, so the hidden textarea cannot
 * be focused: a real click into a rendered line followed by text-carrying key
 * events is the gesture that works (same recipe as `verify-async-feedback`).
 * Key events come first here: `Input.insertText` updated the rendered lines but
 * not the editor model in this Electron build (measured), so the model's own
 * change event — and with it the draft — never fired.
 */
async function typeIntoEditor(client, text) {
  const point = await harness.waitFor(async () => {
    const value = await client.evaluate(`(() => {
      const pane = document.querySelector('.workspace-tab-view.active .workspace-editor-monaco');
      const line = pane?.querySelector('.monaco-editor .view-line');
      if (!(pane instanceof HTMLElement) || !(line instanceof HTMLElement)) return null;
      const paneBox = pane.getBoundingClientRect();
      const lineBox = line.getBoundingClientRect();
      // A long line extends far beyond the visible editor, so its own centre can
      // sit outside the window; the click point is inside the overlap instead.
      const left = Math.max(paneBox.left, lineBox.left, 0);
      const right = Math.min(paneBox.right, lineBox.right, window.innerWidth);
      if (right - left < 8) return null;
      return { x: left + Math.min(30, (right - left) / 2), y: lineBox.top + lineBox.height / 2 };
    })()`)
    return value ?? undefined
  }, 30_000, 'the Monaco text area')
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
  await delay(300)
  for (const character of text) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character })
    await delay(20)
  }
  await delay(500)
  if (await editorHasText(client, text)) return 'keyEvents'
  await client.send('Input.insertText', { text })
  await delay(400)
  return (await editorHasText(client, text)) ? 'insertText' : 'failed'
}

async function editorHasText(client, text) {
  return client.evaluate(`(() => {
    const content = (document.querySelector('.workspace-tab-view.active .workspace-editor-monaco .view-lines')?.textContent ?? '')
      .replace(/\\u00a0/gu, ' ');
    return content.includes(${JSON.stringify(text)}) ? true : null;
  })()`).then(Boolean)
}

/** The review tab's own view of the same repository state. */
async function gitUiBaseline(client, eventsFrom) {
  await selectWorkspaceFeature(client, '审阅')
  const read = () => client.evaluate(`(() => {
    const review = document.querySelector('.workspace-review');
    if (!review) return null;
    const rows = [...review.querySelectorAll('[role="treeitem"]')].map((node) => ({
      text: (node.textContent || '').replace(/\\s+/g, ' ').trim(),
      status: node.querySelector('.workspace-review-file-status')?.textContent?.trim() ?? null,
    }));
    const status = review.querySelector('.workspace-review-diff-layer-status')?.textContent?.trim() ?? null;
    const title = review.querySelector('.workspace-review-diff-title-main')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
    return {
      rows,
      statusText: status,
      title,
      surfaceText: (review.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    };
  })()`)
  let surface = await read()
  await delay(1_200)
  // Measured: the review tab can mount on a snapshot cached before the changes, so
  // the user's own refresh is what makes the current state appear.
  const staleAtMount = (await read())?.surfaceText ?? null
  const refreshed = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('.workspace-review button')]
      .find((node) => node.getAttribute('aria-label') === '刷新 Git 更改');
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`)
  try {
    surface = await harness.waitFor(async () => {
      const current = await read()
      return current?.rows?.length > 0 ? current : undefined
    }, 20_000, 'review tab with the fixture changes')
  } catch (error) {
    // The timeout is the interesting case: report what the surface actually shows.
    throw new Error(`${error instanceof Error ? error.message : String(error)}; review surface: ${JSON.stringify(surface)}; refreshed: ${refreshed}`)
  }
  return {
    treeFiles: surface.rows.map((row) => row.text),
    treeStatuses: surface.rows.map((row) => row.status),
    statusText: surface.statusText,
    title: surface.title,
    surfaceText: surface.surfaceText,
    staleAtMount,
    refreshed,
    errors: readEvents(client, eventsFrom).slice(-5),
  }
}

/** A real repository in the fixture workspace, created before the app boots. */
async function gitInit(workspaceDir) {
  const run = (args) => execFileSync('git', args, { cwd: workspaceDir, encoding: 'utf8', windowsHide: true }).trim()
  run(['init', '--initial-branch=main'])
  run(['config', 'user.email', 'html-baseline@example.invalid'])
  run(['config', 'user.name', 'HTML Baseline'])
  run(['add', '.'])
  run(['commit', '-m', 'fixture'])
  return { revision: run(['rev-parse', 'HEAD']) }
}

/** One edit plus one new file, then the CLI's own view of that state. */
async function gitBaseline(workspaceDir) {
  const run = (args) => execFileSync('git', args, { cwd: workspaceDir, encoding: 'utf8', windowsHide: true }).trim()
  const target = join(workspaceDir, 'canvas-game.html')
  await writeFile(target, `${await readFile(target, 'utf8')}<!-- baseline edit -->\n`, 'utf8')
  await writeFile(join(workspaceDir, 'probe-untracked.txt'), 'untracked\n', 'utf8')
  const status = run(['status', '--porcelain']).split(/\r?\n/u).filter(Boolean)
  const diff = run(['diff', '--', 'canvas-game.html'])
  const numstat = run(['diff', '--numstat']).split(/\r?\n/u).filter(Boolean)
  return {
    status,
    addedLines: diff.split(/\r?\n/u).filter((line) => line.startsWith('+') && !line.startsWith('+++')),
    numstat,
    revision: run(['rev-parse', 'HEAD']),
  }
}

/** What the Local App API reports for exactly that repository state. */
async function gitApiBaseline(locator, workspaceDir, cli) {
  const root = encodeURIComponent(workspaceDir)
  const snapshot = await apiJson(locator, `/workspace/review?root=${root}&force=1`)
  const file = snapshot.files.find((entry) => entry.path === 'canvas-game.html') ?? snapshot.files[0]
  const untracked = snapshot.files.find((entry) => entry.status === 'untracked') ?? null
  const diffFor = async (entry) => (entry
    ? apiJson(locator, `/workspace/review/diff?root=${root}&path=${encodeURIComponent(entry.absolutePath)}&revision=${encodeURIComponent(snapshot.revision)}`)
    : null)
  const diff = await diffFor(file)
  const untrackedDiff = await diffFor(untracked)
  const layerSummary = (value) => (value?.layers ?? []).map((layer) => ({
    kind: layer.kind,
    hunks: layer.hunks.length,
    binary: layer.binary,
    truncated: layer.truncated,
  }))
  const layers = layerSummary(diff)
  return {
    availability: snapshot.availability,
    branch: snapshot.branch ?? null,
    snapshotFiles: snapshot.files.map((entry) => `${entry.path} (${entry.status})`),
    totalFiles: snapshot.totalFiles,
    countsComplete: snapshot.countsComplete,
    diffFile: file?.path ?? null,
    diffAdditions: (diff?.hunks ?? []).flatMap((hunk) => hunk.lines)
      .filter((line) => line.kind === 'addition')
      .map((line) => line.content),
    layers,
    untrackedLayers: layerSummary(untrackedDiff),
    untrackedDiffFile: untracked?.path ?? null,
    cliStatus: cli.status,
  }
}

/** Start a real workspace terminal and read its identity and PTY state. */
async function terminalBaseline(locator, workspaceDir) {
  const snapshot = await apiJson(locator, '/workspace/terminal/session', {
    method: 'POST',
    body: { root: workspaceDir, cols: 100, rows: 30 },
  })
  let output = ''
  const controller = new AbortController()
  const sessionPath = `/workspace/terminal/session/${encodeURIComponent(snapshot.sessionId)}`
  try {
    const stream = await fetch(harness.apiUrl(locator, `${sessionPath}/stream`), {
      headers: harness.authHeaders(locator),
      signal: controller.signal,
    })
    const reader = stream.body.getReader()
    const decoder = new TextDecoder()
    const collect = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          output += decoder.decode(value, { stream: true })
        }
      } catch {
        // The stream is aborted on purpose once the command has answered.
      }
    })()
    await delay(300)
    // `PSV=` followed by a digit can only come from the command's output: the
    // echoed input still has the quote and `$PSVersionTable` right after it.
    await apiJson(locator, `${sessionPath}/input`, {
      method: 'POST',
      body: { data: '"PSV=" + $PSVersionTable.PSVersion.ToString() + "|CWD=" + (Get-Location).Path + "|ENC=" + [Console]::OutputEncoding.WebName + "|END"\r' },
    })
    await harness.waitFor(() => (/PSV=\d/u.test(output) ? true : undefined), 20_000, 'terminal command output')
    controller.abort()
    await collect
  } catch (error) {
    output += `\n[stream error: ${error instanceof Error ? error.message : String(error)}]`
  } finally {
    controller.abort()
    await fetch(harness.apiUrl(locator, sessionPath), {
      method: 'DELETE',
      headers: harness.authHeaders(locator),
    }).catch(() => undefined)
  }
  const plain = decodeSseText(output).replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '')
  const line = plain.split(/\r?\n/u).map((entry) => entry.trim()).find((entry) => /^PSV=\d/u.test(entry)) ?? ''
  const [, version, cwd, encoding] = /^PSV=([^|]+)\|CWD=([^|]*)\|ENC=([^|]*)\|/u.exec(line) ?? []
  return {
    snapshot,
    version: version ?? null,
    reportedCwd: cwd ?? null,
    encoding: encoding ?? null,
    line: line || null,
    output: plain.slice(-300),
  }
}

/** The stdout text carried by the terminal SSE stream. */
function decodeSseText(raw) {
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim())?.text ?? ''
      } catch {
        return ''
      }
    })
    .join('')
}

async function apiJson(locator, path, { method = 'GET', body } = {}) {
  const response = await fetch(harness.apiUrl(locator, path), {
    method,
    headers: {
      ...harness.authHeaders(locator),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`)
  return response.json()
}

async function selectWorkspaceFeature(client, label) {
  let open = false
  for (let attempt = 0; attempt < 3 && !open; attempt += 1) {
    await client.evaluate(`(() => {
      const trigger = document.querySelector('.workspace-add-trigger');
      if (trigger instanceof HTMLElement) trigger.click();
      return true;
    })()`)
    open = await harness.waitFor(
      () => client.evaluate(`Boolean(document.querySelector('.workspace-add-panel.visible')) || null`),
      5_000,
      `workspace feature menu (attempt ${attempt + 1})`,
    ).then(() => true).catch(() => false)
  }
  if (!open) throw new Error('the workspace feature menu could not be opened')
  const selected = await client.evaluate(`(() => {
    const item = [...document.querySelectorAll('.workspace-add-panel.visible .workspace-add-item')]
      .find((node) => (node.textContent || '').includes(${JSON.stringify(label)}));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`)
  if (!selected) throw new Error(`workspace feature ${label} could not be selected`)
}

async function submitAddress(client, url) {
  const submitted = await client.evaluate(`(() => {
    const input = document.querySelector('.workspace-browser-address input');
    const form = input?.closest('form');
    if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(url)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
    return true;
  })()`)
  if (!submitted) throw new Error('the browser address could not be submitted')
}

/**
 * Centre of the canvas area that is actually inside the target's viewport.
 *
 * The embedded guest can be narrower than the fixture canvas (measured: a 121 px
 * wide guest against a 320 px canvas), so the geometric centre of the element can
 * sit outside the visible area and a click there lands on another surface.
 */
async function canvasPointInViewport(target) {
  const point = await target.evaluate(`(() => {
    const box = document.querySelector('canvas').getBoundingClientRect();
    const left = Math.max(box.left, 0);
    const top = Math.max(box.top, 0);
    const right = Math.min(box.right, window.innerWidth);
    const bottom = Math.min(box.bottom, window.innerHeight);
    if (right - left < 4 || bottom - top < 4) {
      return {
        error: 'the canvas is outside the visible viewport',
        canvas: { x: box.left, y: box.top, width: box.width, height: box.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    }
    return { x: (left + right) / 2, y: (top + bottom) / 2, visible: { width: right - left, height: bottom - top } };
  })()`)
  if (point?.error) throw new Error(`${point.error}: ${JSON.stringify(point)}`)
  return point
}

/**
 * Real keyboard and pointer input at the canvas centre.
 *
 * The pointer gesture comes first on purpose: the embedded guest only takes
 * keyboard events once the click focused it (measured: a key sent before the
 * click was dropped, the same key after it landed).
 */
async function dispatchGameInput(target, point) {
  await target.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await target.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await target.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
  await target.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 })
  await target.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 })
}

/** Wait for any game state change, then let the caller assert which inputs landed. */
async function waitForGameChange(target, before, label) {
  return harness.waitFor(() => target.evaluate(`(() => {
    const state = window.__gameState;
    if (!state) return null;
    const changed = state.x !== ${Number(before.x ?? 0)} || state.score !== ${Number(before.score ?? 0)};
    return changed ? { ...state, hud: document.getElementById('hud')?.textContent ?? null } : null;
  })()`), 10_000, label)
}

await main()
