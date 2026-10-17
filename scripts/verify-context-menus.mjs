// Isolated real Electron: object menus, native editing, focus and safe tab closing.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider, LONG_MARKDOWN_END } from './lib/electron-acceptance-provider.mjs'

const h = createElectronHarness({ startTimeoutMs: 90_000 })
const root = await mkdtemp(join(tmpdir(), 'ls-context-menu-'))
const out = resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice(6) || root)
const dataDir = join(root, 'data'), workspace = join(dataDir, 'workplace')
const projectPath = join(root, 'project')
const report = { ok: false, checks: [], screenshots: [], isolatedData: true, clipboardRestored: false }
let child, client, main, locator, provider
const evaluate = expression => client.evaluate(expression)
const wait = (expression, label) => h.waitFor(() => evaluate(`Boolean(${expression})`), 30_000, label)
function check(value, label) { assert(value, label); report.checks.push(label) }
async function point(selector) {
  return evaluate(`(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));if(!e)throw Error('Missing visible '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.left+Math.min(18,r.width/2),y:r.top+Math.min(16,r.height/2)}})()`)
}
async function click(selector, button = 'left') {
  const p = await point(selector)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button, buttons: button === 'right' ? 2 : 1, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button, buttons: 0, clickCount: 1 })
  await delay(100)
}
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
}
const escape = () => key('Escape', 'Escape', 27)
async function menu(selector) {
  await click(selector, 'right')
  await wait("document.querySelector('.app-context-menu')", 'right-click menu')
  const state = await evaluate(`(() => {const e=document.querySelector('.app-context-menu');const r=e.getBoundingClientRect();return {labels:[...e.querySelectorAll('button')].map(b=>b.textContent.trim()),inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}})()`)
  check(state.inside, 'menu stays inside the viewport')
  return state.labels
}
async function select(label) {
  await evaluate(`(() => {const b=[...document.querySelectorAll('.app-context-menu button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing menu action '+${JSON.stringify(label)});b.dataset.contextTestAction='true'})()`)
  await click('[data-context-test-action="true"]')
  await wait("!document.querySelector('.app-context-menu')", 'menu action closes the menu')
}
async function screenshot(name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(out, `${name}.png`), Buffer.from(shot.data, 'base64'))
  report.screenshots.push(`${name}.png`)
}
async function checkBorderlessMenu(theme) {
  await key('ArrowDown', 'ArrowDown', 40)
  await delay(100)
  const style = await evaluate(`(() => {
    const menu=document.querySelector('.app-context-menu');
    const focused=document.activeElement;
    const borderless=e=>{const s=getComputedStyle(e);return ['Top','Right','Bottom','Left'].every(side=>parseFloat(s['border'+side+'Width'])===0)};
    const s=getComputedStyle(focused);
    return {borderless:borderless(menu)&&[...menu.querySelectorAll('button')].every(borderless),
      focus:menu.contains(focused)&&focused.matches(':focus-visible')&&(s.outlineStyle==='none'||parseFloat(s.outlineWidth)===0)&&s.boxShadow==='none',
      fill:s.backgroundColor!=='rgba(0, 0, 0, 0)'&&s.backgroundColor!=='transparent'&&s.backgroundColor!==getComputedStyle(menu).backgroundColor,
      focused:focused.outerHTML,visible:focused.matches(':focus-visible'),outline:s.outline,shadow:s.boxShadow,background:s.backgroundColor,menuBackground:getComputedStyle(menu).backgroundColor};
  })()`)
  check(style.borderless, `${theme} menu and options have no borders`)
  assert(style.focus && style.fill, `${theme} focus style: ${JSON.stringify(style)}`)
  report.checks.push(`${theme} keyboard focus uses a visible fill without a stroke`)
}
const readClipboard = () => main.evaluate('contextElectron.clipboard.readText()')
const writeClipboard = text => main.evaluate(`contextElectron.clipboard.writeText(${JSON.stringify(text)}).then(()=>true)`)
try {
  await h.assertBuildFresh()
  await mkdir(workspace, { recursive: true }); await mkdir(out, { recursive: true })
  await mkdir(projectPath, { recursive: true })
  await writeFile(join(workspace, 'README.md'), '# Right-click fixture\n\nA local document.\n')
  await writeFile(join(workspace, 'fixture.ts'), 'export const contextMenu = true\n')
  provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 1, streamChunkCharacters: 500 })
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1, providers: [{ id: 'acceptance', name: 'Local fixture', baseURL: provider.baseURL, apiKey: 'fixture', models: ['slow-a'] }], agents: { defaults: { workspace, model: 'acceptance/slow-a' } } }))
  const debuggingPort = await h.reservePort(), mainDebuggingPort = await h.reservePort()
  child = await h.startElectron({ dataDir, chromiumDir: join(root, 'chromium'), debuggingPort, mainDebuggingPort, logPath: join(root, 'electron.log') })
  locator = await h.waitForLocator(dataDir, child.pid)
  main = await h.connectDebugger(mainDebuggingPort, 'main inspector')
  await main.evaluate(`(async()=>{globalThis.contextElectron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');const items=await contextElectron.clipboard.read();globalThis.contextClipboard=await Promise.all(items.map(async item=>{const data={};for(const type of item.types)data[type]=await item.getType(type);return new contextElectron.ClipboardItem(data)}));contextElectron.nativeTheme.themeSource='dark';return true})()`)
  const registered = await h.fetchJson(locator, '/projects/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: projectPath }) })
  assert(registered.ok)
  client = await h.connectRenderer(debuggingPort)
  await client.send('Page.reload')
  await delay(500)
  client.close(); client = await h.connectRenderer(debuggingPort)
  await client.send('Runtime.enable')
  await evaluate(`window.contextMenuProbe=[];window.littlesheep.onContextMenu(m=>contextMenuProbe.push({type:'native',items:m.items.map(i=>i.id)}));for(const type of ['focusout','focusin','scroll'])window.addEventListener(type,e=>contextMenuProbe.push({type,target:e.target?.className??e.target?.nodeName,related:e.relatedTarget?.className}),true)`)
  await h.desktopAction(locator, 'resize', { width: 1440, height: 900 })
  await h.desktopAction(locator, 'show')
  await wait("document.querySelector('.composer textarea')", 'composer ready')
  await h.waitFor(async () => (await h.fetchJson(locator, '/runtime/readiness')).body?.state === 'ready', 60_000, 'runtime ready')

  await click('.composer textarea')
  await client.send('Input.insertText', { text: '原生右键编辑' })
  check((await menu('.composer textarea')).includes('撤销Ctrl+Z'), 'input offers native undo')
  await select('撤销Ctrl+Z')
  await wait("document.querySelector('.composer textarea').value===''")
  await menu('.composer textarea'); await select('重做Ctrl+Y')
  await wait("document.querySelector('.composer textarea').value==='原生右键编辑'")
  report.checks.push('native undo and redo preserve editing history')
  await evaluate("document.querySelector('.composer textarea').select()")
  await menu('.composer textarea'); await select('复制Ctrl+C')
  check(await readClipboard() === '原生右键编辑', 'copy uses the original input selection')
  await writeClipboard('粘贴验收')
  await menu('.composer textarea'); await select('粘贴Ctrl+V')
  await wait("document.querySelector('.composer textarea').value==='粘贴验收'")
  report.checks.push('paste replaces the original selection')
  await menu('.composer textarea'); await key('z', 'KeyZ', 90, 2)
  await wait("document.querySelector('.composer textarea').value==='原生右键编辑'", 'undo shortcut while a menu is open')
  await menu('.composer textarea'); await key('y', 'KeyY', 89, 2)
  await wait("document.querySelector('.composer textarea').value==='粘贴验收'", 'redo shortcut while a menu is open')
  report.checks.push('edit shortcuts still target the input while its menu is open')
  await menu('.composer textarea'); await checkBorderlessMenu('dark'); await screenshot('input-menu')
  await evaluate("document.querySelector('.app-context-menu').style.maxHeight='120px';document.querySelector('.app-context-menu').scrollTop=500")
  await delay(100)
  check(await evaluate("!!document.querySelector('.app-context-menu')"), 'scrolling within an overflowing menu does not dismiss it')
  await escape()
  check(await evaluate("document.activeElement===document.querySelector('.composer textarea')"), 'Escape restores editing focus')
  await menu('.composer textarea'); await click('.brand-title')
  check(await evaluate("!document.querySelector('.app-context-menu')"), 'outside click dismisses the menu')
  await click('.composer textarea'); await key('a', 'KeyA', 65, 2)
  await client.send('Input.insertText', { text: '请输出验收文档：MARKDOWN-LONG-FIXTURE' })
  await key('Enter', 'Enter', 13)
  await wait(`document.querySelector('.messages')?.textContent.includes(${JSON.stringify(LONG_MARKDOWN_END)})`, 'fixture reply')
  await wait("document.querySelector('.session-item:not(.project-item)')", 'session row')
  await click('.sidebar-nav-button[aria-label="新对话"]')

  let labels = await menu('.session-item:not(.project-item)')
  check(labels.some(x => x.includes('置顶')) && labels.includes('重命名') && labels.includes('归档对话') && labels.includes('删除对话'), 'session menu exposes existing management actions')
  check(await evaluate("!document.querySelector('.messages .message')"), 'right-clicking an inactive session does not open it')
  await screenshot('session-menu')
  await select('重命名')
  await wait("document.querySelector('.session-rename-input')", 'inline rename')
  await menu('.session-rename-input')
  check(await evaluate("!!document.querySelector('.session-rename-input')"), 'native edit menu does not commit inline rename')
  await escape(); await escape()
  await menu('.session-item:not(.project-item)'); await select('删除对话')
  await wait("document.querySelector('[role=\"alertdialog\"]')", 'deletion confirmation')
  check(await evaluate("!!document.querySelector('.session-item:not(.project-item)')"), 'right-click deletion still requires confirmation')
  await escape()
  await evaluate(`window.contextOriginalFetch=window.fetch;window.contextDeleteCalls=0;window.fetch=async(input,init)=>{if(init?.method==='DELETE'&&String(input).includes('/sessions/')&&String(input).includes('hard=1')){contextDeleteCalls++;await new Promise(r=>setTimeout(r,150));return new Response(JSON.stringify({error:'Context-menu deletion failure fixture'}),{status:503,headers:{'Content-Type':'application/json'}})}return contextOriginalFetch(input,init)}`)
  await menu('.session-item:not(.project-item)'); await select('删除对话')
  await wait("document.querySelector('.danger-confirm-dialog .danger-btn')", 'delete confirmation')
  await evaluate("document.querySelector('.danger-confirm-dialog .danger-btn').click();document.querySelector('.danger-confirm-dialog .danger-btn').click()")
  await wait("document.querySelector('.danger-confirm-dialog .dialog-error')", 'failed delete is visible')
  check(await evaluate("window.contextDeleteCalls===1&&!!document.querySelector('.session-item:not(.project-item)')"), 'failed delete preserves the row and duplicate confirmation sends only once')
  await screenshot('delete-failure'); await escape()
  await evaluate('window.fetch=window.contextOriginalFetch;delete window.contextOriginalFetch')
  await click('.session-item:not(.project-item)')
  await wait("document.querySelector('.message.assistant')", 'return to the original conversation')

  labels = await menu('.project-row-trigger')
  check(labels.includes('新建对话') && labels.includes('复制项目路径') && labels.includes('删除项目'), 'project menu exposes creation and management')
  await screenshot('project-menu')
  await select('复制项目路径')
  check((await readClipboard()).replaceAll('\\','/') === projectPath.replaceAll('\\','/'), 'project path copy targets the clicked project')
  await h.desktopAction(locator, 'resize', { width: 800, height: 600 })
  await evaluate("document.documentElement.dataset.lsTheme='light'")
  await delay(400)
  await menu('.project-row-trigger'); await checkBorderlessMenu('light narrow'); await screenshot('project-menu-light-narrow'); await escape()
  await evaluate("document.documentElement.dataset.lsTheme='dark'")
  await h.desktopAction(locator, 'resize', { width: 1440, height: 900 })
  await delay(400)
  await menu('.project-row-trigger'); await select('删除项目')
  await wait("document.querySelector('.danger-confirm-dialog')", 'project confirmation')
  check(await evaluate("document.querySelector('.danger-confirm-dialog').textContent.includes('不会删除磁盘上的项目文件夹')&&!!document.querySelector('.project-row-trigger')"), 'project confirmation names the real scope and preserves the project until confirmed')
  await escape()

  await evaluate("document.querySelector('.messages').scrollTop=0;getSelection().removeAllRanges()")
  labels = await menu('.message.assistant .markdown p')
  check(labels.includes('复制消息') && labels.includes('从这里分叉对话'), 'assistant message offers copy and branch')
  await screenshot('message-menu'); await select('复制消息')
  check((await readClipboard()).includes(LONG_MARKDOWN_END), 'message copy includes the complete answer')
  const selected = await evaluate("(() => {const e=document.querySelector('.message.assistant .markdown p');const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);return s.toString()})()")
  labels = await menu('.message.assistant .markdown p')
  check(labels.includes('复制选中文字Ctrl+C') && !labels.includes('复制消息'), 'selection retains its native menu')
  await select('复制选中文字Ctrl+C'); check(await readClipboard() === selected, 'native selection copy preserves selected text')
  await evaluate('getSelection().removeAllRanges()')
  labels = await menu('.message.assistant .markdown a[href]')
  check(labels.includes('复制链接地址'), 'links retain link-specific actions')
  await escape()

  await evaluate("document.querySelector('button[aria-label=\"打开拓展工作区\"]')?.click()")
  await evaluate("[...document.querySelectorAll('.workspace-empty-launcher-item')].find(e=>e.textContent.includes('工作区文件'))?.click()")
  await delay(650)
  await wait("document.querySelector('.workspace-tree-row.file')?.getBoundingClientRect().width>20", 'file tree')
  labels = await menu('.workspace-tree-row.file')
  check(labels.includes('在应用内预览') && labels.includes('复制相对路径'), 'file tree retains file actions')
  await select('在应用内预览')
  await wait("document.querySelector('[data-workspace-tab-kind=\"file\"]')", 'file tab')
  labels = await menu('[data-workspace-tab-kind="file"]')
  check(labels.includes('关闭标签') && labels.includes('关闭其他标签') && labels.includes('关闭右侧标签') && labels.includes('复制完整路径'), 'workspace tabs expose closing and path actions')
  await screenshot('tab-menu'); await escape()
  await key('F10', 'F10', 121, 8)
  await wait("document.querySelector('.app-context-menu')", 'keyboard context-menu trigger')
  await key('End', 'End', 35)
  check(await evaluate("document.activeElement.textContent==='复制完整路径'"), 'End navigates to the last enabled option')
  await key('Home', 'Home', 36)
  check(await evaluate("document.activeElement.textContent==='关闭标签'"), 'Home navigates to the first enabled option')
  await escape()

  // The batch uses the same save approval and stops at the first refusal.
  const dirtyName = await evaluate("document.querySelector('.workspace-active-item.active .workspace-active-label-text').textContent.trim()")
  const diskBefore = await readFile(join(workspace, dirtyName), 'utf8')
  await evaluate("[...document.querySelectorAll('.workspace-preview-pane button')].find(e=>e.textContent.trim()==='编辑').click()")
  await wait("document.querySelector('.workspace-tab-view.active .monaco-editor:not(.workspace-monaco-readonly) .view-line')", 'editable file')
  await click('.workspace-tab-view.active .monaco-editor .view-line')
  // Monaco uses EditContext; its hidden IME textarea is deliberately read-only.
  for (const character of 'CONTEXT_MENU_DIRTY') {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character, unmodifiedText: character })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character })
  }
  await wait("document.querySelector('.workspace-active-item.file-dirty')", 'unsaved file draft')
  const otherName = await evaluate(`(() => {const row=[...document.querySelectorAll('.workspace-tree-row.file')].find(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&e.querySelector('.workspace-tree-name').textContent.trim()!==${JSON.stringify(dirtyName)});if(!row)throw Error('Missing visible second file');row.dataset.contextOtherFile='true';return row.querySelector('.workspace-tree-name').textContent.trim()})()`)
  await click('[data-context-other-file="true"]')
  await wait(`document.querySelector('.workspace-active-item.active .workspace-active-label-text')?.textContent.trim()===${JSON.stringify(otherName)}`, 'second file opens without discarding the first draft')
  await menu('.workspace-active-item.file-dirty')
  check(await evaluate(`document.querySelector('.workspace-active-item.active .workspace-active-label-text')?.textContent.trim()===${JSON.stringify(otherName)}`), 'right-clicking an inactive tab does not activate it')
  await select('关闭全部标签')
  await wait("document.querySelector('.approval-prompt')", 'save approval before closing')
  await click('.approval-action:not(.session):not(.primary)')
  await wait("document.querySelector('.workspace-file-close-refusal')", 'refused save keeps the file')
  check(await evaluate("!!document.querySelector('.workspace-active-item.file-dirty')"), 'refused batch close preserves the unsaved draft')
  check(await evaluate(`[...document.querySelectorAll('.workspace-active-label-text')].some(e=>e.textContent.trim()===${JSON.stringify(otherName)})`), 'batch stops before closing tabs after the refused file')
  check(await readFile(join(workspace, dirtyName), 'utf8') === diskBefore, 'refusing save leaves the disk file unchanged')
  await screenshot('close-refused')

  await evaluate("document.querySelector('button[aria-label=\"设置\"]').click()")
  await wait("document.querySelector('.settings-nav-item')", 'settings')
  await evaluate("[...document.querySelectorAll('.settings-nav-item')].find(e=>e.textContent.trim()==='模型供应商').click()")
  await wait("document.querySelector('.provider-add')", 'provider page')
  await evaluate("document.querySelector('.provider-add').click()")
  await wait("[...document.querySelectorAll('.provider-add')].some(e=>e.textContent.includes('自定义接口'))", 'provider templates')
  await evaluate("[...document.querySelectorAll('.provider-add')].find(e=>e.textContent.includes('自定义接口')).click()")
  await wait("document.querySelector('.provider-editor input')", 'provider dialog')
  await menu('.provider-editor input'); await escape()
  check(await evaluate("!!document.querySelector('.provider-editor')&&!document.querySelector('.app-context-menu')"), 'one Escape dismisses only the menu above a dialog')
  await escape()
  await evaluate("document.querySelector('button[aria-label=\"退出设置页\"]').click()")
  await delay(650)
  await click('.workspace-add-trigger')
  await wait("document.querySelector('.workspace-add-panel.visible .workspace-terminal-shell-picker .split-button-primary:not(:disabled)')", 'terminal shell entry')
  await click('.workspace-add-panel.visible .workspace-terminal-shell-picker .split-button-primary')
  await wait("document.querySelector('.workspace-terminal .xterm-screen')", 'terminal surface')
  await wait("document.querySelector('.workspace-terminal')?.dataset.terminalStatus==='ready'", 'terminal output ready')
  labels = await menu('.workspace-terminal .xterm-screen')
  check(labels.includes('复制选中文字')&&labels.includes('粘贴')&&labels.includes('全选'), 'terminal has its own copy, paste and selection menu')
  await screenshot('terminal-menu')
  await select('全选')
  labels = await menu('.workspace-terminal .xterm-screen')
  check(await evaluate("![...document.querySelectorAll('.app-context-menu button')].find(e=>e.textContent==='复制选中文字').disabled"), 'terminal copy reads the xterm selection')
  await select('复制选中文字')
  check((await readClipboard()).length>0, 'terminal selection copy reaches the clipboard')
  await writeClipboard('CONTEXT_MENU_PASTE_WITHOUT_ENTER')
  await menu('.workspace-terminal .xterm-screen'); await select('粘贴')
  await wait("document.querySelector('.workspace-terminal').textContent.includes('CONTEXT_MENU_PASTE_WITHOUT_ENTER')", 'terminal paste enters text without submitting a command')
  report.checks.push('terminal paste uses the active terminal input')
  check(!client.events.some(e=>e.method==='Runtime.exceptionThrown'), 'no uncaught Renderer exception')
  report.ok = true
} catch (error) {
  report.error = String(error)
  if (client) {
    report.failure = await evaluate(`({active:document.activeElement?.outerHTML?.slice(0,300),menu:document.querySelector('.app-context-menu')?.textContent,rename:!!document.querySelector('.session-rename-input'),terminalStatus:document.querySelector('.workspace-terminal')?.dataset.terminalStatus,events:window.contextMenuProbe?.slice(-30)})`).catch(()=>null)
    await screenshot('failure').catch(()=>{})
  }
  throw error
} finally {
  if (main) {
    report.clipboardRestored = await main.evaluate('(async()=>{if(!globalThis.contextClipboard)return false;if(contextClipboard.length)await contextElectron.clipboard.write(contextClipboard);else contextElectron.clipboard.clear();delete globalThis.contextClipboard;return true})()').catch(error => { report.clipboardRestoreError = String(error); return false })
  }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2))
  client?.close(); main?.close()
  if (locator && child?.exitCode === null) { await h.desktopAction(locator, 'quit').catch(()=>{}); await h.waitForExit(child, 10_000).catch(()=>{}) }
  if (child?.exitCode === null) await h.forceTerminate(child)
  await provider?.close()
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, out, clipboardRestored: report.clipboardRestored }))
}
