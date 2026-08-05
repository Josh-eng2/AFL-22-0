'use strict';
/**
 * scripts/lib/png.js — minimal PNG read/write/resize/crop, zlib only.
 *
 * Shared by scripts/build_favicon.sh and scripts/build_og_image.sh, which both
 * post-process a Chromium screenshot. This repo has no package.json by design,
 * so there is no image library to reach for — and everything needed here is a
 * few dozen lines against Node's built-in zlib.
 *
 * Only handles what Chrome's --screenshot emits: 8-bit non-interlaced, either
 * RGBA (colour type 6, when the page background is transparent) or RGB
 * (colour type 2, when it is opaque — which is why the OG card and the icons
 * arrive in different formats). Both are normalised to RGBA on the way in.
 * Anything else is a bug to surface, not a case to support.
 */
const zlib = require('zlib');

function decode(buf) {
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const bitDepth = buf[24], colorType = buf[25], interlace = buf[28];
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error(`unexpected PNG format: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  // Undo per-scanline filtering (PNG spec §9.2). Filtering operates on the
  // source channel count, so unfilter in the source layout first.
  const bpp = channels, stride = width * bpp;
  const flat = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line   = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur    = flat.subarray(y * stride, (y + 1) * stride);
    const prev   = y ? flat.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
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
  if (channels === 4) return { width, height, data: flat };

  // RGB -> RGBA, fully opaque.
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0, o = 0; i < flat.length; i += 3, o += 4) {
    out[o] = flat[i]; out[o + 1] = flat[i + 1]; out[o + 2] = flat[i + 2]; out[o + 3] = 255;
  }
  return { width, height, data: out };
}

/**
 * Box downsample. Averages in premultiplied alpha so transparent pixels don't
 * drag colour toward black along an antialiased edge.
 */
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

/** Top-left crop to w×h. */
function crop(img, w, h) {
  if (w > img.width || h > img.height) {
    throw new Error(`cannot crop ${img.width}x${img.height} to ${w}x${h}`);
  }
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.data.copy(out, y * w * 4, y * img.width * 4, y * img.width * 4 + w * 4);
  }
  return { width: w, height: h, data: out };
}

/**
 * Fraction of pixels that are meaningfully non-transparent.
 *
 * The load-bearing check in both callers: headless Chromium returns BLANK
 * bitmaps at perfectly correct dimensions under some conditions, so a
 * dimensions assertion alone has already let a blank favicon ship once.
 */
function inkCoverage(img) {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 8) n++;
  return n / (img.width * img.height);
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

function encode(img) {
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

module.exports = { decode, encode, resize, crop, inkCoverage };
