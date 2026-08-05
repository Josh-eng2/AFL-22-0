#!/usr/bin/env bash
# Rasterizes favicon.svg into favicon.ico (16/32/48px, PNG-in-ICO) so search
# engines and crawlers that don't support SVG favicons — Google Search's
# favicon fetcher included — have a supported fallback at the conventional
# /favicon.ico location. Re-run after editing favicon.svg.
# Requires a Chromium/Chrome binary; pass its path as $1 or have `chromium`
# on PATH.
#
# Renders ONE 512px bitmap and downsamples it in Node, rather than asking
# Chromium for a 16/32/48px screenshot directly. Two headless-Chromium traps
# make the direct route produce a blank icon that still passes a dimensions
# check — both were shipped undetected once (see git history):
#
#   1. file:// pages cannot load file:// subresources, so referencing the SVG
#      with <img src="…"> renders a broken-image glyph. The SVG is inlined.
#   2. Below roughly 256px of viewport, headless Chromium returns a BLANK
#      bitmap at exactly the requested pixel dimensions. --force-device-scale-
#      factor clamps at 0.5, so no flag combination reaches 16px directly.
#
# scripts/build_pwa_icons.sh renders the larger manifest icons from the same
# favicon.svg and hits trap 1 and the 2x workaround for trap 2.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${1:-$(command -v chromium || command -v chromium-browser || command -v google-chrome)}"
if [ -z "$CHROME" ]; then
  echo "error: no chromium/chrome binary found (pass one as \$1)" >&2
  exit 1
fi
SIZES=(16 32 48)
RENDER_AT=512

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

{
  printf '<!DOCTYPE html><html><head><style>\n'
  printf 'html,body{margin:0;padding:0;background:transparent}\n'
  printf 'svg{display:block;width:100vw;height:100vh}\n'
  printf '</style></head><body>\n'
  cat favicon.svg
  printf '</body></html>\n'
} > "$TMPDIR/render.html"

"$CHROME" --headless --no-sandbox --disable-gpu \
  --window-size="${RENDER_AT},${RENDER_AT}" \
  --default-background-color=00000000 \
  --screenshot="$TMPDIR/favicon-src.png" \
  "file://$TMPDIR/render.html" >/dev/null 2>&1

node - "$TMPDIR" "${SIZES[@]}" <<'NODE'
'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const [dir, ...sizeArgs] = process.argv.slice(2);
const sizes = sizeArgs.map(Number);
const src   = fs.readFileSync(path.join(dir, 'favicon-src.png'));

// ── Minimal PNG reader ──────────────────────────────────────────────────────
// Only has to handle what Chrome's --screenshot emits: 8-bit RGBA,
// non-interlaced. Anything else is a bug, not a case to support.
function decodePng(buf) {
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const bitDepth = buf[24], colorType = buf[25], interlace = buf[28];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`unexpected PNG format: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }
  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  // Undo per-scanline filtering (PNG spec §9.2).
  const bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line   = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur    = out.subarray(y * stride, (y + 1) * stride);
    const prev   = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

// Box downsample, averaging in premultiplied alpha so transparent pixels
// don't drag colour toward black along the crest's antialiased edge.
function resize(img, size) {
  const { width: sw, height: sh, data } = img;
  const out = Buffer.alloc(size * size * 4);
  const sx = sw / size, sy = sh / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4, al = data[i + 3] / 255;
          r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += data[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      const am = a / n;
      const un = am > 0 ? (n * 255) / a : 0;
      out[o]     = Math.min(255, Math.round((r / n) * un));
      out[o + 1] = Math.min(255, Math.round((g / n) * un));
      out[o + 2] = Math.min(255, Math.round((b / n) * un));
      out[o + 3] = Math.round(am);
    }
  }
  return { width: size, height: size, data: out };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td  = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(img) {
  const { width, height, data } = img, stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Build ───────────────────────────────────────────────────────────────────
const decoded = decodePng(src);
if (decoded.width !== 512) throw new Error(`source render is ${decoded.width}px, expected 512`);

// A blank render decodes fine and has correct dimensions, so check for actual
// ink: the crest fills most of the frame, so a real one is nowhere near empty.
const opaque = (() => { let n = 0; for (let i = 3; i < decoded.data.length; i += 4) if (decoded.data[i] > 8) n++; return n; })();
const coverage = opaque / (decoded.width * decoded.height);
if (coverage < 0.25) {
  throw new Error(`source render is ${(coverage * 100).toFixed(1)}% non-transparent — blank, not the crest`);
}

const pngBuffers = sizes.map(s => encodePng(resize(decoded, s)));

const headerSize = 6 + 16 * pngBuffers.length;
let offset = headerSize;
const dirEntries = [];
sizes.forEach((s, i) => {
  const data = pngBuffers[i];
  const entry = Buffer.alloc(16);
  entry.writeUInt8(s === 256 ? 0 : s, 0);
  entry.writeUInt8(s === 256 ? 0 : s, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  dirEntries.push(entry);
  offset += data.length;
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngBuffers.length, 4);

fs.writeFileSync('favicon.ico', Buffer.concat([header, ...dirEntries, ...pngBuffers]));
console.log(`  source ${decoded.width}x${decoded.height}, ${(coverage * 100).toFixed(1)}% ink`);
sizes.forEach((s, i) => console.log(`  ${s}x${s}  ${pngBuffers[i].length} bytes`));
NODE

echo "Wrote favicon.ico ($(du -h favicon.ico | cut -f1), sizes: ${SIZES[*]})"
