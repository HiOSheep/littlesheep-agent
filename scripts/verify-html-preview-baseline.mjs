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
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

/** UX-26 resilience: a page that loads, marks itself ready, then spins forever. */
const LOOP_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>死循环夹具</title>
  <style>body { margin: 0; background: #101418; color: #e8e8e8; font-family: "Microsoft YaHei UI", sans-serif; }</style>
</head>
<body>
  <h1>死循环夹具</h1>
  <p id="ready">未就绪</p>
  <script>
    document.getElementById('ready').textContent = '已就绪';
    while (true) { /* 故意卡死渲染进程 */ }
  </script>
</body>
</html>
`

/** UX-26 diagnostics: a page that throws and misses a resource, on purpose. */
const ERROR_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>报错夹具</title>
  <link rel="stylesheet" href="missing-style.css">
  <style>body { margin: 0; background: #101418; color: #e8e8e8; font-family: "Microsoft YaHei UI", sans-serif; }</style>
</head>
<body>
  <h1>报错夹具</h1>
  <img id="missing" src="missing-image.png" alt="缺失图片">
  <script>
    window.__errorFixture = true;
    throw new Error('夹具脚本错误');
  </script>
</body>
</html>
`

const STATIC_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>静态页夹具</title>
  <style>
    /* The face has to be *used*: Chromium only fetches a @font-face when text needs it. */
    body { margin: 0; font-family: '夹具字体', "Microsoft YaHei UI", sans-serif; background: #101418; color: #e8e8e8; }
    @font-face { font-family: '夹具字体'; src: url('fonts/fixture.woff2') format('woff2'); font-display: swap; }
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
      <img id="asset-subdir" src="assets/tile.svg" width="24" height="24" alt="subdir">
      <img id="asset-cjk-space" src="素材/背景 图.svg" width="24" height="24" alt="cjk">
      <img id="asset-hash" src="shots/shot%231.svg" width="24" height="24" alt="hash">
      <img id="asset-percent" src="100%25.svg" width="24" height="24" alt="percent">
      <img id="asset-missing" src="assets/does-not-exist.svg" width="24" height="24" alt="missing">
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
  <button id="restart" type="button">重新开始</button>
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
      document.getElementById('restart').addEventListener('click', () => {
        state.score = 0;
        state.x = 20;
        hud();
        draw();
      });
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
  // UX-25 item 2: every relative reference the fixture writes must actually arrive,
  // including the subdirectory, the Chinese name with a space, and the hash/percent names
  // that only survive if the reference is encoded exactly once.
  const localAssets = (() => {
    const result = {};
    for (const node of document.querySelectorAll('img[id^="asset-"]')) {
      result[node.id] = { naturalWidth: node.naturalWidth, currentSrc: node.currentSrc, complete: node.complete };
    }
    return result;
  })();
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
    styleSheetInfo: [...document.styleSheets].map((sheet) => ({
      href: sheet.href,
      rules: (() => { try { return sheet.cssRules.length } catch (error) { return 'blocked:' + error.name } })(),
    })),
    localAssets,
    fonts: [...document.fonts].map((face) => ({ family: face.family, status: face.status })),
    // The @font-face source as the frame itself sees it: real rendered evidence that the
    // font reference was rewritten, independent of whether Chromium started the fetch.
    fontSources: (() => {
      const sources = [];
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules } catch (error) { continue }
        for (const rule of rules) {
          if (rule.constructor.name === 'CSSFontFaceRule') sources.push(rule.style.getPropertyValue('src'));
        }
      }
      return sources;
    })(),
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
    // Progress goes to stderr: a stall must be visible in the log, not only in the
    // final report (two runs were lost to a silent hang before this).
    note: (entry) => {
      observations.push(entry)
      console.error(`[gate] ${entry.step}`)
    },
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
    mkdir(join(workspaceDir, '素材'), { recursive: true }),
    mkdir(join(workspaceDir, 'shots'), { recursive: true }),
    mkdir(join(workspaceDir, 'fonts'), { recursive: true }),
  ])
  await writeFile(join(workspaceDir, 'static-page.html'), STATIC_PAGE, 'utf8')
  // UX-25 item 3 edits and saves this one; it is part of the committed fixture set so
  // the Git comparison later still sees exactly the changes it expects.
  await writeFile(join(workspaceDir, 'save-fixture.html'), STATIC_PAGE, 'utf8')
  await writeFile(join(workspaceDir, 'canvas-game.html'), CANVAS_GAME, 'utf8')
  await writeFile(join(workspaceDir, 'error-page.html'), ERROR_PAGE, 'utf8')
  await writeFile(join(workspaceDir, 'loop-page.html'), LOOP_PAGE, 'utf8')
  await writeFile(join(workspaceDir, 'assets', 'tile.svg'), SPRITE_SVG, 'utf8')
  // UX-25 item 2 names these cases: a subdirectory, a Chinese name with a space,
  // a literal `#` and a literal `%` in the file name (referenced percent-encoded).
  await writeFile(join(workspaceDir, '素材', '背景 图.svg'), SPRITE_SVG, 'utf8')
  await writeFile(join(workspaceDir, 'shots', 'shot#1.svg'), SPRITE_SVG, 'utf8')
  // A font the preview must fetch. The bytes are a stub, so Chromium fails to decode
  // them; what this measures is the request path (rewrite -> CSP -> Main), which is
  // what the item's font clause is about.
  await writeFile(join(workspaceDir, 'fonts', 'fixture.woff2'), Buffer.from('wOF2stub-fixture-font', 'utf8'))
  await writeFile(join(workspaceDir, '100%.svg'), SPRITE_SVG, 'utf8')
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

/**
 * Capture a screenshot, but never let it hold the run hostage.
 *
 * While the acceptance window is hidden a capture still forces a paint, which is
 * slow and sometimes never settles (measured: one capture took 5 s, the next timed
 * out after 12 s). Screenshots are evidence, not assertions, so a failure is
 * recorded as `null` instead of aborting the walkthrough.
 */
async function captureScreenshot(client, dir, name, timeoutMs = 20_000) {
  await mkdir(dir, { recursive: true })
  const shot = await Promise.race([
    client.send('Page.captureScreenshot', { format: 'png' }),
    delay(timeoutMs).then(() => null),
  ]).catch(() => null)
  if (!shot?.data) return null
  const path = join(dir, name)
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  return path
}

async function seedPreferences(client, workspaceDir, filePath, draft = null) {
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
    drafts: draft ? { [fileTab]: draft } : {},
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

/**
 * Preview frames whose rendered **markup** contains `needle`.
 *
 * A marker inside an HTML comment is invisible to `innerText` (and DOMPurify strips
 * comments entirely), so an edit is proven through `outerHTML`.
 */
async function probePreviewFrameMarkup(debuggingPort, needle) {
  const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
  const targets = await response.json()
  const documents = []
  for (const target of targets.filter((candidate) => candidate.type === 'iframe' && candidate.webSocketDebuggerUrl)) {
    const frameClient = new harness.CdpClient(target.webSocketDebuggerUrl)
    try {
      await frameClient.send('Runtime.enable')
      documents.push(await frameClient.evaluate(`(() => ({
        url: location.href,
        htmlLength: document.documentElement.outerHTML.length,
        text: (document.body?.innerText ?? '').replace(/\\s+/gu, ' ').slice(0, 120),
        hasMarker: document.documentElement.outerHTML.includes(${JSON.stringify(needle)}),
        styleSheets: document.styleSheets.length,
        scripts: document.scripts.length,
      }))()`))
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
    // One paint before the frame work: an acceptance run keeps its window hidden, and
    // while nothing is rendered an out-of-process preview iframe has no debug target at
    // all (measured: 1 target without a paint, 2 with one) — the frame probes would then
    // wait out their whole timeout. Capturing also proves the window stays off screen.
    const windowSnapshot = await harness.desktopSnapshot(locator).catch(() => null)
    const warmShot = await captureScreenshot(client, screenshotDir, 'warm-paint.png')
    recorder.note({
      step: 'warm-paint',
      windowVisible: windowSnapshot?.windowVisible ?? null,
      visibilityState: await client.evaluate('document.visibilityState'),
      captured: Boolean(warmShot),
    })
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
        // This fixture styles itself through an external stylesheet, which now loads
        // through Main's loopback service (UX-25 item 2).
        step: 'preview-multi-file',
        name: 'index.html',
        marker: '多文件夹具',
        title: '多文件夹具',
        documents: 3,
        seeded: false,
        // The external stylesheet now arrives through the loopback service.
        style: { key: 'board', expected: 'rgb(28, 42, 31)', styleSheets: 1 },
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
        // UX-25 item 2, the whole chain in one place: the sanitized document keeps the
        // relative reference, the resolver rewrites it to Main's loopback service, the
        // frame's CSP allows that origin, and Main resolves the path inside the root.
        if (entry.step === 'preview-static-page') {
          const assets = renderedDocument.localAssets ?? {}
          const expected = {
            'asset-subdir': 'assets/tile.svg',
            'asset-cjk-space': '素材/背景 图.svg',
            'asset-hash': 'shots/shot%231.svg',
            'asset-percent': '100%25.svg',
          }
          for (const [id, reference] of Object.entries(expected)) {
            const asset = assets[id] ?? null
            recorder.check(
              asset?.naturalWidth > 0,
              `${entry.step}: the preview loads \`${reference}\` through the served root`,
              { id, reference, asset },
            )
          }
          recorder.check(
            assets['asset-missing']?.naturalWidth === 0,
            `${entry.step}: a reference that does not exist stays a failure, not a silent success`,
            { asset: assets['asset-missing'] ?? null },
          )
          // Fonts go through exactly the same rewrite; a stub file proves the request
          // left the frame (status leaves 'unloaded') and that Main served it (a 404
          // would show up in the recorded failures instead).
          // A hidden acceptance window never makes Chromium *start* a font fetch (measured:
          // the face stays `unloaded` even though the text uses it), so the font clause is
          // proven where it is observable: the @font-face source the frame itself holds.
          const fontSources = renderedDocument.fontSources ?? []
          recorder.check(
            fontSources.some((source) => String(source).includes('/fonts/fixture.woff2')),
            `${entry.step}: the @font-face source resolves to the served root`,
            { fontSources, fonts: renderedDocument.fonts ?? [] },
          )
          const srcdoc = frame.srcdoc ?? ''
          recorder.check(
            !/src="assets\//u.test(srcdoc) && !/src="\.\.?\//u.test(srcdoc),
            `${entry.step}: relative references are rewritten to the loopback service in the frame document`,
            { srcdocHead: frame.srcdocHead },
          )
        }
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

    // 2b. UX-25 item 3, draft half: an unsaved edit is kept by the session store and
    // the preview renders it instead of the file on disk.
    //
    // The edit is made through the real editor, but *without a visible window*: an
    // acceptance run keeps its window off the user's screen, and CDP key events need
    // a laid-out editor. Focusing the editor's own input element and inserting text
    // through the input pipeline updates the model (and with it the pane's draft)
    // even when nothing is painted — measured: 0 rendered lines, draft dirty, preview
    // following.
    const draftMarker = `草稿标记-${Date.now().toString(36)}`
    await openFileFromTree(client, 'static-page.html')
    await harness.waitFor(async () => {
      const mounted = await readPreviewFrames(client)
      return mounted.some((candidate) => candidate.title === 'HTML 预览：static-page.html') ? mounted : undefined
    }, 20_000, 'static page preview before editing')
    const sourceMode = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('.workspace-tab-view.active button')]
        .find((node) => /^编辑$|^只读$/u.test((node.textContent || '').trim()));
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`)
    if (!sourceMode) throw new Error('the HTML edit action was not available')
    await harness.waitFor(
      () => client.evaluate(`document.querySelector('.workspace-tab-view.active .workspace-editor-monaco .monaco-editor') ? true : null`),
      20_000,
      'HTML source editor in edit mode',
    )
    const draftInput = await client.evaluate(`(() => {
      const pane = document.querySelector('.workspace-tab-view.active .workspace-editor-monaco');
      const input = pane?.querySelector('.native-edit-context') ?? pane?.querySelector('textarea.inputarea');
      if (!(input instanceof HTMLElement)) return { focused: false, reason: 'no input element' };
      input.focus();
      return { focused: document.activeElement === input, reason: null };
    })()`)
    if (draftInput.focused) await client.send('Input.insertText', { text: `\n${draftMarker}\n` })
    const draftStore = await harness.waitFor(() => client.evaluate(`(() => {
      const layouts = JSON.parse(localStorage.getItem('littlesheep.ui.workspaceSessionLayouts') || '{}');
      const drafts = Object.values(layouts).flatMap((layout) => Object.values(layout?.drafts ?? {}));
      const entries = drafts.map((draft) => ({
        path: draft?.path ?? null,
        dirty: String(draft?.editorText ?? '') !== String(draft?.savedText ?? ''),
        markerInDraft: String(draft?.editorText ?? '').includes(${JSON.stringify(draftMarker)}),
      }));
      const withMarker = entries.find((entry) => entry.markerInDraft && entry.dirty);
      return withMarker ? { draftCount: drafts.length, dirtyCount: entries.filter((entry) => entry.dirty).length, entries } : undefined;
    })()`), 15_000, 'dirty draft in the session store').catch(() => null)
    let draftRendered = null
    let draftFailure = draftInput.focused ? null : `the editor input element was not focusable: ${draftInput.reason}`
    if (draftStore) {
      const backToPreview = await client.evaluate(`(() => {
        const button = [...document.querySelectorAll('.workspace-tab-view.active button')]
          .find((node) => /^查看(源代码|预览)$/u.test((node.textContent || '').trim()));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`)
      if (!backToPreview) throw new Error('the HTML preview toggle was not available')
      try {
        draftRendered = await harness.waitFor(async () => {
          // Read the frame by *markup*: DOMPurify's own output is what the frame gets.
          const documents = await probePreviewFrameMarkup(debuggingPort, draftMarker)
          return documents.find((document) => document.hasMarker === true) ?? undefined
        }, 25_000, 'draft document in the preview')
      } catch (error) {
        draftFailure = error instanceof Error ? error.message : String(error)
      }
    } else if (!draftFailure) {
      draftFailure = 'the inserted edit never reached the session draft store'
    }
    const draftShot = await captureScreenshot(client, screenshotDir, 'preview-html-draft.png')
    recorder.note({
      step: 'preview-html-draft',
      entry: '工作区 → static-page.html → 编辑 → 输入（隐藏窗口）→ 查看预览',
      marker: draftMarker,
      input: draftInput,
      appearedInPreview: Boolean(draftRendered),
      failure: draftFailure,
      draftStore,
      document: draftRendered ?? null,
      screenshot: draftShot,
    })
    // The regression this pins: the mount effect used to run before the file loaded
    // and deleted the stored draft, so no unsaved edit survived a remount — and the
    // second check is the whole point of an edit: the preview shows it.
    recorder.check(
      draftStore?.dirtyCount >= 1 && draftStore?.entries?.some((entry) => entry.markerInDraft === true) === true,
      'the inserted edit is dirty in the session draft store',
      draftStore ?? { failure: draftFailure, input: draftInput },
    )
    recorder.check(
      draftRendered?.hasMarker === true && draftRendered.styleSheets >= 1 && draftRendered.scripts === 0,
      'the unsaved draft is what the preview renders, with styles and without scripts',
      draftRendered ?? { failure: draftFailure },
    )

    // 2c. Run entry (UX-26): the toolbar runs the *saved* page through the bounded
    // loopback service and opens it in the embedded browser. The draft restored above
    // is still unsaved, so running must ask first — and must not start anything until
    // the user answers.
    const dirtyRun = await clickPreviewAction(client, '运行')
    const dirtyPrompt = dirtyRun
      ? await harness.waitFor(() => client.evaluate(`(() => {
          const node = document.querySelector('.workspace-tab-view.active .workspace-preview-run-message');
          return node ? { text: node.textContent.trim(), actions: [...document.querySelectorAll('.workspace-tab-view.active button')].map((b) => b.textContent.trim()) } : null;
        })()`), 10_000, 'dirty draft prompt').catch(() => null)
      : null
    const serversWhilePrompted = await apiJson(locator, '/workspace/preview-server')
    const cancelled = dirtyPrompt ? await clickPreviewAction(client, '取消') : false
    const promptGone = cancelled
      ? await harness.waitFor(() => client.evaluate(`document.querySelector('.workspace-tab-view.active .workspace-preview-run-message') ? null : true`), 10_000, 'prompt dismissed').then(() => true).catch(() => false)
      : false
    const serversAfterCancel = await apiJson(locator, '/workspace/preview-server')
    const promptShot = await captureScreenshot(client, screenshotDir, 'html-run-dirty-prompt.png')
    recorder.note({
      step: 'html-run-dirty-draft',
      entry: '工作区 → static-page.html（未保存草稿）→ 运行 → 取消',
      clicked: dirtyRun,
      prompt: dirtyPrompt,
      serversWhilePrompted: serversWhilePrompted?.servers ?? null,
      cancelled,
      promptGone,
      serversAfterCancel: serversAfterCancel?.servers ?? null,
      screenshot: promptShot,
    })
    recorder.check(
      dirtyPrompt?.text?.includes('未保存') === true
      && dirtyPrompt.actions.includes('保存并运行')
      && dirtyPrompt.actions.includes('取消'),
      'a dirty draft is asked about before running, offering save-and-run or cancel',
      dirtyPrompt,
    )
    // The static preview legitimately starts the same per-root service to fetch
    // relative styles and images, so "nothing was served" is not the question here.
    // What must not happen is a *run*: the service identity may not change (no new
    // server, no new entry workout) and no browser tab may open.
    const serverIdentities = (payload) => (payload?.servers ?? []).map((server) => `${server.url}|${server.startedAt}`).sort()
    const targetsWhilePrompted = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    recorder.check(
      JSON.stringify(serverIdentities(serversWhilePrompted)) === JSON.stringify(serverIdentities(serversAfterCancel))
      && !targetsWhilePrompted.some((candidate) => candidate.type === 'webview'),
      'answering the draft question runs nothing: no new service and no browser tab',
      {
        whilePrompted: serverIdentities(serversWhilePrompted),
        afterCancel: serverIdentities(serversAfterCancel),
        webviewTargets: targetsWhilePrompted.filter((candidate) => candidate.type === 'webview').length,
      },
    )
    recorder.check(promptGone === true, 'cancelling the draft question closes it', { cancelled, promptGone })
    // Leave no half-started service behind for the steps that follow.
    await apiJson(locator, `/workspace/preview-server?root=${encodeURIComponent(workspaceDir)}`, { method: 'DELETE' }).catch(() => undefined)

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
      // Main applies the guest's web preferences at attach time (UX-26 item 3) rather than trusting the
      // renderer's webview webpreferences. A guest runs in its own WebContents, so it
      // is its own top frame and has no opener pointing back at the host document.
      isTopFrame: window.parent === window && window.top === window,
      openerIsNull: window.opener === null,
      // A popup request must not create an OS window; Main routes http(s) requests
      // into an LS browser tab and denies the window itself.
      openResult: (() => { try { return window.open('https://example.com/popup-probe', '_blank') === null ? 'denied' : 'opened' } catch (error) { return 'threw:' + String(error).slice(0, 40) } })(),
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
    // UX-26 item 5/6: starting a fresh round must work, not only the first one.
    const restartResult = await harness.waitFor(async () => {
      const clicked = await runGuest.evaluate(`(() => {
        const button = document.getElementById('restart');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`)
      if (!clicked) return undefined
      await delay(400)
      const after = await runGuest.evaluate(`window.__gameState ? { score: window.__gameState.score, x: window.__gameState.x, hud: document.getElementById('hud')?.textContent ?? null } : null`)
      return after && after.score === 0 && after.x === 20 ? after : undefined
    }, 10_000, 'restart resets the round').catch(() => null)
    recorder.note({
      step: 'html-run-restart',
      entry: '工作区 → canvas-game.html → 运行 → 重新开始',
      scoreBefore: runAfterInput.score,
      after: restartResult,
    })
    recorder.check(
      restartResult?.score === 0 && restartResult.x === 20 && restartResult.hud === '分数: 0',
      'starting a fresh round works after playing one',
      { before: runAfterInput, after: restartResult },
    )
    recorder.check(
      isolation.lsBridge === false && isolation.nodeRequire === false,
      'the running page gets no LS bridge and no Node integration',
      isolation,
    )
    recorder.check(
      isolation.isTopFrame === true && isolation.openerIsNull === true,
      'the guest is its own top frame with no opener into the host document',
      { isTopFrame: isolation.isTopFrame, openerIsNull: isolation.openerIsNull },
    )
    recorder.check(
      isolation.openResult === 'denied',
      'a popup request is denied at the window boundary (Main routes it into an LS tab)',
      { openResult: isolation.openResult },
    )

    // 2b′. UX-26 item 1: the toolbar's 重新加载 reloads the page in the tab that is
    // showing it, without restarting the service. A reload is visible to the guest as
    // a fresh document, so its `performance.timeOrigin` must change.
    const timeOriginBeforeReload = await runGuest.evaluate('performance.timeOrigin')
    await selectWorkspaceTab(client, 'canvas-game.html')
    const reloadButtonEnabled = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('.workspace-tab-view.active button')]
        .find((node) => node.textContent.trim() === '重新加载');
      if (!(button instanceof HTMLButtonElement)) return null;
      return !button.disabled;
    })()`)
    const reloadClicked = reloadButtonEnabled
      ? await clickPreviewAction(client, '重新加载')
      : false
    const reloadedOrigin = reloadClicked
      ? await harness.waitFor(async () => {
          const origin = await runGuest.evaluate('performance.timeOrigin').catch(() => undefined)
          return origin && origin !== timeOriginBeforeReload ? origin : undefined
        }, 20_000, 'guest reloaded by the toolbar').catch(() => null)
      : null
    const runServerAfterReload = await apiJson(locator, '/workspace/preview-server')
    const reloadProbe = reloadedOrigin
      ? await harness.waitFor(() => runGuest.evaluate(`window.__gameState ? (${PAGE_PROBE}) : null`), 20_000, 'game after reload').catch(() => null)
      : null
    recorder.note({
      step: 'html-run-reload',
      entry: '工作区 → canvas-game.html → 运行中 → 重新加载',
      reloadButtonEnabled,
      clicked: reloadClicked,
      timeOriginBefore: timeOriginBeforeReload,
      timeOriginAfter: reloadedOrigin,
      gameState: reloadProbe?.canvas?.gameState ?? null,
      // The same service entry, still running: reloading must not restart anything.
      serverEntry: runServerAfterReload?.servers?.[0]?.entry ?? null,
      serverStartedAt: runServerAfterReload?.servers?.[0]?.startedAt ?? null,
    })
    recorder.check(
      reloadButtonEnabled === true && reloadedOrigin !== null,
      '重新加载 gives the running page a fresh document',
      { reloadButtonEnabled, timeOriginBefore: timeOriginBeforeReload, timeOriginAfter: reloadedOrigin },
    )
    recorder.check(
      reloadProbe?.canvas?.gameState?.ready === true,
      'the reloaded page runs again (scripts execute from scratch)',
      reloadProbe ? { gameState: reloadProbe.canvas?.gameState ?? null } : null,
    )
    recorder.check(
      runServerAfterReload?.servers?.[0]?.startedAt === runServer.startedAt,
      'reloading reuses the running service instead of starting another one',
      { before: runServer.startedAt, after: runServerAfterReload?.servers?.[0]?.startedAt ?? null },
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

    // 2a′. UX-26 item 6 (placed after the canvas-run checks: the run service is per workspace root, so running another page replaces the entry): input goes to the guest and nowhere else —
    // no LS shortcut fires and no outer surface scrolls — and the guest stays a
    // resource with a lifetime (tab switch keeps it, resize reaches it, closing the
    // tab releases it).
    await openFileFromTree(client, 'canvas-game.html')
    await harness.waitFor(async () => {
      const mounted = await readPreviewFrames(client)
      return mounted.some((candidate) => candidate.title === 'HTML 预览：canvas-game.html') ? mounted : undefined
    }, 20_000, 'canvas preview for the lifecycle checks')
    await clickPreviewAction(client, '运行')
    const lifecycleServers = await harness.waitFor(async () => {
      const payload = await apiJson(locator, '/workspace/preview-server')
      return payload.servers?.length > 0 ? payload.servers : undefined
    }, 20_000, 'preview server for the lifecycle checks')
    const lifecycleTarget = await harness.waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
      return targets.find((candidate) => candidate.url === lifecycleServers[0].url) ?? undefined
    }, 30_000, 'browser tab for the lifecycle checks').catch(() => null)
    const lifecycleRunServer = lifecycleServers[0]
    const lifecycleGuest = lifecycleTarget ? new harness.CdpClient(lifecycleTarget.webSocketDebuggerUrl) : null
    if (!lifecycleGuest) throw new Error('the lifecycle checks need a browser tab for the running page')
    await lifecycleGuest.send('Runtime.enable').catch(() => undefined)
    await harness.waitFor(() => lifecycleGuest.evaluate('window.__gameState ? true : null'), 20_000, 'lifecycle guest ready').catch(() => undefined)
    const hostBeforeInput = await client.evaluate(`(() => ({
      activeTabText: document.querySelector('.workspace-tab-view.active')?.className ?? null,
      panelTab: localStorage.getItem('littlesheep.ui.workspacePanelTab'),
      composer: document.querySelector('.composer textarea')?.value ?? null,
      pageScroll: document.scrollingElement ? document.scrollingElement.scrollTop : null,
      panelScroll: document.querySelector('.workspace-files-navigator')?.scrollTop ?? null,
      tabStripScroll: document.querySelector('.workspace-tab-strip')?.scrollLeft ?? null,
    }))()`)
    const hostAfterInput = await client.evaluate(`(() => ({
      activeTabText: document.querySelector('.workspace-tab-view.active')?.className ?? null,
      panelTab: localStorage.getItem('littlesheep.ui.workspacePanelTab'),
      composer: document.querySelector('.composer textarea')?.value ?? null,
      pageScroll: document.scrollingElement ? document.scrollingElement.scrollTop : null,
      panelScroll: document.querySelector('.workspace-files-navigator')?.scrollTop ?? null,
      tabStripScroll: document.querySelector('.workspace-tab-strip')?.scrollLeft ?? null,
    }))()`)
    recorder.note({ step: 'html-run-host-untouched', before: hostBeforeInput, after: hostAfterInput })
    recorder.check(
      JSON.stringify(hostBeforeInput) === JSON.stringify(hostAfterInput),
      'keys and clicks sent to the running page change nothing in the LS surface',
      { before: hostBeforeInput, after: hostAfterInput },
    )

    // Tab switch keeps the guest alive; resizing reaches it; closing the tab releases it.
    await selectWorkspaceTab(client, 'canvas-game.html')
    await delay(600)
    const guestAfterTabSwitch = await lifecycleGuest.evaluate(`window.__gameState ? window.__gameState.ready : null`).catch(() => null)
    await harness.desktopAction(locator, 'resize', { width: 1100, height: 760 })
    const guestAfterResize = await harness.waitFor(async () => {
      const size = await lifecycleGuest.evaluate('({ w: window.innerWidth, h: window.innerHeight })').catch(() => null)
      return size && size.w < 1280 ? size : undefined
    }, 15_000, 'guest viewport follows the window resize').catch(() => null)
    await harness.desktopAction(locator, 'resize', WINDOW)
    const targetsBeforeClose = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    // The browser tab is labelled by its host (`127.0.0.1` for a run), not by the
    // file name — matching the file name closed the *file* tab and measured nothing.
    // Close every browser tab (the switch above made the *file* tab active, so the run's
    // tab is among them) and require this run's guest to disappear.
    const closedCount = await client.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.workspace-active-item[data-workspace-tab-kind="browser"] button.workspace-active-close')];
      for (const button of buttons) { if (button instanceof HTMLElement) button.click(); }
      return buttons.length;
    })()`)
    const closed = closedCount > 0
    await delay(500)
    const guestTargetGone = closed
      ? await harness.waitFor(async () => {
          const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
          return targets.some((candidate) => candidate.url === lifecycleRunServer.url) ? undefined : true
        }, 20_000, 'guest target released when its tab closes').catch(() => false)
      : false
    const targetsAfterClose = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
    recorder.note({
      step: 'html-run-guest-lifecycle',
      entry: '工作区 → 运行 canvas-game.html → 切标签 → 调整窗口 → 关闭标签',
      guestAfterTabSwitch,
      guestAfterResize,
      targets: {
        before: targetsBeforeClose.filter((candidate) => candidate.url === lifecycleRunServer.url).length,
        after: targetsAfterClose.filter((candidate) => candidate.url === lifecycleRunServer.url).length,
      },
      closedCount,
      closed,
      guestTargetGone,
    })
    recorder.check(
      guestAfterTabSwitch === true && guestAfterResize !== null,
      'the running page survives a tab switch and follows a window resize',
      { guestAfterTabSwitch, guestAfterResize },
    )
    recorder.check(
      closed === true && guestTargetGone === true,
      'closing the browser tab releases the guest',
      { closedCount, closed, guestTargetGone },
    )
    // Leave nothing running: the shared per-root service would otherwise keep this pane
    // in "running", which disables 运行 for the steps that follow.
    await selectWorkspaceTab(client, 'canvas-game.html')
    await clickPreviewAction(client, '停止')
    await apiJson(locator, `/workspace/preview-server?root=${encodeURIComponent(workspaceDir)}`, { method: 'DELETE' }).catch(() => undefined)

    // UX-25 item 4: the *static* preview cannot run scripts, so a missing stylesheet
    // or image is invisible inside the frame — Main's service is the witness, and the
    // notice names the files with a retry next to them.
    await openFileFromTree(client, 'error-page.html')
    await harness.waitFor(async () => {
      const mounted = await readPreviewFrames(client)
      return mounted.some((candidate) => candidate.title === 'HTML 预览：error-page.html') ? mounted : undefined
    }, 20_000, 'error page static preview')
    const assetNotice = await harness.waitFor(() => client.evaluate(`(() => {
      const notice = document.querySelector('.workspace-tab-view.active .workspace-preview-asset-notice');
      const summary = notice?.querySelector('.workspace-preview-asset-summary');
      return summary ? { text: summary.textContent.trim(), retry: Boolean(notice.querySelector('.workspace-preview-asset-retry')) } : null;
    })()`), 30_000, 'preview asset failure notice').catch(() => null)
    const assetDetails = assetNotice
      ? await client.evaluate(`(() => {
          const notice = document.querySelector('.workspace-tab-view.active .workspace-preview-asset-notice');
          notice?.querySelector('.workspace-preview-asset-summary')?.click();
          return true;
        })()`)
      : false
    const assetReasons = assetDetails
      ? await harness.waitFor(() => client.evaluate(`(() => {
          const items = [...document.querySelectorAll('.workspace-tab-view.active .workspace-preview-asset-list li')]
            .map((item) => item.textContent.replace(/\\s+/gu, ' ').trim());
          return items.length > 0 ? items : undefined;
        })()`), 10_000, 'preview asset failure reasons').catch(() => null)
      : null
    const assetService = await apiJson(locator, '/workspace/preview-server')
    const retryShot = await captureScreenshot(client, screenshotDir, 'preview-asset-failures.png')
    recorder.note({
      step: 'preview-asset-failures',
      entry: '工作区 → error-page.html（静态预览：缺失样式表与图片）',
      notice: assetNotice,
      reasons: assetReasons,
      serverFailures: (assetService.servers ?? []).flatMap((server) => server.assetFailures ?? []).map((failure) => `${failure.status} ${failure.path}`),
      screenshot: retryShot,
    })
    recorder.check(
      Boolean(assetNotice?.text?.includes('个资源未能加载')) && assetNotice.retry === true,
      'the static preview says how many resources failed and offers a retry',
      assetNotice,
    )
    recorder.check(
      Array.isArray(assetReasons)
      && assetReasons.some((reason) => reason.includes('missing-style.css'))
      && assetReasons.some((reason) => reason.includes('missing-image.png')),
      'expanding the notice names each failed resource with its reason',
      { reasons: assetReasons },
    )

    // compact summary with the raw messages behind a disclosure.
    await openFileFromTree(client, 'error-page.html')
    await harness.waitFor(async () => {
      const mounted = await readPreviewFrames(client)
      return mounted.some((candidate) => candidate.title === 'HTML 预览：error-page.html') ? mounted : undefined
    }, 20_000, 'error page preview before running')
    const startedErrorRun = await clickPreviewAction(client, '运行')
    const errorServers = await harness.waitFor(async () => {
      const payload = await apiJson(locator, '/workspace/preview-server')
      return payload.servers?.length > 0 ? payload.servers : undefined
    }, 20_000, 'preview server for the error page')
    const errorRunUrl = errorServers[0].url
    await harness.waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
      return targets.find((candidate) => candidate.url === errorRunUrl) ?? undefined
    }, 30_000, 'browser tab for the error page')
    // Running opens the browser tab, which becomes active: the readout lives next to
    // the file's run controls, so go back to that tab to read it.
    await selectWorkspaceTab(client, 'error-page.html')
    // The guest reports asynchronously; wait for the projection the toolbar renders.
    const diagnosticsNotice = await harness.waitFor(() => client.evaluate(`(() => {
      const node = document.querySelector('.workspace-tab-view.active .workspace-preview-run-diagnostics');
      const button = node?.querySelector('button');
      return button ? { summary: button.textContent.trim(), expanded: button.getAttribute('aria-expanded') } : null;
    })()`), 30_000, 'run diagnostics summary').catch(() => null)
    const expandedDiagnostics = diagnosticsNotice
      ? await client.evaluate(`(() => {
          const node = document.querySelector('.workspace-tab-view.active .workspace-preview-run-diagnostics');
          node?.querySelector('button')?.click();
          return true;
        })()`)
      : false
    const diagnosticsDetails = expandedDiagnostics
      ? await harness.waitFor(() => client.evaluate(`(() => {
          const items = [...document.querySelectorAll('.workspace-tab-view.active .workspace-preview-run-diagnostics-list li')]
            .map((item) => item.textContent.replace(/\\s+/gu, ' ').trim());
          return items.length > 0 ? items : undefined;
        })()`), 10_000, 'run diagnostics details').catch(() => null)
      : null
    const diagnosticsApi = await apiJson(locator, `/browser/diagnostics?url=${encodeURIComponent(errorRunUrl)}`)
    const diagnosticsShot = await captureScreenshot(client, screenshotDir, 'html-run-diagnostics.png')
    recorder.note({
      step: 'html-run-diagnostics',
      entry: '工作区 → error-page.html → 运行（脚本抛错 + 缺失资源）',
      clicked: startedErrorRun,
      runUrl: errorRunUrl,
      notice: diagnosticsNotice,
      details: diagnosticsDetails,
      counts: diagnosticsApi.counts ?? null,
      entries: (diagnosticsApi.entries ?? []).map((entry) => ({ kind: entry.kind, message: entry.message.slice(0, 90) })),
      screenshot: diagnosticsShot,
    })
    recorder.check(
      (diagnosticsApi.counts?.script ?? 0) >= 1,
      'Main records the script error the running page threw',
      diagnosticsApi.counts ?? null,
    )
    recorder.check(
      (diagnosticsApi.counts?.resource ?? 0) >= 1,
      'Main records the failed resource the running page asked for',
      diagnosticsApi.counts ?? null,
    )
    recorder.check(
      diagnosticsNotice?.summary.includes('脚本报错') === true && diagnosticsNotice.summary.includes('资源失败'),
      'the toolbar states the script error and the failed resource without DevTools',
      diagnosticsNotice,
    )
    recorder.check(
      Array.isArray(diagnosticsDetails) && diagnosticsDetails.some((line) => line.includes('夹具脚本错误')),
      'the details disclose the message the page itself produced',
      diagnosticsDetails,
    )
    await selectWorkspaceTab(client, 'error-page.html')
    await clickPreviewAction(client, '停止')
    await apiJson(locator, `/workspace/preview-server?root=${encodeURIComponent(workspaceDir)}`, { method: 'DELETE' }).catch(() => undefined)

    // 2e. UX-26 resilience: a page that spins forever must not take the app document
    // with it (the stop control has to keep working), and neither must a crashed guest.
    // Both are measured as how long the app takes to answer while the guest is dead.
    const measureAppResponse = async (label) => {
      const started = Date.now()
      const answered = await client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement`)
        .catch(() => null)
      return { label, answered: answered === true, ms: Date.now() - started }
    }
    await openFileFromTree(client, 'loop-page.html')
    await harness.waitFor(async () => {
      const mounted = await readPreviewFrames(client)
      return mounted.some((candidate) => candidate.title === 'HTML 预览：loop-page.html') ? mounted : undefined
    }, 20_000, 'loop page preview before running')
    const startedLoopRun = await clickPreviewAction(client, '运行')
    const loopServers = await harness.waitFor(async () => {
      const payload = await apiJson(locator, '/workspace/preview-server')
      return payload.servers?.length > 0 ? payload.servers : undefined
    }, 20_000, 'preview server for the loop page')
    const loopUrl = loopServers[0].url
    const loopTarget = await harness.waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
      return targets.find((candidate) => candidate.url === loopUrl) ?? undefined
    }, 30_000, 'browser tab for the loop page').catch(() => null)
    // The guest may answer once (its script ran before the loop) and then must not.
    // Everything about this probe is bounded: a renderer spinning in a `while (true)`
    // never answers `Runtime.enable` either, and an unbounded CDP call is exactly how
    // this step hung the whole gate the first time.
    const loopGuestAnswer = loopTarget
      ? await Promise.race([
          (async () => {
            const loopGuest = new harness.CdpClient(loopTarget.webSocketDebuggerUrl)
            try {
              await loopGuest.send('Runtime.enable')
              return await loopGuest.evaluate('document.getElementById("ready")?.textContent ?? null').catch(() => null)
            } finally {
              loopGuest.close()
            }
          })().catch(() => null),
          delay(8_000).then(() => 'timeout'),
        ])
      : null
    await selectWorkspaceTab(client, 'loop-page.html')
    const loopResponses = [await measureAppResponse('loop:file-tab')]
    const loopStopClicked = await clickPreviewAction(client, '停止')
    const loopResponsesAfterStop = [await measureAppResponse('loop:after-stop')]
    await apiJson(locator, `/workspace/preview-server?root=${encodeURIComponent(workspaceDir)}`, { method: 'DELETE' }).catch(() => undefined)
    const loopShot = await captureScreenshot(client, screenshotDir, 'html-run-loop-page.png')

    // Crash a healthy run's guest, then drive the toolbar again.
    await openFileFromTree(client, 'canvas-game.html')
    await harness.waitFor(async () => {
      const mounted = await readPreviewFrames(client)
      return mounted.some((candidate) => candidate.title === 'HTML 预览：canvas-game.html') ? mounted : undefined
    }, 20_000, 'canvas preview before the crash check')
    await clickPreviewAction(client, '运行')
    const crashServers = await harness.waitFor(async () => {
      const payload = await apiJson(locator, '/workspace/preview-server')
      return payload.servers?.length > 0 ? payload.servers : undefined
    }, 20_000, 'preview server for the crash check')
    const crashTarget = await harness.waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
      return targets.find((candidate) => candidate.url === crashServers[0].url) ?? undefined
    }, 30_000, 'browser tab for the crash check').catch(() => null)
    const crashGuest = crashTarget ? new harness.CdpClient(crashTarget.webSocketDebuggerUrl) : null
    let crashReply = 'not-attempted'
    let guestAnswerAfterCrash = 'not-attempted'
    if (crashGuest) {
      await crashGuest.send('Runtime.enable').catch(() => undefined)
      // Electron never answers `Page.crash`: the renderer dies before the reply is
      // written (measured — the reply times out while every later call goes silent
      // too). So the crash is established by the guest going silent, not by a reply.
      crashReply = await Promise.race([
        crashGuest.send('Page.crash').then(() => 'replied').catch((error) => `error:${error}`),
        delay(8_000).then(() => 'no-reply'),
      ])
      await delay(1_500)
      guestAnswerAfterCrash = await Promise.race([
        crashGuest.evaluate('1 + 1').then((value) => `answered:${value}`).catch(() => 'error'),
        delay(6_000).then(() => 'timeout'),
      ])
      crashGuest.close()
    }
    await selectWorkspaceTab(client, 'canvas-game.html')
    const crashResponse = await measureAppResponse('crash:file-tab')
    // "停止 / 重载仍可用": both controls must still drive the app after the crash.
    const crashReloadClicked = await clickPreviewAction(client, '重新加载')
    const crashReloadResponse = await measureAppResponse('crash:reload')
    const crashStopClicked = await clickPreviewAction(client, '停止')
    const crashServerGone = await fetch(crashServers[0].url, { signal: AbortSignal.timeout(5_000) }).then((response) => response.status).catch(() => 0)
    const crashApi = await apiJson(locator, '/workspace/preview-server')
    await apiJson(locator, `/workspace/preview-server?root=${encodeURIComponent(workspaceDir)}`, { method: 'DELETE' }).catch(() => undefined)
    recorder.note({
      step: 'html-run-resilience',
      entry: '工作区 → loop-page.html（脚本死循环）→ 停止；canvas-game.html → guest 崩溃 → 停止',
      loop: {
        clicked: startedLoopRun,
        runUrl: loopUrl,
        guestAnswer: loopGuestAnswer,
        responses: [...loopResponses, ...loopResponsesAfterStop],
        stopClicked: loopStopClicked,
      },
      crash: {
        reply: crashReply,
        guestAnswerAfterCrash,
        response: crashResponse,
        reloadClicked: crashReloadClicked,
        reloadResponse: crashReloadResponse,
        stopClicked: crashStopClicked,
        urlAfterStop: crashServerGone,
        openServers: crashApi.servers?.length ?? null,
      },
      screenshot: loopShot,
    })
    recorder.check(
      loopResponses.every((entry) => entry.answered) && loopResponses[0].ms < 5_000,
      'a page spinning forever does not take the app document with it',
      loopResponses,
    )
    recorder.check(
      loopStopClicked === true && loopResponsesAfterStop.every((entry) => entry.answered),
      'the stop control still works while the page is unresponsive',
      { loopStopClicked, after: loopResponsesAfterStop },
    )
    recorder.check(
      crashReply !== 'not-attempted'
      && guestAnswerAfterCrash === 'timeout'
      && crashResponse.answered === true
      && crashReloadClicked === true
      && crashReloadResponse.answered === true
      && crashStopClicked === true
      && crashServerGone === 0,
      'a crashed guest leaves the app driving the toolbar (stop still releases the service)',
      { crashReply, guestAnswerAfterCrash, crashResponse, crashReloadClicked, crashReloadResponse, crashStopClicked, urlAfterStop: crashServerGone },
    )

    // 2f. UX-26 item 5: a *multi-file* page runs from the HTML entry — its module,
    // stylesheet, image and local JSON are all served — the game reacts to a click, and
    // editing a file on disk shows up after 重新加载.
    await openFileFromTree(client, 'index.html')
    await harness.waitFor(async () => {
      const mounted = await readPreviewFrames(client)
      return mounted.some((candidate) => candidate.title === 'HTML 预览：index.html') ? mounted : undefined
    }, 20_000, 'multi-file preview before running')
    const startedMultiRun = await clickPreviewAction(client, '运行')
    const multiServers = await harness.waitFor(async () => {
      const payload = await apiJson(locator, '/workspace/preview-server')
      return payload.servers?.length > 0 ? payload.servers : undefined
    }, 20_000, 'preview server for the multi-file page')
    const multiRunUrl = multiServers[0].url
    const multiTarget = await harness.waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
      return targets.find((candidate) => candidate.url === multiRunUrl) ?? undefined
    }, 30_000, 'browser tab for the multi-file page').catch(() => null)
    const multiGuest = multiTarget ? new harness.CdpClient(multiTarget.webSocketDebuggerUrl) : null
    let multiProbe = null
    let multiStepped = null
    let multiAfterReload = null
    let multiReloadOrigin = null
    if (multiGuest) {
      await multiGuest.send('Runtime.enable')
      multiProbe = await harness.waitFor(() => multiGuest.evaluate(`window.__multiState?.level ? (() => {
        const styles = [...document.styleSheets].map((sheet) => { try { return [...sheet.cssRules].length } catch { return -1 } });
        const sprite = document.querySelector('.sprite');
        const board = document.querySelector('.board');
        return {
          level: document.getElementById('level')?.textContent ?? null,
          steps: document.getElementById('steps')?.textContent ?? null,
          styleSheetRules: styles.reduce((total, count) => total + count, 0),
          spriteNaturalWidth: sprite?.naturalWidth ?? 0,
          boardBackground: board ? getComputedStyle(board).backgroundColor : null,
          moduleRan: window.__multiState?.ready === true,
        };
      })() : null`), 30_000, 'multi-file page initialized')
      multiStepped = await harness.waitFor(async () => {
        const before = await multiGuest.evaluate(`document.getElementById('steps')?.textContent ?? null`)
        await multiGuest.evaluate(`(() => { document.getElementById('step')?.click(); return true })()`)
        await delay(300)
        const after = await multiGuest.evaluate(`document.getElementById('steps')?.textContent ?? null`)
        return before !== after ? { before, after } : undefined
      }, 10_000, 'step button advances the counter').catch(() => null)

      // Change the JSON on disk, then reload through the toolbar: the page must pick it up.
      await writeFile(join(workspaceDir, 'multi-file', 'level.json'), '{ "level": 9, "target": 3 }\n', 'utf8')
      const originBeforeReload = await multiGuest.evaluate('performance.timeOrigin')
      await selectWorkspaceTab(client, 'index.html')
      const multiReloadClicked = await clickPreviewAction(client, '重新加载')
      multiReloadOrigin = multiReloadClicked
        ? await harness.waitFor(async () => {
            const origin = await multiGuest.evaluate('performance.timeOrigin').catch(() => undefined)
            return origin && origin !== originBeforeReload ? origin : undefined
          }, 20_000, 'multi-file page reloaded').catch(() => null)
        : null
      if (multiReloadOrigin) {
        multiAfterReload = await harness.waitFor(() => multiGuest.evaluate(`window.__multiState?.level === 9 ? {
          level: document.getElementById('level')?.textContent ?? null,
          steps: document.getElementById('steps')?.textContent ?? null,
          styleSheetRules: [...document.styleSheets].reduce((total, sheet) => { try { return total + [...sheet.cssRules].length } catch { return total } }, 0),
          spriteNaturalWidth: document.querySelector('.sprite')?.naturalWidth ?? 0,
        } : null`), 20_000, 'edited JSON visible after reload').catch(() => null)
      }
      multiGuest.close()
    }
    const multiShot = await captureScreenshot(client, screenshotDir, 'html-run-multi-file.png')
    recorder.note({
      step: 'html-run-multi-file',
      entry: '工作区 → multi-file/index.html → 运行 → 前进一步 → 改 level.json → 重新加载',
      clicked: startedMultiRun,
      runUrl: multiRunUrl,
      probe: multiProbe,
      stepped: multiStepped,
      reloadedOrigin: multiReloadOrigin,
      afterReload: multiAfterReload,
      screenshot: multiShot,
    })
    recorder.check(
      multiProbe?.moduleRan === true
      && multiProbe.level === '7'
      && multiProbe.styleSheetRules > 0
      && multiProbe.spriteNaturalWidth > 0,
      'a running multi-file page gets its module, stylesheet, image and local JSON',
      multiProbe,
    )
    recorder.check(
      multiStepped !== null,
      'the running page reacts to a real click',
      multiStepped,
    )
    recorder.check(
      multiAfterReload?.level === '9',
      'editing a file on disk reaches the page after 重新加载',
      { reloadedOrigin: multiReloadOrigin, afterReload: multiAfterReload },
    )
    await selectWorkspaceTab(client, 'index.html')
    await clickPreviewAction(client, '停止')
    await apiJson(locator, `/workspace/preview-server?root=${encodeURIComponent(workspaceDir)}`, { method: 'DELETE' }).catch(() => undefined)
    // Put the edited fixture back: the Git comparison later in this walkthrough reads a
    // status whose expected shape is one modified file plus one untracked file.
    await writeFile(join(workspaceDir, 'multi-file', 'level.json'), MULTI_LEVEL, 'utf8')
    recorder.note({ step: 'html-run-multi-file-restored', restored: MULTI_LEVEL.trim() })

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

    // UX-25 item 3: the pane must say when disk no longer matches what it shows, a save
    // must refresh to the saved version, a save that loses the race must keep the draft,
    // and fast switching must not mix two files.
    const previewDiskFixturePath = join(workspaceDir, 'save-fixture.html')
    await openFileFromTree(client, 'save-fixture.html')
    await harness.waitFor(async () => {
      const mounted = await readPreviewFrames(client)
      return mounted.some((candidate) => candidate.title === 'HTML 预览：save-fixture.html') ? mounted : undefined
    }, 20_000, 'save fixture for the disk-state checks')
    const readDiskNotice = () => client.evaluate(`(() => {
      const notice = document.querySelector('.workspace-tab-view.active .workspace-preview-disk-notice');
      if (!notice) return null;
      return {
        tone: notice.getAttribute('data-tone'),
        message: notice.querySelector('.workspace-preview-disk-message')?.textContent?.trim() ?? '',
        actions: [...notice.querySelectorAll('.workspace-preview-disk-action')].map((button) => button.textContent.trim()),
      };
    })()`)
    const waitForNotice = (needle) => harness.waitFor(async () => {
      const notice = await readDiskNotice()
      return notice && notice.message.includes(needle) ? notice : undefined
    }, 25_000, `disk notice containing "${needle}"`).catch(() => null)
    const clickDiskAction = (label) => client.evaluate(`(() => {
      const notice = document.querySelector('.workspace-tab-view.active .workspace-preview-disk-notice');
      const button = [...(notice?.querySelectorAll('.workspace-preview-disk-action') ?? [])]
        .find((node) => (node.textContent || '').trim() === ${JSON.stringify(label)});
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`)
    const activeFrameMarkup = () => client.evaluate(`(() => {
      const active = document.querySelector('.workspace-tab-view.active');
      const frame = active?.querySelector('.workspace-preview-html');
      const srcdoc = frame?.getAttribute('srcdoc') ?? '';
      return {
        crumbs: [...(active?.querySelectorAll('.workspace-preview-breadcrumbs em') ?? [])].map((node) => node.textContent.trim()),
        title: frame?.getAttribute('title') ?? null,
        srcdoc,
      };
    })()`)
    const sessionDraft = () => client.evaluate(`(() => {
      const layouts = JSON.parse(localStorage.getItem('littlesheep.ui.workspaceSessionLayouts') || '{}');
      const drafts = Object.values(layouts).flatMap((layout) => Object.values(layout?.drafts ?? {}));
      const entry = drafts.find((draft) => String(draft?.path ?? '').endsWith('save-fixture.html'));
      return entry ? {
        dirty: String(entry.editorText ?? '') !== String(entry.savedText ?? ''),
        text: String(entry.editorText ?? ''),
      } : null;
    })()`)
    /**
     * Saving has no button: the pane saves on Ctrl+S (its keydown capture handler).
     * A synthetic event on the pane reaches that handler exactly like a real keystroke
     * would, without depending on where the OS focus happens to be.
     */
    /**
     * Saving is an approval-gated write outside 完全访问: the app asks in a modal and the
     * save waits for the answer, so the walkthrough answers it — exactly what a user
     * does — and reports which answer it gave. A dialog left open would block every
     * later step, which is how this was found.
     */
    const approvePendingSave = async () => {
      const prompt = await harness.waitFor(() => client.evaluate(`(() => {
        const dialog = document.querySelector('.approval-prompt');
        if (!dialog) return null;
        const buttons = [...dialog.querySelectorAll('button.approval-action')].map((node) => node.textContent.trim());
        return { buttons, text: dialog.textContent.replace(/\\s+/gu, ' ').trim().slice(0, 160) };
      })()`), 8_000, 'save approval prompt').catch(() => null)
      if (!prompt) return null
      const approved = await client.evaluate(`(() => {
        const dialog = document.querySelector('.approval-prompt');
        const button = [...(dialog?.querySelectorAll('button.approval-action') ?? [])]
          .find((node) => (node.textContent || '').trim() === '本对话允许');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`)
      return { prompt, approved }
    }
    const saveActivePane = () => client.evaluate(`(() => {
      const body = document.querySelector('.workspace-tab-view.active .workspace-preview-body');
      if (!(body instanceof HTMLElement)) return false;
      body.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`)
    /** The hidden-window recipe: edit mode, source mode, focus, then insertText. */
    const typeIntoEditor = async (marker) => {
      await clickPreviewAction(client, '编辑')
      await clickPreviewAction(client, '查看源代码')
      const ready = await harness.waitFor(
        () => client.evaluate(`document.querySelector('.workspace-tab-view.active .workspace-editor-monaco .monaco-editor') ? true : null`),
        20_000,
        'editor in source mode',
      ).then(() => true).catch(() => false)
      if (!ready) return false
      const focused = await client.evaluate(`(() => {
        const pane = document.querySelector('.workspace-tab-view.active .workspace-editor-monaco');
        const input = pane?.querySelector('.native-edit-context') ?? pane?.querySelector('textarea.inputarea');
        if (!(input instanceof HTMLElement)) return false;
        input.focus();
        return document.activeElement === input;
      })()`)
      if (!focused) return false
      await client.send('Input.insertText', { text: marker })
      return harness.waitFor(async () => {
        const draft = await sessionDraft()
        return draft?.text.includes(marker) && draft.dirty ? true : undefined
      }, 15_000, 'draft holding the typed marker').then(() => true).catch(() => false)
    }

    // 3a. Save success: the draft reaches disk and the pane settles on the saved version.
    const saveMarker = `SAVED-${Date.now().toString(36)}`
    const draftTyped = await typeIntoEditor(`\n<p id="${saveMarker}">${saveMarker}</p>\n`)
    const saveDispatched = draftTyped ? await saveActivePane() : false
    const saveApproval = saveDispatched ? await approvePendingSave() : null
    const saveClicked = saveDispatched && Boolean(saveApproval?.approved || saveApproval === null)
    const savedToDisk = saveClicked
      ? await harness.waitFor(async () => (
          (await readFile(previewDiskFixturePath, 'utf8')).includes(saveMarker) ? true : undefined
        ), 20_000, 'saved marker on disk').then(() => true).catch(() => false)
      : false
    const saveStatus = await client.evaluate(`(() => {
      const status = document.querySelector('.workspace-tab-view.active .workspace-editor-status');
      return { text: status?.textContent?.trim() ?? null, error: Boolean(status?.classList.contains('error')) };
    })()`)
    const draftAfterSave = await harness.waitFor(async () => {
      const draft = await sessionDraft()
      return draft && !draft.dirty ? draft : undefined
    }, 15_000, 'draft clean after the save').catch(() => sessionDraft())
    await clickPreviewAction(client, '查看预览')
    const previewAfterSave = await harness.waitFor(async () => {
      const markup = await activeFrameMarkup()
      return markup.srcdoc.includes(saveMarker) ? markup : undefined
    }, 20_000, 'preview showing the saved version').catch(() => null)

    // 3b. External change: the pane says so; reloading from disk shows the disk version.
    await writeFile(previewDiskFixturePath, STATIC_PAGE.replace('静态页夹具', '静态页夹具（磁盘第二版）'), 'utf8')
    const changedNotice = await waitForNotice('磁盘上的版本已变化')
    const diskReloadClicked = changedNotice ? await clickDiskAction('重新加载磁盘版本') : false
    const reloadedMarkup = diskReloadClicked
      ? await harness.waitFor(async () => {
          const markup = await activeFrameMarkup()
          return markup.srcdoc.includes('磁盘第二版') ? markup : undefined
        }, 20_000, 'pane showing the disk version after reload').catch(() => null)
      : null
    const clearedAfterReload = diskReloadClicked
      ? await harness.waitFor(async () => ((await readDiskNotice()) === null ? true : undefined), 20_000, 'notice cleared after reloading from disk').catch(() => false)
      : false

    // 3c. A draft is never dropped: dismiss keeps it, and a save that lost the race keeps
    // it too, with the reason shown.
    const keepMarker = `KEPT-${Date.now().toString(36)}`
    const keepDraftTyped = await typeIntoEditor(`\n<p id="${keepMarker}">${keepMarker}</p>\n`)
    await writeFile(previewDiskFixturePath, STATIC_PAGE.replace('静态页夹具', '静态页夹具（磁盘第三版）'), 'utf8')
    const conflictNotice = await waitForNotice('磁盘上的版本已变化')
    const keptClicked = conflictNotice ? await clickDiskAction('保留我的修改') : false
    await delay(1200)
    const dismissed = (await readDiskNotice()) === null
    const conflictDispatched = keptClicked ? await saveActivePane() : false
    const conflictApproval = conflictDispatched ? await approvePendingSave() : null
    const conflictSave = conflictDispatched && Boolean(conflictApproval?.approved || conflictApproval === null)
    const conflictStatus = conflictSave
      ? await harness.waitFor(() => client.evaluate(`(() => {
          const status = document.querySelector('.workspace-tab-view.active .workspace-editor-status');
          return status?.classList.contains('error') ? { text: status.textContent.trim(), error: true } : undefined;
        })()`), 20_000, 'save failure shown in place').catch(() => null)
      : null
    const draftAfterConflict = await sessionDraft()

    // 3d. Deletion, then the file coming back.
    await rm(previewDiskFixturePath, { force: true })
    const deletedNotice = await waitForNotice('已不在磁盘上')
    await writeFile(previewDiskFixturePath, STATIC_PAGE, 'utf8')
    const noticeAfterRestore = await harness.waitFor(async () => {
      const notice = await readDiskNotice()
      return notice === null || !notice.message.includes('已不在磁盘上') ? (notice?.message ?? 'none') : undefined
    }, 25_000, 'deleted notice replaced once the file is back').catch(() => null)

    // 3e. Fast switching: click A → B → C with no waiting in between (the tabs are all
    // opened), then walk the tabs and require each one to show its own file and nothing
    // from the others. Reading the *active* tab after the burst only proves whichever
    // click landed last, which is a property of the harness, not of the product.
    await clickPreviewAction(client, '查看预览')
    await openFileFromTree(client, 'canvas-game.html')
    await openFileFromTree(client, 'index.html')
    await openFileFromTree(client, 'save-fixture.html')
    const switchEvidence = []
    for (const expected of [
      { tab: 'save-fixture.html', marker: saveMarker, foreign: ['__gameState', '多文件夹具'] },
      { tab: 'canvas-game.html', marker: '分数:', foreign: [saveMarker, '多文件夹具'] },
      { tab: 'index.html', marker: '多文件夹具', foreign: [saveMarker, '分数:'] },
    ]) {
      await selectWorkspaceTab(client, expected.tab)
      const markup = await harness.waitFor(async () => {
        const shown = await activeFrameMarkup()
        return shown.crumbs.join('/').endsWith(expected.tab) ? shown : undefined
      }, 20_000, `pane settled on ${expected.tab}`).catch(async () => activeFrameMarkup())
      switchEvidence.push({
        tab: expected.tab,
        crumbs: markup.crumbs,
        title: markup.title,
        hasOwnMarker: markup.srcdoc.includes(expected.marker),
        foreignFound: expected.foreign.filter((needle) => markup.srcdoc.includes(needle)),
      })
    }
    const switchShot = await captureScreenshot(client, screenshotDir, 'preview-disk-and-save.png')

    recorder.note({ step: 'preview-switch-isolation', entry: '工作区 → 快速打开 A/B/C 后逐个标签核对', evidence: switchEvidence, screenshot: switchShot })
    recorder.check(
      switchEvidence.every((entry) => entry.hasOwnMarker && entry.foreignFound.length === 0),
      'every tab shows its own file and none of the others after fast switching',
      { evidence: switchEvidence },
    )
    // Nothing may stay modal: an unanswered prompt would block every later step.
    const leftoverPrompt = await client.evaluate(`(() => {
      const dialog = document.querySelector('.approval-prompt');
      if (!dialog) return null;
      const deny = [...dialog.querySelectorAll('button.approval-action')]
        .find((node) => (node.textContent || '').trim() === '拒绝');
      if (deny instanceof HTMLElement) deny.click();
      return dialog.textContent.replace(/\\s+/gu, ' ').trim().slice(0, 120);
    })()`)
    recorder.note({ step: 'preview-approval-leftover', leftoverPrompt })
    recorder.check(
      leftoverPrompt === null,
      'the walkthrough leaves no approval prompt open behind it',
      { leftoverPrompt },
    )

    // Leave the tab idle and clean. A dirty draft on an HTML tab makes the next 运行 ask
    // "保存并运行 / 取消" instead of running, which is exactly how the following step
    // stalled (measured): reload the disk version, save the draft, then put the fixture
    // back byte for byte so the Git comparison further down counts the changes it expects.
    await waitForNotice('磁盘上的版本已变化')
    await clickDiskAction('重新加载磁盘版本')
    await saveActivePane()
    await approvePendingSave()
    await delay(500)
    const draftAfterCleanup = await sessionDraft()
    await writeFile(previewDiskFixturePath, STATIC_PAGE, 'utf8')
    const diskBackToCommitted = await readFile(previewDiskFixturePath, 'utf8').then((text) => text === STATIC_PAGE)
    recorder.note({
      step: 'preview-save-fixture-cleanup',
      draftStillHeld: Boolean(draftAfterCleanup?.dirty),
      diskBackToCommitted,
    })
    // Two facts worth keeping: the fixture is byte-identical to what the repository holds
    // (the Git comparison further down depends on it), and the user's draft is still
    // there — nothing in this walkthrough silently discarded it.
    recorder.check(
      diskBackToCommitted === true && draftAfterCleanup?.dirty === true,
      'the fixture is restored on disk while the draft is still held, never silently dropped',
      { diskBackToCommitted, draftStillHeld: Boolean(draftAfterCleanup?.dirty) },
    )
    // without DevTools. Main records what the guest reported; the toolbar shows a

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
