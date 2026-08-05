#!/usr/bin/env bash
# Rasterizes og-image.svg into the 1200x630 og-image.png referenced by the
# og:image / twitter:image meta tags (social crawlers don't render SVG).
# Requires a Chromium/Chrome binary; pass its path as $1 or have `chromium`
# on PATH. Re-run after editing og-image.svg.
#
# The SVG is inlined into the render page rather than referenced with
# <img src="og-image.svg">: a file:// page cannot load a file:// subresource,
# so the referencing version silently produced a card with a broken-image
# glyph on it. Same trap as build_favicon.sh and build_pwa_icons.sh.
#
# Rendered at 1200x840 and cropped to the top 1200x630. This Chromium paints
# only the top 75% of the --window-size height (measured: 630->473, 700->525,
# 800->600, 1000->750), leaving the rest of the screenshot canvas unpainted
# white; --headless=new and --force-device-scale-factor=1 do not change it.
# The width is unaffected. Asking for 840 therefore paints exactly 630 rows,
# and the crop discards the blank remainder.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${1:-$(command -v chromium || command -v chromium-browser || command -v google-chrome)}"
if [ -z "$CHROME" ]; then
  echo "error: no chromium/chrome binary found (pass one as \$1)" >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

{
  printf '<!DOCTYPE html><html><head><style>\n'
  printf '*{margin:0;padding:0}body{width:1200px;height:630px;overflow:hidden}\n'
  printf 'svg{display:block;width:1200px;height:630px}\n'
  printf '</style></head><body>\n'
  cat og-image.svg
  printf '</body></html>\n'
} > "$TMPDIR/render.html"

"$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1200,840 \
  --screenshot="$(pwd)/og-image.png" "file://$TMPDIR/render.html" >/dev/null 2>&1

node - <<'NODE'
'use strict';
const fs  = require('fs');
const png = require(process.cwd() + '/scripts/lib/png.js');

const img = png.decode(fs.readFileSync('og-image.png'));
if (img.width !== 1200 || img.height !== 840) {
  throw new Error(`render is ${img.width}x${img.height}, expected 1200x840`);
}

const card = png.crop(img, 1200, 630);

// A blank render has correct dimensions, so dimensions alone never prove the
// card drew — the same failure mode that shipped a blank favicon once. The
// card is a full-bleed dark background, so real output is ~100% opaque.
const coverage = png.inkCoverage(card);
if (coverage < 0.9) {
  throw new Error(`card is only ${(coverage * 100).toFixed(1)}% opaque — the render did not fill the frame`);
}

fs.writeFileSync('og-image.png', png.encode(card));
console.log(`  og-image.png  ${card.width}x${card.height}  ${(fs.statSync('og-image.png').size / 1024).toFixed(1)} KB  ${(coverage * 100).toFixed(1)}% opaque`);
NODE

echo "Wrote og-image.png ($(du -h og-image.png | cut -f1))"
