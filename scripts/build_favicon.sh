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
const png  = require(process.cwd() + '/scripts/lib/png.js');

const [dir, ...sizeArgs] = process.argv.slice(2);
const sizes = sizeArgs.map(Number);

const decoded = png.decode(fs.readFileSync(path.join(dir, 'favicon-src.png')));
if (decoded.width !== 512) throw new Error(`source render is ${decoded.width}px, expected 512`);

// A blank render decodes fine and has correct dimensions, so check for actual
// ink: the crest fills most of the frame, so a real one is nowhere near empty.
const coverage = png.inkCoverage(decoded);
if (coverage < 0.25) {
  throw new Error(`source render is ${(coverage * 100).toFixed(1)}% non-transparent — blank, not the crest`);
}

const pngBuffers = sizes.map(s => png.encode(png.resize(decoded, s)));

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
