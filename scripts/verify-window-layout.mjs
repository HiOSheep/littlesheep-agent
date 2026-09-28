// Real native-window geometry and desktop-composited backdrop acceptance.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, CdpClient, delay } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000 })
await harness.assertBuildFresh()
const root = await mkdtemp(join(tmpdir(), 'littlesheep-window-layout-'))
const dataDir = join(root, 'data')
await mkdir(join(dataDir, 'workplace'), { recursive: true })
await writeFile(join(dataDir, 'config.json'), JSON.stringify({
  version: 1, providers: [],
  agents: { defaults: { workspace: join(dataDir, 'workplace'), model: '', harness: 'core-flow' } },
  desktop: { closePolicy: 'always-background' },
}))
const debuggingPort = await harness.reservePort()
const mainDebuggingPort = await harness.reservePort()
const child = await harness.startElectron({ dataDir, chromiumDir: join(root, 'chromium'), debuggingPort, mainDebuggingPort, logPath: join(root, 'electron.log') })
let client, main, locator
const results = []
async function state() {
  return client.evaluate(`(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector); if (!node) return null;
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      return { x:r.x, y:r.y, width:r.width, height:r.height, background:s.backgroundColor, radius:s.borderTopLeftRadius };
    };
    return { layout:document.documentElement.dataset.windowLayout, backdrop:document.documentElement.dataset.nativeBackdrop,
      title:rect('.window-titlebar'), sidebar:rect('.sidebar-surface'), core:rect('.core-workspace'),
      settings:rect('.settings-sidebar'), settingsBody:rect('.settings-workspace-body'),
      collapsed:document.querySelector('.window-shell').classList.contains('sidebar-collapsed'),
      settingsOpen:document.querySelector('.window-shell').classList.contains('settings-open'),
      titleBrand:document.querySelector('.window-titlebar-brand, .window-titlebar-icon') !== null,
      width:innerWidth, height:innerHeight };
  })()`)
}
async function click(selector) {
  const point = await client.evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,reachable:el.contains(document.elementFromPoint(x,y))};})()`)
  assert(point.reachable, `${selector} is covered`)
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await delay(700)
}
async function shot(name) {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(root, `${name}.png`), Buffer.from(data, 'base64'))
}
try {
  locator = await harness.waitForLocator(dataDir, child.pid)
  client = await harness.connectRenderer(debuggingPort)
  const target = await harness.waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${mainDebuggingPort}/json/list`).catch(() => null)
    return response?.ok ? (await response.json())[0] : null
  }, 30_000, 'main inspector')
  main = new CdpClient(target.webSocketDebuggerUrl)
  await main.evaluate(`globalThis.layoutElectron = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); globalThis.layoutWindow = layoutElectron.BrowserWindow.getAllWindows()[0]; true`)
  await harness.desktopAction(locator, 'park-offscreen')
  await harness.waitFor(async () => (await state()).layout === 'chali', 30_000, 'initial Chali')
  await delay(700)
  await click('.workspace-panel-corner-toggle')
  for (const [name, maximized] of [['chali', false], ['beta', true], ['restored', false]]) {
    await harness.desktopAction(locator, 'maximize', { maximized })
    await harness.waitFor(async () => (await state()).layout === (maximized ? 'beta' : 'chali'), 10_000, name)
    await delay(600)
    const s = await state()
    assert.equal(s.titleBrand, false)
    assert.equal(s.sidebar.y, maximized ? 32 : 0)
    assert.equal(s.core.y, 32)
    assert.equal(s.title.x, maximized ? 0 : s.core.x)
    assert.equal(s.sidebar.x, 0)
    assert.equal(s.sidebar.y + s.sidebar.height, s.height)
    assert.equal(s.core.radius, maximized ? '12px' : '0px')
    await shot(name)
    await click('.sidebar-toggle-btn')
    assert.equal((await state()).collapsed, true)
    assert.equal((await state()).title.x, 0)
    await click('.sidebar-toggle-btn')
    await click('.settings-entry-btn')
    const settings = await state()
    assert(settings.settingsOpen)
    assert.equal(settings.settings.y, maximized ? 32 : 0)
    await click('.settings-entry-btn')
    await client.send('Page.reload')
    await harness.waitFor(async () => (await state()).layout === (maximized ? 'beta' : 'chali'), 20_000, 'reload layout')
    await delay(700)
    results.push({ name, ...s, settings, controls: 'passed', reload: 'passed' })
  }
  // Native fullscreen uses the same layout facts as maximize.
  await main.evaluate('layoutWindow.setFullScreen(true); true')
  await harness.waitFor(async () => (await state()).layout === 'beta', 10_000, 'fullscreen Beta')
  await main.evaluate('layoutWindow.setFullScreen(false); true')
  await harness.waitFor(async () => (await state()).layout === 'chali', 10_000, 'fullscreen restore')
  results.push({ name: 'fullscreen-and-restore', status: 'passed' })

  if (process.argv.includes('--desktop-backdrop')) {
    // A known test window behind LS proves cross-window compositing. Capture only
    // the LS rectangle; no other desktop contents are saved in the artifacts.
    await main.evaluate(`(() => {
      const {BrowserWindow,screen}=layoutElectron; const area=screen.getPrimaryDisplay().workArea;
      globalThis.layoutBackdrop=new BrowserWindow({ ...area, frame:false, show:false, backgroundColor:'#ff2020', skipTaskbar:true });
      layoutBackdrop.showInactive(); layoutWindow.setBounds({x:area.x+50,y:area.y+50,width:1100,height:720});
      layoutWindow.show(); layoutWindow.focus(); return true;
    })()`)
    for (const maximized of [false, true]) {
      await harness.desktopAction(locator, 'maximize', { maximized })
      await delay(800)
      const frames = []
      for (const [label, color] of [['red', '#ff2020'], ['blue', '#2020ff']]) {
        await main.evaluate(`layoutBackdrop.setBackgroundColor('${color}'); layoutWindow.focus(); true`)
        await delay(1000)
        const capture = await main.evaluate(`(async () => {
          const display=layoutElectron.screen.getDisplayMatching(layoutWindow.getBounds());
          const scale=display.scaleFactor;
          const sources=await layoutElectron.desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.size.width*scale),height:Math.round(display.size.height*scale)}});
          const source=sources.find(s=>s.display_id===String(display.id));
          const b=layoutWindow.getContentBounds();
          const crop={x:Math.round((b.x-display.bounds.x)*scale),y:Math.round((b.y-display.bounds.y)*scale),width:Math.round(b.width*scale),height:Math.round(b.height*scale)};
          const image=source.thumbnail.crop(crop);
          const mean=(x,y)=>{ const bitmap=image.crop({x:Math.round(x*scale),y:Math.round(y*scale),width:12,height:12}).toBitmap(); const rgb=[0,0,0]; for(let i=0;i<bitmap.length;i+=4){rgb[0]+=bitmap[i+2];rgb[1]+=bitmap[i+1];rgb[2]+=bitmap[i];}return rgb.map(v=>v/(bitmap.length/4));};
          return {png:image.toPNG().toString('base64'), sidebar:mean(18,380), title:mean(650,16), chat:mean(500,380), joinAbove:mean(180,22), joinBelow:mean(180,34), focused:layoutWindow.isFocused()};
        })()`)
        await writeFile(join(root, `${maximized ? 'beta' : 'chali'}-desktop-${label}.png`), Buffer.from(capture.png, 'base64'))
        delete capture.png
        frames.push(capture)
      }
      const delta = key => Math.max(...frames[0][key].map((v,i)=>Math.abs(v-frames[1][key][i])))
      const proof = { name: maximized ? 'beta-backdrop' : 'chali-backdrop', frames, sidebarDelta:delta('sidebar'), titleDelta:delta('title'), chatDelta:delta('chat') }
      results.push(proof)
      assert(proof.sidebarDelta > 8, 'sidebar must respond to the window behind LS')
      assert(proof.chatDelta < 3, 'chat must remain opaque')
      assert(maximized ? proof.titleDelta > 8 : proof.titleDelta < 3, 'only Beta titlebar exposes the desktop backdrop')
      if (maximized) for (const frame of frames) {
        assert(Math.max(...frame.joinAbove.map((v, i) => Math.abs(v - frame.joinBelow[i]))) < 8, 'Beta titlebar/sidebar material must have no seam')
      }
    }
  }
  console.log(JSON.stringify({ root, results, status:'passed' }, null, 2))
} finally {
  await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2))
  await main?.evaluate('if(globalThis.layoutBackdrop) layoutBackdrop.destroy(); true').catch(() => {})
  client?.close(); main?.close()
  if (locator) await harness.desktopAction(locator, 'quit').catch(() => {})
  if (child.exitCode === null) {
    await harness.waitForExit(child, 10_000).catch(() => child.kill())
  }
  console.log(`Evidence: ${root}`)
}
