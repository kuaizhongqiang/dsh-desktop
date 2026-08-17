// Generate build/icon.ico (256x256, PNG-embedded ICO) with a simple geometric
// "harness loop" mark. Pure Node: zlib + hand-rolled PNG/ICO encoders.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 256
const root = dirname(dirname(fileURLToPath(import.meta.url)))

// Palette
const BG = [31, 41, 55, 255]      // slate-800
const RING = [159, 234, 249, 255] // light cyan
const CORE = [94, 234, 212, 255]  // teal-300
const DIM = [75, 110, 130, 255]

function inRing(x, y) {
  const cx = SIZE / 2, cy = SIZE / 2
  const dx = x - cx, dy = y - cy
  const d = Math.sqrt(dx * dx + dy * dy)
  const R1 = 84, R2 = 104 // ring radii
  return d >= R1 && d <= R2
}
function inCore(x, y) {
  const cx = SIZE / 2, cy = SIZE / 2
  const dx = x - cx, dy = y - cy
  return Math.sqrt(dx * dx + dy * dy) <= 30
}
function inPip(x, y) {
  // small satellite dots on the ring
  for (const a of [30, 150, 270]) {
    const rad = (a * Math.PI) / 180
    const px = SIZE / 2 + 94 * Math.cos(rad)
    const py = SIZE / 2 + 94 * Math.sin(rad)
    const dx = x - px, dy = y - py
    if (dx * dx + dy * dy <= 6 * 6) return true
  }
  return false
}
function pixel(x, y) {
  if (inCore(x, y)) return CORE
  if (inRing(x, y)) return RING
  if (inPip(x, y)) return DIM
  return BG
}

// RGBA scanlines
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1)
  raw[row] = 0 // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixel(x, y)
    const o = row + 1 + x * 4
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a
  }
}

// PNG chunks
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
const idat = deflateSync(raw, { level: 9 })
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])

// ICO container (PNG-compressed entry, 256x256)
const ico = Buffer.alloc(6 + 16 + png.length)
ico.writeUInt16LE(0, 0)   // reserved
ico.writeUInt16LE(1, 2)   // type: icon
ico.writeUInt16LE(1, 4)   // count
ico[6] = 0                // width (0 = 256)
ico[7] = 0                // height
ico[8] = 0                // colors
ico[9] = 0                // reserved
ico.writeUInt16LE(1, 10)  // planes
ico.writeUInt16LE(32, 12) // bpp
ico.writeUInt32LE(png.length, 14)
ico.writeUInt32LE(22, 18) // offset
png.copy(ico, 22)

const out = join(root, 'build', 'icon.ico')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, ico)
console.log(`icon written: ${out} (${ico.length} bytes)`)
