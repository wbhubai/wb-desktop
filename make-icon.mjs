/**
 * Generates build/icon.ico (256x256 BMP-in-ICO) — a rounded-square badge with
 * the letters "WB", drawn pixel-by-pixel (no native image deps).
 */
import { PNG } from 'pngjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const S = 256
const png = new PNG({ width: S, height: S })

// palette
const BG = [79, 140, 255] // #4f8cff accent blue
const BG_DARK = [58, 108, 214]
const FG = [255, 255, 255]

function put(x, y, rgb, alpha = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return
  const idx = (S * y + x) << 2
  png.data[idx] = rgb[0]
  png.data[idx + 1] = rgb[1]
  png.data[idx + 2] = rgb[2]
  png.data[idx + 3] = alpha
}

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.max(x0 + r, Math.min(x, x1 - r))
  const cy = Math.max(y0 + r, Math.min(y, y1 - r))
  const dx = x - cx
  const dy = y - cy
  return x >= x0 + r && x <= x1 - r ? true : dx * dx + dy * dy <= r * r
}

// 5x7 letter bitmaps for W and B
const W = [
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 1, 0, 1],
  [1, 0, 1, 0, 1],
  [1, 1, 1, 1, 1],
  [1, 1, 0, 1, 1],
]
const B = [
  [1, 1, 1, 0],
  [1, 0, 0, 1],
  [1, 0, 0, 1],
  [1, 1, 1, 0],
  [1, 0, 0, 1],
  [1, 0, 0, 1],
  [1, 1, 1, 0],
]

function drawLetter(map, ox, oy, scale) {
  for (let row = 0; row < map.length; row++) {
    for (let col = 0; col < map[row].length; col++) {
      if (!map[row][col]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          put(ox + col * scale + dx, oy + row * scale + dy, FG)
        }
      }
    }
  }
}

// background: rounded square with vertical gradient + subtle border
for (let y = 0; y < S; y++) {
  const t = y / S
  const rgb = [Math.round(BG[0] + (BG_DARK[0] - BG[0]) * t), Math.round(BG[1] + (BG_DARK[1] - BG[1]) * t), Math.round(BG[2] + (BG_DARK[2] - BG[2]) * t)]
  for (let x = 0; x < S; x++) {
    if (inRoundedRect(x, y, 8, 8, S - 9, S - 9, 48)) put(x, y, rgb)
    else put(x, y, [0, 0, 0], 0)
  }
}

// letters: W (5 cols) + gap + B (4 cols), scale 14 → 9*14 = 126px wide, 98 tall
const scale = 14
const totalW = (5 + 1 + 4) * scale // 140
const startX = Math.round((S - totalW) / 2)
const startY = Math.round((S - 7 * scale) / 2)
drawLetter(W, startX, startY, scale)
drawLetter(B, startX + 6 * scale, startY, scale)

// encode PNG → BMP (BGRA, bottom-up) → ICO container
const barePng = PNG.sync.write(png)

// --- build 256x256 BMP-in-ICO from raw pixels
const headerSize = 40
const imageSize = S * S * 4
const bmp = Buffer.alloc(headerSize + imageSize)
bmp.writeUInt32LE(headerSize, 0)
bmp.writeInt32LE(S, 4)
bmp.writeInt32LE(S * 2, 8) // height doubled (XOR + AND mask)
bmp.writeUInt16LE(1, 12)
bmp.writeUInt16LE(32, 14)
let off = headerSize
for (let y = S - 1; y >= 0; y--) {
  for (let x = 0; x < S; x++) {
    const src = (S * y + x) << 2
    bmp[off++] = png.data[src + 2] // B
    bmp[off++] = png.data[src + 1] // G
    bmp[off++] = png.data[src] // R
    bmp[off++] = png.data[src + 3] // A
  }
}

const icoHeader = Buffer.alloc(6)
icoHeader.writeUInt16LE(0, 0)
icoHeader.writeUInt16LE(1, 2)
icoHeader.writeUInt16LE(1, 4)
const entry = Buffer.alloc(16)
entry[0] = 0 // width 256 → 0
entry[1] = 0
entry[2] = 0 // colors
entry[3] = 0
entry.writeUInt16LE(1, 4)
entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(bmp.length, 8)
entry.writeUInt32LE(6 + 16, 12)

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.ico', Buffer.concat([icoHeader, entry, bmp]))
// also emit a PNG for reference/preview
writeFileSync('build/icon.png', barePng)
console.log('icon written: build/icon.ico + build/icon.png')
