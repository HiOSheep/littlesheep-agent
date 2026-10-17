// Real Renderer acceptance using isolated data and the local deterministic provider.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { LONG_MARKDOWN_MARKER, startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness()
const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 20, streamChunkCharacters: 60 })
const root = await mkdtemp(join(tmpdir(), 'littlesheep-chat-layout-'))
const outRoot = resolve(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? join(tmpdir(), 'littlesheep-chat-reading-layout'))
const dataDir = join(root, 'data')
const workspace = join(dataDir, 'projects', 'long-workspace-name-for-composer-layout')
const report = { checks: [], measurements: {}, screenshots: [] }
let child, client
const record = (name) => { report.checks.push(name); console.log(`PASS ${name}`) }
const evaluate = (source) => client.evaluate(source)
async function wait(source, label) {
  return harness.waitFor(() => evaluate(source), 60_000, label)
}
async function draft(text) {
  await evaluate(`(() => { const input = document.querySelector('.composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await delay(50)
}
async function submit(text) {
  const before = await evaluate("document.querySelectorAll('.assistant-turn').length")
  await draft(text)
  await evaluate("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))")
  await wait(`document.querySelectorAll('.assistant-turn').length > ${before} || null`, 'new turn')
}
async function settled() {
  await wait("document.querySelector('.assistant-turn:last-child .assistant-response-stream[data-stream-state=\"settled\"]') ? true : null", 'settled response')
  await delay(300)
}
async function screenshot(name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await mkdir(outRoot, { recursive: true })
  const path = join(outRoot, `${name}.png`)
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  report.screenshots.push(path)
}
const geometry = `(() => {
  const rect = (selector) => { const el=document.querySelector(selector); if(!el)return null;const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height} };
  const messages=document.querySelector('.messages'); const textarea=document.querySelector('.composer textarea');
  return {header:rect('.chat-header'),messages:rect('.messages'),composer:rect('.composer'),shell:rect('.composer-shell'),chat:rect('.chat'),hint:rect('.empty-hint'),
    controls:rect('.composer-controls'),actions:rect('.composer-run-actions'),panel:rect('.chat-turn-panel'),
    overflow:messages.scrollWidth-messages.clientWidth,documentOverflow:document.documentElement.scrollWidth-innerWidth,
    textarea:(()=>{const r=textarea.getBoundingClientRect(),s=getComputedStyle(textarea);return {
      height:r.height,clientHeight:textarea.clientHeight,scrollHeight:textarea.scrollHeight,overflowY:s.overflowY,
      maxHeight:s.maxHeight,inlineHeight:textarea.style.height}})(),
    draft:textarea.value,gap:messages.scrollHeight-messages.clientHeight-messages.scrollTop,
    active:document.querySelector('.chat-turn-trigger')?.textContent};
})()`

try {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'fixture.txt'), 'layout acceptance')
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1,
    providers: [{ id: 'acceptance', name: 'Acceptance', baseURL: provider.baseURL, apiKey: 'acceptance-key',
      timeoutSeconds: 15, models: ['slow-a'] }],
    agents: { defaults: { workspace, model: 'acceptance/slow-a', harness: 'core-flow' } },
  }))
  const port = await harness.reservePort()
  child = await harness.startElectron({ dataDir, chromiumDir: join(root, 'chromium'), debuggingPort: port, logPath: join(root, 'electron.log') })
  const locator = await harness.waitForLocator(dataDir, child.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'resize', { width: 1280, height: 760 })
  await harness.desktopAction(locator, 'show')
  client = await harness.connectRenderer(port)
  await client.send('Page.bringToFront')
  await wait("document.querySelector('.composer textarea') ? true : null", 'composer')
  await harness.waitFor(async () => {
    const readiness = await harness.fetchJson(locator, '/runtime/readiness')
    return readiness?.body?.state === 'ready' ? true : null
  }, 60_000, 'runtime ready')
  const empty = await evaluate(geometry)
  assert(empty.messages.top >= empty.header.bottom - 1)
  assert(empty.composer.bottom <= empty.chat.bottom + 1)
  assert(Math.abs((empty.shell.top + empty.shell.bottom) / 2 - (empty.chat.top + empty.chat.bottom) / 2 - 24) <= 1)
  assert.equal(empty.header.height, 0)
  assert(empty.hint.bottom < empty.composer.top - 12, 'heading must sit above the input')
  assert(Math.abs((empty.hint.left + empty.hint.right) / 2 - (empty.composer.left + empty.composer.right) / 2) <= 1, 'heading and input must share a centre')
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.empty-copy')).display"), 'none')
  await screenshot('empty')
  report.measurements.themes = []
  const initialTheme = await evaluate("document.documentElement.getAttribute('data-ls-theme') || 'dark'")
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.setAttribute('data-ls-theme','${theme}')`)
    await delay(120)
    report.measurements.themes.push(await evaluate(`(() => ({theme:document.documentElement.getAttribute('data-ls-theme'),
      background:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      composerSurface:getComputedStyle(document.querySelector('.composer')).backgroundColor,
      text:getComputedStyle(document.querySelector('.composer textarea')).color}))()`))
    await screenshot(`empty-${theme}`)
  }
  await evaluate(`document.documentElement.setAttribute('data-ls-theme',${JSON.stringify(initialTheme)})`)

  const controlsGeometry = `(() => {
    const rect = e => {const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2}};
    const add=document.querySelector('.add-menu-trigger');
    const composer=document.querySelector('.composer'); const style=getComputedStyle(composer);
    const controls=document.querySelector('.composer-controls'); const controlStyle=getComputedStyle(controls);
    return {composer:rect(composer),computed:{height:style.height,minHeight:style.minHeight,maxHeight:style.maxHeight,
        paddingBlockStart:style.paddingBlockStart,paddingBlockEnd:style.paddingBlockEnd,gap:style.gap,
        flexDirection:style.flexDirection},controls:rect(controls),controlsComputed:{display:controlStyle.display,
        gap:controlStyle.gap,gridTemplateRows:controlStyle.gridTemplateRows},
      add:rect(add),glyph:rect(add.querySelector('svg')),fill:getComputedStyle(add).backgroundColor,
      controlsChildren:[...document.querySelector('.composer-controls').children].map(e=>{const s=getComputedStyle(e);return {
        className:e.className,text:e.innerText?.slice(0,100),...rect(e),
        computed:{display:s.display,position:s.position,height:s.height,minHeight:s.minHeight,maxWidth:s.maxWidth,
          flex:s.flex,flexWrap:s.flexWrap,gap:s.gap,lineHeight:s.lineHeight},html:e.outerHTML.slice(0,800)}}),
      buttons:[...document.querySelectorAll('.composer-controls button')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height&&!e.closest('[aria-hidden="true"]')).map(rect)};
  })()`
  await client.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:1,y:1})
  const originalChatStyle = await evaluate("document.querySelector('.chat').getAttribute('style')")
  report.measurements.composerWidths = []
  for (const width of [700, 560, 480, 430, 360, 320]) {
    await evaluate(`Object.assign(document.querySelector('.chat').style,{width:'${width}px',maxWidth:'${width}px',minWidth:'0'})`)
    await delay(250)
    const sample = await evaluate(controlsGeometry)
    report.measurements.composerWidths.push({width,...sample})
    if (width === 700 || width === 560) await screenshot(`composer-${width}`)
    // The existing chat-pane contract deliberately becomes a 2-row control grid
    // below 820px, tightens its row gap at 560px, then becomes a 3-row grid at
    // 390px. Composer height therefore changes with those real rows; require the
    // measured geometry for each breakpoint instead of a false one-height rule.
    const expectedControlsHeight = width <= 390 ? 106 : width <= 560 ? 70 : 74
    const expectedComposerHeight = 72 + expectedControlsHeight
    assert.equal(sample.controls.height, expectedControlsHeight,
      `composer control grid at ${width}px must match its ${width <= 390 ? 'three-row' : 'two-row'} responsive role`)
    assert.equal(Math.round(sample.composer.height * 10) / 10, expectedComposerHeight,
      `composer height at ${width}px must follow the measured responsive grid geometry`)
    assert(Math.abs(sample.add.cx-sample.glyph.cx)<=.5 && Math.abs(sample.add.cy-sample.glyph.cy)<=.5, 'add glyph is not centered')
    assert.equal(sample.fill,'rgba(0, 0, 0, 0)')
    for (const button of sample.buttons) {
      assert(button.left>=sample.composer.left-1 && button.right<=sample.composer.right+1, `control overflow at ${width}px`)
      assert(button.top>=sample.controls.top-1 && button.bottom<=sample.controls.bottom+1, `control wrapped at ${width}px`)
    }
  }
  const dark560 = report.measurements.composerWidths.find((sample) => sample.width === 560)
  await evaluate(`Object.assign(document.querySelector('.chat').style,{width:'560px',maxWidth:'560px',minWidth:'0'})`)
  await evaluate("document.documentElement.setAttribute('data-ls-theme','light')")
  await delay(120)
  const light560 = await evaluate(controlsGeometry)
  assert.equal(light560.composer.height, dark560?.composer.height,
    `the 560px light theme keeps the measured composer geometry: ${JSON.stringify(light560)}`)
  assert.equal(light560.controls.height, dark560?.controls.height,
    `the 560px light theme keeps the measured control rows: ${JSON.stringify(light560)}`)
  report.measurements.composerThemes ??= []
  report.measurements.composerThemes.push({ width: 560, theme: 'light', ...light560 })
  await screenshot('composer-560-light')
  await evaluate(`document.documentElement.setAttribute('data-ls-theme',${JSON.stringify(initialTheme)})`)
  await evaluate(`Object.assign(document.querySelector('.chat').style,{width:'320px',maxWidth:'320px',minWidth:'0'})`)
  await delay(120)
  await screenshot('composer-320')
  await evaluate("document.documentElement.setAttribute('data-ls-theme','light')")
  await delay(120)
  await screenshot('composer-320-light')
  await evaluate(`document.documentElement.setAttribute('data-ls-theme',${JSON.stringify(initialTheme)})`)
  await draft('宽度变化时这一段草稿应该在现有输入区域内换行并滚动，不应撑高输入框。'.repeat(4))
  const beforeResize = await evaluate(geometry)
  await evaluate("Object.assign(document.querySelector('.chat').style,{width:'700px',maxWidth:'700px'})")
  await delay(250)
  const wideDraft = await evaluate(geometry)
  await evaluate("Object.assign(document.querySelector('.chat').style,{width:'320px',maxWidth:'320px'})")
  await delay(250)
  const wrappedDraft = await evaluate(geometry)
  const draftLayout = { beforeResize: Math.round(beforeResize.composer.height * 10) / 10,
    wide: Math.round(wideDraft.composer.height * 10) / 10,
    wrapped: Math.round(wrappedDraft.composer.height * 10) / 10,
    wideTextarea: wideDraft.textarea, narrowTextarea: wrappedDraft.textarea,
    textPreserved: wrappedDraft.draft === wideDraft.draft }
  report.measurements.draftResize = draftLayout
  assert(draftLayout.wide <= 334.4 && draftLayout.wrapped <= 334.4,
    `responsive draft layout stays within the viewport composer cap: ${JSON.stringify(draftLayout)}`)
  assert(draftLayout.narrowTextarea.height <= 220,
    `the 320px textarea stays within its 220px runtime input cap: ${JSON.stringify(draftLayout.narrowTextarea)}`)
  assert(draftLayout.narrowTextarea.scrollHeight > draftLayout.narrowTextarea.clientHeight
    && draftLayout.narrowTextarea.overflowY === 'auto',
  `the narrow multiline draft scrolls inside the capped textarea: ${JSON.stringify(draftLayout.narrowTextarea)}`)
  assert.equal(draftLayout.wrapped, draftLayout.beforeResize,
    `returning to 320px restores the same composer geometry: ${JSON.stringify(draftLayout)}`)
  assert.equal(wrappedDraft.draft,wideDraft.draft)
  await draft('')
  const addGeometry = (await evaluate(controlsGeometry)).add
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:addGeometry.cx,y:addGeometry.cy})
  await delay(150)
  assert.notEqual((await evaluate(controlsGeometry)).fill,'rgba(0, 0, 0, 0)')
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1})
  await delay(150)
  assert.equal((await evaluate(controlsGeometry)).fill,'rgba(0, 0, 0, 0)')
  await evaluate(`document.querySelector('.chat').setAttribute('style',${JSON.stringify(originalChatStyle ?? '')})`)
  await delay(250)
  record('composer follows its exact 700/560/390px grid breakpoints, caps and scrolls long drafts, and centers the add control')

  await evaluate(`(() => {
    window.composerMotionFrames = [];
    const sample = time => {
      const shell = document.querySelector('.composer-shell');
      const r = shell.getBoundingClientRect();
      window.composerMotionFrames.push({time, top:r.top, bottom:getComputedStyle(shell).bottom,
        empty:document.querySelector('.messages').classList.contains('is-empty')});
      if (!window.composerMotionFrames.some(frame => !frame.empty)
        || time-window.composerMotionFrames.find(frame => !frame.empty).time < 600) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })()`)
  await provider.setDelay({ promptContains: LONG_MARKDOWN_MARKER, delayMs: 1800 })
  await submit(`请输出验收文档：${LONG_MARKDOWN_MARKER}`)
  await wait("document.querySelector('.assistant-turn.running .assistant-process-label.is-running') ? true : null", 'bounded running state')
  assert.equal(await evaluate("document.querySelector('.assistant-turn.running .assistant-process-trigger').getAttribute('aria-expanded')"), 'false')
  assert(await evaluate("!!document.querySelector('.composer .stop:not(:disabled)')"))
  assert.equal(await evaluate("document.querySelector('.assistant-turn.running .assistant-process-trigger').disabled"), false)
  await screenshot('assistant-running')
  record('running turn shows its live label with the process folded and Stop reachable')
  await settled()
  await provider.setDelay({ promptContains: LONG_MARKDOWN_MARKER, delayMs: 0 })
  const motion = await evaluate('window.composerMotionFrames')
  const moving = motion.filter(frame => !frame.empty)
  assert(moving.length > 3, 'must sample multiple transition frames')
  assert(moving.every(frame => frame.bottom === '0px'), 'bottom must stay fixed during movement')
  for (let i=1;i<moving.length;i++) assert(moving[i].top >= moving[i-1].top-1, 'composer must not rebound upward')
  assert(moving.some((frame,i) => i && frame.top > moving[i-1].top+1), 'must observe animated movement')
  report.measurements.composerMotionFrames = motion
  record('centre-to-bottom animation keeps bottom fixed and moves without upward rebound')
  const first = await evaluate(geometry)
  assert(Math.abs(first.composer.bottom - first.chat.bottom) < 20)
  record('input settles at the bottom after sending the first message')
  await evaluate("(() => {const list=document.querySelector('.messages');list.scrollTop=list.scrollHeight-list.clientHeight-80})()")
  await delay(250)
  const glass = await evaluate(`(() => {
    const composer=document.querySelector('.composer'),list=document.querySelector('.messages');
    const bounds=composer.getBoundingClientRect(),styles=getComputedStyle(composer);
    const walker=document.createTreeWalker(document.querySelector('.messages-content'),NodeFilter.SHOW_TEXT);
    let linesBehind=0,node;
    while(node=walker.nextNode()) {
      if(!node.textContent.trim())continue;
      const range=document.createRange();range.selectNodeContents(node);
      for(const r of range.getClientRects()) if(r.top>=bounds.top&&r.bottom<=bounds.bottom&&r.left>=bounds.left&&r.right<=bounds.right)linesBehind++;
    }
    return {bottom:bounds.bottom,clipBottom:list.getBoundingClientRect().bottom,fill:styles.backgroundColor,blur:styles.backdropFilter,opacity:styles.opacity,linesBehind};
  })()`)
  assert(Math.abs(glass.clipBottom-glass.bottom)<=1)
  assert(glass.linesBehind>0, 'transcript must continue behind the composer glass')
  assert(glass.blur.includes('blur(20px)'))
  assert(/(?:\/\s*|,\s*)0\.7\s*\)/u.test(glass.fill), 'composer must have a translucent fill')
  assert.equal(glass.opacity,'1')
  report.measurements.composerGlass=glass
  await screenshot('composer-glass-scroll')
  record('transcript scrolls behind translucent input glass and clips at its bottom edge')
  await evaluate("document.querySelector('.messages').scrollTop=document.querySelector('.messages').scrollHeight")
  await delay(100)
  await submit('请使用 glob 工具列出当前工作区顶层条目')
  await settled()
  assert.equal(await evaluate("document.querySelector('.assistant-turn:last-child .assistant-process-trigger').getAttribute('aria-expanded')"), 'false')
  await evaluate("document.querySelector('.assistant-turn:last-child .assistant-process-trigger').click()")
  await delay(250)
  await wait("document.querySelector('.assistant-turn:last-child .agent-tool-row') ? true : null", 'recorded tool row')
  const toolRow = await evaluate("(() => {const e=document.querySelector('.assistant-turn:last-child .agent-tool-row');return {height:e.getBoundingClientRect().height, expanded:e.getAttribute('aria-expanded')}})()")
  assert.equal(toolRow.height, 24)
  assert.equal(toolRow.expanded, 'false')
  await evaluate("document.querySelector('.assistant-turn:last-child .agent-tool-row').click()")
  await delay(250)
  assert(await evaluate("!!document.querySelector('.assistant-turn:last-child .agent-tool-details-panel.open')"))
  await evaluate("document.querySelector('.assistant-turn:last-child .agent-tool-call').scrollIntoView({block:'start'})")
  await delay(250)
  await screenshot('dsh-tool-result')
  record('DSH completed process reopens its full history and a 24px tool row opens its result')
  await submit(`请再次输出验收文档：${LONG_MARKDOWN_MARKER}`)
  await settled()
  // Pointer motion must highlight controls without creating floating information boxes.
  for (const selector of ['.chat-header .running-pill', '.assistant-turn:last-child .message-meta-copy', '.assistant-turn:last-child .turn-usage-button']) {
    const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2} })()`)
    await client.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...point})
    await delay(650)
    assert(!(await evaluate("!!document.querySelector('.floating-help-tip.visible, .running-pill-panel, .turn-usage-panel')")))
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('title')`), null)
  }
  record('conversation hover creates no tooltip or details panel')
  await evaluate("document.querySelector('.assistant-turn:last-child .turn-usage-button').click()")
  await delay(100)
  assert(await evaluate("!!document.querySelector('.turn-usage-panel')"))
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  assert(!(await evaluate("!!document.querySelector('.turn-usage-panel')")))
  assert.equal(await evaluate("document.activeElement.className"), 'turn-usage-button')
  await evaluate("document.querySelector('.chat-title-records').click()")
  await delay(100)
  assert(await evaluate("!!document.querySelector('.running-pill-panel')"))
  // No drop shadow (asked for 2026-10-15): the panel's wide dark shadow read as a
  // halo around it against the dark transcript, so its glass fill alone marks the
  // float. The popover's own fill and blur stay.
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.running-pill-panel')).boxShadow"), 'none')
  assert.match(await evaluate("getComputedStyle(document.querySelector('.running-pill-panel')).backdropFilter"), /blur\(18px\)/u)
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  assert(!(await evaluate("!!document.querySelector('.running-pill-panel')")))
  record('usage and execution records open only on click and return focus on Escape')
  await evaluate("document.querySelector('.chat-header .running-pill').click()")
  await wait("document.querySelector('.running-pill-rename-input') ? true : null", 'inline title edit')
  await client.send('Input.insertText',{text:'长对话导航验收'})
  await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await wait("document.querySelector('.chat-header .running-pill-title')?.textContent === '长对话导航验收' ? true : null", 'renamed title')
  record('title single click edits and Enter saves the real session name')
  const railBox=await evaluate("(() => {const chat=document.querySelector('.chat').getBoundingClientRect(),rail=document.querySelector('.chat-turn-rail').getBoundingClientRect();return {left:rail.left-chat.left,width:rail.width}})()")
  assert(railBox.left>=0 && railBox.left<=8 && railBox.width<=36, 'rail belongs on the left edge of the chat')
  const mark=await evaluate("(() => {const r=document.querySelector('.chat-turn-trigger').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()")
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:mark.x,y:mark.y})
  await delay(180)
  assert(await evaluate("!!document.querySelector('.chat-turn-panel')"))
  assert(!(await evaluate("!!document.querySelector('.chat-turn-search')")), 'hover shows a compact preview')
  await screenshot('left-rail-hover')
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1})
  await delay(200)
  assert(!(await evaluate("!!document.querySelector('.chat-turn-panel')")))
  record('left marks reveal nearby turns on hover and dismiss after the pointer leaves')
  await screenshot('conversation')
  await evaluate("document.querySelector('.chat-turn-trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))")
  await delay(120)
  await screenshot('directory')
  await evaluate("document.querySelector('.chat-turn-heading button').click()")

  await evaluate("document.querySelector('.chat-turn-trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))")
  await delay(120)
  assert.equal(await evaluate("document.querySelectorAll('.chat-turn-entry').length"), 3)
  assert.equal(await evaluate("document.activeElement.className"), 'chat-turn-search')
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))")
  assert.equal(await evaluate("document.activeElement.className"), 'chat-turn-entry')
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));document.activeElement.click()")
  await delay(300)
  assert(!(await evaluate("!!document.querySelector('.chat-turn-panel')")))
  assert((await evaluate(geometry)).gap > 100)
  assert(await evaluate("!!document.querySelector('.chat-jump-to-latest')"))
  // The droplet floats on the float/menu glass (translucent fill + a real 18px blur) and
  // answers the pointer with a colour change instead of dropping its fill away, which used
  // to leave it looking transparent (asked for 2026-10-15).
  const jumpRest = await evaluate(`(() => {const s=getComputedStyle(document.querySelector('.chat-jump-to-latest'));return {background:s.backgroundColor,blur:s.backdropFilter,color:s.color}})()`)
  assert.match(jumpRest.blur, /blur\(18px\)/u, `jump droplet must blur the transcript, received ${jumpRest.blur}`)
  assert.match(jumpRest.background, /rgba\([^)]*,\s*0\./u, `jump droplet fill must stay translucent, received ${jumpRest.background}`)
  const jumpBox = await evaluate("(() => {const r=document.querySelector('.chat-jump-to-latest').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()")
  await client.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...jumpBox})
  await delay(260)
  const jumpHover = await evaluate(`(() => {const e=document.querySelector('.chat-jump-to-latest');const s=getComputedStyle(e);return {background:s.backgroundColor,color:s.color,hover:e.matches(':hover')}})()`)
  assert.equal(jumpHover.hover, true, 'the droplet must accept the pointer')
  assert.notEqual(jumpHover.background, jumpRest.background, 'hover must change the droplet glass colour')
  assert.notEqual(jumpHover.color, jumpRest.color, 'hover must change the arrow colour')
  await client.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:1, y:1})
  await delay(120)
  record('reach-latest droplet keeps its glass and changes colour under the pointer')
  record('directory groups turns, moves with keyboard and jumps into the real transcript')
  await evaluate("document.querySelector('.chat-turn-trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))")
  await delay(80)
  await evaluate("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(document.querySelector('.chat-turn-search'),'没有匹配的内容');document.querySelector('.chat-turn-search').dispatchEvent(new Event('input',{bubbles:true}))")
  await delay(80)
  assert.equal(await evaluate("document.querySelectorAll('.chat-turn-entry').length"), 0)
  assert(await evaluate("!!document.querySelector('.chat-turn-empty')"))
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  assert.equal(await evaluate("document.activeElement.className"), 'chat-turn-trigger')
  record('search has an empty state and Escape returns focus')

  const longDraft = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行待发送内容，改变窗口宽度后也应保留。`).join('\n')
  await draft(longDraft)
  await harness.desktopAction(locator, 'resize', { width: 800, height: 660 })
  await delay(700)
  const narrow = await evaluate(geometry)
  assert.equal(narrow.draft, longDraft)
  assert(narrow.overflow <= 1 && narrow.documentOverflow <= 1)
  assert(narrow.actions.left >= narrow.composer.left && narrow.actions.right <= narrow.composer.right + 1)
  assert(narrow.composer.top > narrow.header.bottom)
  assert(Math.abs(narrow.messages.bottom-narrow.composer.bottom)<=1)
  assert(narrow.messages.height >= 80)
  await screenshot('narrow-draft')
  // Open the real split workspace to exercise a chat column below the responsive threshold.
  await evaluate("document.querySelector('button[aria-label=\"打开拓展工作区\"]')?.click()")
  await delay(700)
  const split = await evaluate(geometry)
  assert.equal(split.draft, longDraft)
  assert(split.overflow <= 1 && split.documentOverflow <= 1)
  assert(split.actions.right <= split.composer.right + 1 && split.actions.left >= split.composer.left)
  assert(split.actions.bottom <= split.composer.bottom - 7, 'wrapped controls must retain the input surface bottom padding')
  assert(Math.abs(split.messages.bottom-split.composer.bottom)<=1)
  await screenshot('split-draft')
  report.measurements.split = split
  report.measurements = { ...report.measurements, empty, first, narrow }
  record('narrow window retains a multiline draft, bounds the controls and keeps a reading area')
  await draft('')
  await evaluate("document.querySelector('.chat-jump-to-latest')?.click()")
  await delay(300)
  await submit('请简短确认这条消息。')
  await settled()
  await provider.setFaults([{ kind: 'status', status: 401, times: 40 }])
  await submit('检查失败状态的操作入口')
  await wait("document.querySelector('.assistant-turn.failed .assistant-turn-retry') ? true : null", 'failed turn retry')
  assert(await evaluate("!!document.querySelector('.assistant-turn.failed [data-transcript-attention=\"true\"]')"))
  await evaluate("document.querySelector('.assistant-turn.failed .assistant-process-trigger').click()")
  await delay(200)
  assert(await evaluate("document.querySelector('.assistant-turn.failed .assistant-turn-retry').getBoundingClientRect().height >= 24"))
  assert.equal(await evaluate("document.querySelector('.assistant-turn.failed .assistant-process-trigger').getAttribute('aria-expanded')"), 'true')
  assert(await evaluate("document.querySelector('.assistant-turn.failed .assistant-process-trigger').disabled"))
  await screenshot('failure-visible')
  record('DSH failed process stays open with its recorded failure and retry')
  await writeFile(join(outRoot, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`Report: ${join(outRoot, 'report.json')}`)
} catch (error) {
  report.failure = { error: error instanceof Error ? error.stack ?? error.message : String(error) }
  try {
    report.diagnostic = await evaluate(`(() => {
      const selectors = ['.chat','.composer','.composer-shell','.composer-controls','.composer-left','.composer-right',
        '.runtime-picker-trigger','.send-round','.messages','.assistant-turn:last-child',
        '.assistant-turn:last-child .assistant-process-trigger','.assistant-turn:last-child .assistant-process-content',
        '.composer .stop'];
      return {width:innerWidth,theme:document.documentElement.getAttribute('data-ls-theme'),
        elements:selectors.map(selector=>{const el=document.querySelector(selector);if(!el)return {selector,found:false};
          const rect=el.getBoundingClientRect(),style=getComputedStyle(el);return {selector,found:true,
            text:el.innerText?.slice(0,240),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
            computed:{display:style.display,position:style.position,minHeight:style.minHeight,height:style.height,
              maxHeight:style.maxHeight,flexWrap:style.flexWrap,gap:style.gap,padding:style.padding,
              fontSize:style.fontSize,overflow:style.overflow,color:style.color,backgroundColor:style.backgroundColor,
              borderRadius:style.borderRadius},html:el.outerHTML.slice(0,1600)}})};
    })()`)
    await screenshot('failure')
  } catch (diagnosticError) {
    report.diagnosticFailure = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
  }
  await mkdir(outRoot, { recursive: true })
  await writeFile(join(outRoot, 'report.json'), JSON.stringify(report, null, 2))
  throw error
} finally {
  client?.close()
  if (child?.exitCode === null) await harness.forceTerminate(child)
  await provider.close()
}
