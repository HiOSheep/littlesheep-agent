// The pixel half of rule R3: does this control actually *show* that it is focused?
//
// R3 is stated in `packages/app/src/renderer/ui/focus-ownership.ts`. Half of it
// is a stylesheet question (`focus-indicator-rules.ts`: did a rule turn the
// outline off without a substitute?). The other half can only be answered by
// pixels, and this module is the reusable answer:
//
//   - `compareFocusFrames` classifies every changed pixel between a focused
//     frame and the same pixels blurred as **ring** (outside the control's own
//     border box) or **fill** (inside it), and reports the ring's coverage per
//     side. Ring-per-side is what makes a *clipped* ring visible as a defect
//     instead of a pass: the permission picker's focused option measured 0.00
//     coverage on its left and right sides while the middle of the ring existed.
//   - `focusVisibilityVerdict` turns those counts into the R3 verdict: a ring,
//     or a fill, and never both zero.
//
// Why computed style is not enough: `getComputedStyle().outlineWidth` reports
// what the cascade resolved, not what the user can see. Defect #19 was a rule
// that resolved to `outline: 0`; the permission picker's defect was a ring that
// resolved correctly and was then cut away by a scrolling ancestor. Both are
// invisible to the cascade and obvious in a frame diff.
//
// Why this is a module and not a script: two gates already needed it (the
// settings search field and the permission picker's options) and the previous
// one measured it by hand. Counting is owned here; what a control *must* show is
// the caller's assertion, passed in as a threshold.
//
// Ownership: frame diffing and pixel classification only. No window, no CDP, no
// per-control budgets.

/** Default ring floor: a ring has to be this large to be a treatment, not antialiasing. */
export const DEFAULT_RING_MIN_PIXELS = 120
/** Default fill floor: a fix that recolours the control instead of framing it still counts. */
export const DEFAULT_FILL_MIN_PIXELS = 400

/**
 * How far outside the measured control the comparison reaches. The app-wide ring
 * is 2px wide at a 2px offset, so 8 CSS pixels covers it with room for a
 * device-pixel-ratio scale-up.
 */
export const DEFAULT_REGION_INFLATE_PX = 8

/** `{ left, top, right, bottom, width, height }` in CSS pixels, from `getBoundingClientRect`. */
export function rectOf(box) {
  return {
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom,
    width: box.width,
    height: box.height,
  }
}

/** The centre of a rect, which is where a real pointer click goes. */
export function centerOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/** The device-pixel box that decides ring from fill: the control's own border box. */
export function classificationBox(rect, scale) {
  return {
    left: Math.floor(rect.left * scale),
    top: Math.floor(rect.top * scale),
    right: Math.ceil(rect.right * scale),
    bottom: Math.ceil(rect.bottom * scale),
  }
}

/** The device-pixel region searched for changes: the control's box plus `inflatePx`. */
export function regionBox(rect, scale, image, inflatePx = DEFAULT_REGION_INFLATE_PX) {
  return {
    left: Math.max(0, Math.floor((rect.left - inflatePx) * scale)),
    top: Math.max(0, Math.floor((rect.top - inflatePx) * scale)),
    right: Math.min(image.width - 1, Math.ceil((rect.right + inflatePx) * scale)),
    bottom: Math.min(image.height - 1, Math.ceil((rect.bottom + inflatePx) * scale)),
  }
}

function hex(rgba) {
  return `#${[rgba[0], rgba[1], rgba[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Count the pixels that differ between two decoded frames, split by where they
 * are relative to `classificationRect`.
 *
 * `classificationRect` is the box that decides ring against fill: a changed
 * pixel inside it changed the control's own surface (a fill, or the text
 * caret), and anything else in the region was drawn around the control (a
 * ring). The caret lives inside a text control's box, which is exactly why it
 * can never be counted as a ring.
 *
 * `sampleLimit` is a human-readable trace, not an assertion: a handful of
 * changed pixels with their before/after colours is what lets a reader see what
 * changed and where.
 */
export function compareFocusFrames(restFrame, focusedFrame, {
  viewportWidth,
  classificationRect,
  inflatePx = DEFAULT_REGION_INFLATE_PX,
  sampleLimit = 6,
} = {}) {
  const rest = restFrame.image ?? restFrame
  const focused = focusedFrame.image ?? focusedFrame
  if (rest.width !== focused.width || rest.height !== focused.height) {
    throw new Error(`frames differ in size: ${rest.width}x${rest.height} against ${focused.width}x${focused.height}`)
  }
  if (!classificationRect) throw new Error('compareFocusFrames needs the control rect that decides ring from fill')
  // The screenshot is in device pixels; the rects are CSS pixels.
  const scale = rest.width / (viewportWidth ?? rest.width)
  const region = regionBox(classificationRect, scale, rest, inflatePx)
  const box = classificationBox(classificationRect, scale)
  const inBox = (x, y) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom

  let changed = 0
  let ring = 0
  let fill = 0
  const sides = { left: 0, right: 0, top: 0, bottom: 0 }
  const samples = []
  for (let y = region.top; y <= region.bottom; y += 1) {
    for (let x = region.left; x <= region.right; x += 1) {
      const offset = (y * rest.width + x) * rest.channels
      const before = pixelRgba(rest, offset)
      const after = pixelRgba(focused, offset)
      if (before[0] === after[0] && before[1] === after[1] && before[2] === after[2] && before[3] === after[3]) continue
      changed += 1
      const isFill = inBox(x, y)
      if (isFill) {
        fill += 1
      } else {
        ring += 1
        if (x < box.left) sides.left += 1
        else if (x > box.right) sides.right += 1
        else if (y < box.top) sides.top += 1
        else if (y > box.bottom) sides.bottom += 1
      }
      if (samples.length < sampleLimit) {
        samples.push({ x, y, rest: hex(before), focused: hex(after), zone: isFill ? 'fill' : 'ring' })
      }
    }
  }
  return {
    changed,
    ring,
    fill,
    sides,
    scale,
    region,
    classification: box,
    samples,
  }
}

/**
 * The R3 verdict for one measurement.
 *
 * A control passes when it shows a ring at least `ringMinPixels` large or a fill
 * at least `fillMinPixels` large. Passing thresholds are arguments because the
 * control's size is the caller's knowledge, not this module's.
 */
export function focusVisibilityVerdict(measurement, {
  ringMinPixels = DEFAULT_RING_MIN_PIXELS,
  fillMinPixels = DEFAULT_FILL_MIN_PIXELS,
} = {}) {
  const ring = measurement?.ring ?? 0
  const fill = measurement?.fill ?? 0
  const shown = ring >= ringMinPixels ? 'ring' : fill >= fillMinPixels ? 'fill' : null
  return {
    visible: shown !== null,
    shown,
    ring,
    fill,
    reason: shown !== null
      ? `${shown}: ${shown === 'ring' ? ring : fill} pixels`
      : `neither a ring (${ring} < ${ringMinPixels}) nor a fill (${fill} < ${fillMinPixels})`,
  }
}

/**
 * The noise floor: the same rest state captured twice, compared over the same
 * region. A caller asserts this is zero (or below its own tolerance) so a
 * non-zero focus reading can only come from the focus treatment and not from a
 * surface that repaints on its own.
 */
export function noiseFloor(restFrame, restAgainFrame, options = {}) {
  return compareFocusFrames(restFrame, restAgainFrame, options)
}

/**
 * True when every side of the ring that *should* be covered is covered.
 *
 * A ring that is drawn and then clipped shows up here: the permission picker's
 * focused option had left and right coverage of exactly zero while the middle
 * of the ring was painted. `minPerSide` is deliberately small - one pixel of
 * coverage on a side disproves "that side does not exist" - and is a floor for
 * antialiasing, not a quality bar.
 */
export function ringSidesCovered(measurement, { minPerSide = 1 } = {}) {
  const sides = measurement?.sides ?? { left: 0, right: 0, top: 0, bottom: 0 }
  const drawn = measurement?.ring ?? 0
  const absent = Object.entries(sides).filter(([, count]) => count < minPerSide).map(([side]) => side)
  return { covered: drawn > 0 && absent.length === 0, absent, sides }
}

/**
 * Decode helper shared by the gates that capture through CDP: PNG bytes in,
 * decoded image out. Kept here so a caller does not import two pixel modules.
 */
export function decodeFrame(bytes, decodePng) {
  return decodePng(bytes)
}

function pixelRgba(image, offset) {
  const { pixels, colorType } = image
  if (colorType === 6) return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]]
  if (colorType === 2) return [pixels[offset], pixels[offset + 1], pixels[offset + 2], 255]
  if (colorType === 4) return [pixels[offset], pixels[offset], pixels[offset], pixels[offset + 1]]
  return [pixels[offset], pixels[offset], pixels[offset], 255]
}
