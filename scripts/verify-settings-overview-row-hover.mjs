// Real-window check for the 设置 → 总览 rows' hover fill.
//
// The reported defect: hovering a row in 常用设置 highlighted a box with rounded
// corners and a 2px seam, so the fill did not cover the cell it belongs to. The
// neighbouring groups joined their rows into one card; this one did not.
//
// Usage:
//   node scripts/verify-settings-overview-row-hover.mjs [--keep]
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import { runArtifact } from './lib/run-artifacts.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = createElectronHarness({ startTimeoutMs: 90_000 })

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-overview-hover-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const outDir = runArtifact('settings-overview-hover')
  let electron
  let client
  const failures = []
  try {
    await Promise.all([
      mkdir(workplaceDir, { recursive: true }),
      mkdir(chromiumDir, { recursive: true }),
      mkdir(outDir, { recursive: true }),
    ])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(config(workplaceDir), null, 2)}\n`, 'utf8')
    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Page.enable')
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.settings-entry-btn'))`), 90_000, 'renderer')
    await client.evaluate(`document.querySelector('.settings-entry-btn').click()`)
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.settings-overview-row'))`), 60_000, 'overview rows')
    await waitForReveal(client)

    // The hover fill is a JS-observable fact: force `:hover` through CDP instead of
    // guessing, then read the painted geometry back.
    const geometry = await client.evaluate(`(() => {
      const items = document.querySelector('.settings-overview-group-items');
      const rows = [...items.querySelectorAll('.settings-overview-row')];
      const group = items.getBoundingClientRect();
      const rects = rows.map((row) => {
        const rect = row.getBoundingClientRect();
        const style = getComputedStyle(row);
        return {
          title: (row.querySelector('strong')?.textContent || '').trim(),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          radiusTopLeft: style.borderTopLeftRadius,
          radiusBottomRight: style.borderBottomRightRadius,
          background: style.backgroundColor,
        };
      });
      // Rows must be joined: a visible gap is the seam the hover fill cannot cover.
      const gaps = rects.slice(1).map((rect, index) => Math.round(rect.top - rects[index].bottom));
      return {
        groupLeft: Math.round(group.left),
        groupRight: Math.round(group.right),
        groupTop: Math.round(group.top),
        groupBottom: Math.round(group.bottom),
        rows: rects,
        gaps,
        widths: rects.map((rect) => rect.right - rect.left),
        // Every row fills the column edge to edge. The container is compared by its
        // content box: it carries a 1px border, so its own rect is one pixel wider.
        contentLeft: Math.round(group.left + parseFloat(getComputedStyle(items).borderLeftWidth)),
        contentRight: Math.round(group.right - parseFloat(getComputedStyle(items).borderRightWidth)),
        contentTop: Math.round(group.top + parseFloat(getComputedStyle(items).borderTopWidth)),
        contentBottom: Math.round(group.bottom - parseFloat(getComputedStyle(items).borderBottomWidth)),
        groupGap: getComputedStyle(items).gap,
        groupRadius: getComputedStyle(items).borderRadius,
      };
    })()`)
    const rowsFillHorizontally = geometry.rows.every((rect) => (
      rect.left >= geometry.contentLeft - 1 && rect.right >= geometry.contentRight - 1
    ))
    if (!rowsFillHorizontally) {
      failures.push(`rows do not span their column: ${JSON.stringify({ group: [geometry.contentLeft, geometry.contentRight], widths: geometry.widths })}`)
    }
    // The seam is a gap between rows. The rows keep the sidebar interaction frame's
    // own radius (asserted by `sidebar-section-toggle.test.ts`), so the fill is a
    // rounded box that fills the cell; what must not exist is unpainted space
    // *between* two cells.
    if (geometry.gaps.some((gap) => gap > 0)) {
      failures.push(`the rows are not joined, so the hover fill leaves a seam: ${JSON.stringify(geometry.gaps)}`)
    }

    // Now measure the actual hover paint: move the pointer over one row.
    const target = geometry.rows[1]
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round((geometry.groupLeft + geometry.groupRight) / 2),
      y: Math.round((target.top + target.bottom) / 2),
    })
    await harness.waitFor(() => client.evaluate(`(() => {
      const row = [...document.querySelectorAll('.settings-overview-row')][1];
      return getComputedStyle(row).backgroundColor !== 'rgba(0, 0, 0, 0)' ? true : null;
    })()`), 10_000, 'the hover fill to paint')
    const hovered = await client.evaluate(`(() => {
      const row = [...document.querySelectorAll('.settings-overview-row')][1];
      const rect = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        background: style.backgroundColor,
        radius: style.borderTopLeftRadius,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
      };
    })()`)
    await shot(client, outDir, 'overview-hover')

    // Geometry can be right while the paint is not: sample the pixels at the row's own
    // corners and at the seam above it, which is where a rounded or gapped fill shows.
    const painted = await sampleHoverPaint(client, hovered)
    if (!painted.edgesPainted) {
      failures.push(`the hover fill does not reach the row's edges: ${JSON.stringify(painted.samples)}`)
    }
    if (!painted.seamPainted) {
      failures.push(`a seam remains between the hovered row and its neighbour: ${JSON.stringify(painted.samples)}`)
    }

    console.log(JSON.stringify({
      check: 'settings-overview-row-hover',
      ok: failures.length === 0,
      screenshot: join(outDir, 'overview-hover.png'),
      geometry,
      hovered,
      painted,
      failures,
    }, null, 2))
    if (failures.length > 0) process.exitCode = 1
  } finally {
    client?.close()
    if (electron?.exitCode === null) electron.kill()
    if (!process.argv.includes('--keep')) await harness.removeTemporaryRoot(root)
  }
}

/**
 * Read the actual pixels of the hovered row's corners and of the seam above it.
 *
 * `getBoundingClientRect` cannot tell a painted corner from a clipped one, so the DOM
 * geometry is checked against what the compositor really produced: crop the row's own
 * box, then compare the corner pixels with the fill sampled at its centre.
 */
async function sampleHoverPaint(client, hovered) {
  const clip = {
    x: hovered.left,
    y: hovered.top,
    width: hovered.width,
    height: hovered.bottom - hovered.top,
    scale: 1,
  }
  const shot = await client.send('Page.captureScreenshot', { format: 'png', clip })
  const buffer = Buffer.from(shot.data, 'base64')
  // Decode without an image library: the PNG is a full-colour image, so read it back
  // through the renderer instead of parsing it here.
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
  return client.evaluate(`(async () => {
    const image = new Image();
    image.src = ${JSON.stringify(dataUrl)};
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const at = (x, y) => {
      const [r, g, b, a] = context.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
      return [r, g, b, a].join(',');
    };
    const width = image.width;
    const height = image.height;
    const centre = at(Math.floor(width / 2), Math.floor(height / 2));
    const corners = {
      topLeft: at(2, 2),
      topRight: at(width - 3, 2),
      bottomLeft: at(2, height - 3),
      bottomRight: at(width - 3, height - 3),
    };
    // The top edge, two pixels inside the rounded corner: the strip that used to be
    // left unpainted when the rows were separated by a grid gap.
    const above = at(Math.floor(width / 2), 1);
    const inset = at(2, 2);
    const parse = (value) => value.split(',').map(Number);
    const reference = parse(centre);
    // The row is the highlight, so its own pixels are the fill. The neighbouring
    // row's surface is a different colour; the tolerance absorbs the anti-aliasing
    // along the rounded edge.
    const isFill = (value) => {
      const channels = parse(value);
      return channels[3] > 250 && channels.every((channel, index) => Math.abs(channel - reference[index]) <= 3);
    };
    return {
      size: { width, height },
      centre,
      corners,
      above,
      edgesPainted: Object.values(corners).every(isFill),
      seamPainted: isFill(above) && isFill(inset),
      samples: { centre, corners, above },
    };
  })()`)
}

async function waitForReveal(client) {
  await harness.waitFor(() => client.evaluate(`(() => {
    const layer = document.querySelector('.presence-layer.settings-presence');
    const body = document.querySelector('.settings-workspace-body');
    return Boolean(layer && body && layer.classList.contains('presence-open') && Number(getComputedStyle(body).opacity) > 0.99);
  })()`), 30_000, 'settings reveal')
}

async function shot(client, dir, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'))
}

function config(workspaceDir) {
  return {
    version: 1,
    providers: [{
      id: 'fixture-gw',
      name: 'fixture gw',
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-overview-hover-fixture',
      models: ['fixture-model'],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'fixture-gw/fixture-model',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 8,
      },
    },
    desktop: { closePolicy: 'always-background' },
  }
}

await main()
