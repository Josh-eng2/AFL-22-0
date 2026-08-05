#!/usr/bin/env bash
# Rasterizes favicon.svg into the PNG icons the web app manifest needs:
#
#   icons/icon-192.png          Android home screen / task switcher
#   icons/icon-512.png          splash screen + install prompt
#   icons/apple-touch-icon.png  iOS "Add to Home Screen" (180px, no alpha)
#
# Re-run after editing favicon.svg. Requires a Chromium/Chrome binary; pass
# its path as $1 or have `chromium` on PATH. Same rendering approach as
# scripts/build_favicon.sh, which produces the .ico for search crawlers.
#
# The manifest declares 192/512 as both "any" and "maskable". Android crops
# maskable icons to a circle with a ~10% safe-area inset on each edge — the
# crest is a full-bleed roundel, so it survives that crop; a square logo
# would not.
#
# iOS composites apple-touch-icon.png onto white if it has transparency, so
# that one is rendered on an opaque background matching the crest.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${1:-$(command -v chromium || command -v chromium-browser || command -v google-chrome)}"
if [ -z "$CHROME" ]; then
  echo "error: no chromium/chrome binary found (pass one as \$1)" >&2
  exit 1
fi

mkdir -p icons
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

render() { # render <out> <size> <background>
  local out="$1" size="$2" bg="$3"
  # The SVG is inlined, not referenced with <img src="file://…"> — Chromium
  # blocks file:// subresource loads from a file:// page, which renders a
  # broken-image glyph instead of the crest, silently and at full size.
  {
    printf '<!DOCTYPE html><html><head><style>\n'
    printf 'html,body{margin:0;padding:0;background:%s}\n' "$bg"
    printf 'svg{display:block;width:100vw;height:100vh}\n'
    printf '</style></head><body>\n'
    cat favicon.svg
    printf '</body></html>\n'
  } > "$TMPDIR/render.html"
  # Rendered at 2x the target with a 0.5 device scale factor rather than at a
  # small --window-size directly: headless Chromium silently produces a blank
  # bitmap below roughly 256px of viewport, at exactly the requested pixel
  # dimensions, so the failure looks like a valid icon. --force-device-scale-factor
  # also clamps at 0.5, which is why the window is exactly double.
  local win=$(( size * 2 ))
  "$CHROME" --headless --no-sandbox --disable-gpu \
    --window-size="${win},${win}" \
    --force-device-scale-factor=0.5 \
    --default-background-color=00000000 \
    --screenshot="$out" \
    "file://$TMPDIR/render.html" >/dev/null 2>&1
}

render "icons/icon-192.png"         192 transparent
render "icons/icon-512.png"         512 transparent
render "icons/apple-touch-icon.png" 180 "#0b1410"

node - <<'NODE'
const fs = require('fs');
// Verify each PNG's IHDR reports the size we asked for — a silently-truncated
// screenshot would otherwise ship as a broken install icon.
const want = { 'icons/icon-192.png': 192, 'icons/icon-512.png': 512, 'icons/apple-touch-icon.png': 180 };
for (const [f, size] of Object.entries(want)) {
  const buf = fs.readFileSync(f);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w !== size || h !== size) throw new Error(`${f} is ${w}x${h}, expected ${size}x${size}`);
  // A blank render still has correct dimensions, so size alone proves nothing.
  // The crest is detailed enough that a real one never compresses this small.
  const floor = size >= 512 ? 20000 : 4000;
  if (buf.length < floor) {
    throw new Error(`${f} is only ${buf.length} bytes — almost certainly a blank render, not the crest`);
  }
  console.log(`  ${f}  ${w}x${h}  ${(buf.length / 1024).toFixed(1)} KB`);
}
NODE

echo "Wrote icons/ from favicon.svg"
