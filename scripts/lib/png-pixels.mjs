// Minimal PNG reader for pixel-level checks in the real-window verification
// scripts. Chromium's `Page.captureScreenshot` output is 8-bit non-interlaced
// PNG, so only those cases are supported and anything else is rejected loudly
// instead of being interpreted as a measurement.
//
// Ownership: PNG decoding and pixel sampling only. What a pixel must be is the
// caller's assertion, never this module's.

import { inflateSync } from 'node:zlib'

export function decodePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('screenshot is not PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) throw new Error('truncated screenshot PNG')
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart)
      height = buffer.readUInt32BE(dataStart + 4)
      bitDepth = buffer[dataStart + 8]
      colorType = buffer[dataStart + 9]
      if (buffer[dataStart + 12] !== 0) throw new Error('interlaced screenshot is unsupported')
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }
  if (!width || !height || bitDepth !== 8) throw new Error('unsupported screenshot format')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`unsupported screenshot color type: ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const rowBytes = width * channels
  if (raw.length < height * (rowBytes + 1)) throw new Error('truncated screenshot pixel data')
  const pixels = Buffer.alloc(height * rowBytes)
  let sourceOffset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset++]
    if (filter > 4) throw new Error(`unsupported screenshot PNG filter: ${filter}`)
    const rowStart = y * rowBytes
    for (let x = 0; x < rowBytes; x += 1) {
      const source = raw[sourceOffset++]
      const left = x >= channels ? pixels[rowStart + x - channels] : 0
      const up = y > 0 ? pixels[rowStart - rowBytes + x] : 0
      const upperLeft = y > 0 && x >= channels ? pixels[rowStart - rowBytes + x - channels] : 0
      pixels[rowStart + x] = unfilterByte(filter, source, left, up, upperLeft)
    }
  }
  return { width, height, channels, colorType, pixels }
}

/** RGBA at an image coordinate, clamped to the image bounds. */
export function pixelAt(image, x, y) {
  const { width, height, channels, colorType, pixels } = image
  const cx = Math.min(Math.max(Math.trunc(x), 0), width - 1)
  const cy = Math.min(Math.max(Math.trunc(y), 0), height - 1)
  return pixelRgba(pixels, cy * width * channels + cx * channels, colorType)
}

/** `#RRGGBB` for an image coordinate. */
export function hexAt(image, x, y) {
  const [r, g, b] = pixelAt(image, x, y)
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/** Distinct `#RRGGBB` colours along a vertical strip, in order. */
export function columnColors(image, x, fromY, toY, step = 1) {
  const colors = []
  for (let y = fromY; y <= toY; y += step) colors.push(hexAt(image, x, y))
  return colors
}

function unfilterByte(filter, source, left, up, upperLeft) {
  if (filter === 0) return source
  if (filter === 1) return (source + left) & 0xff
  if (filter === 2) return (source + up) & 0xff
  if (filter === 3) return (source + Math.floor((left + up) / 2)) & 0xff
  const estimate = left + up - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  const predictor = leftDistance <= upDistance && leftDistance <= upperLeftDistance
    ? left
    : upDistance <= upperLeftDistance ? up : upperLeft
  return (source + predictor) & 0xff
}

function pixelRgba(buffer, offset, colorType) {
  if (colorType === 6) return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]]
  if (colorType === 2) return [buffer[offset], buffer[offset + 1], buffer[offset + 2], 255]
  if (colorType === 4) return [buffer[offset], buffer[offset], buffer[offset], buffer[offset + 1]]
  return [buffer[offset], buffer[offset], buffer[offset], 255]
}
