#!/usr/bin/env bash
# scripts/afl_vendor_data.sh — fetch the AFL source corpus used to build players.json.
#
# Source: https://github.com/akareen/AFL-Data-Analysis  (MIT, (c) 2023 Adam Kareen)
# A mirror of AFL Tables as committed CSVs: ~13,200 players, 1897-2025.
#
# Why a mirror and not the original site: afltables.com, footywire.com and
# api.squiggle.com.au are all network-blocked in this build environment
# (the proxy answers 403 to CONNECT). See docs/afl-build-out-plan.md §0.1.
#
# The corpus is ~137 MB and is NEVER committed — vendor/ is gitignored.
# Only the derived players.json ships. See data/README.md.
#
# Usage:  bash scripts/afl_vendor_data.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/afl-data"

# Pinned so a re-run reproduces the exact dataset players.json was built from.
# Bump deliberately (and re-run the pipeline + audit) — never silently.
PIN_SHA="c71299ef01958e5454dc4583c6787775f9e14b53"
REPO="https://github.com/akareen/AFL-Data-Analysis.git"

if [ -d "$DEST/.git" ]; then
  have="$(git -C "$DEST" rev-parse HEAD 2>/dev/null || echo none)"
  if [ "$have" = "$PIN_SHA" ]; then
    echo "Vendored corpus already at pinned SHA ${PIN_SHA:0:12} — nothing to do."
    exit 0
  fi
  echo "Vendored corpus is at ${have:0:12}, want ${PIN_SHA:0:12} — refetching."
  rm -rf "$DEST"
fi

mkdir -p "$(dirname "$DEST")"

# Sparse + blobless: we only need data/, not the notebooks/assets/odds history.
git clone --filter=blob:none --sparse "$REPO" "$DEST"
git -C "$DEST" sparse-checkout set data/players data/matches
git -C "$DEST" checkout "$PIN_SHA"

echo
echo "Vendored to: $DEST"
echo "  pinned SHA : $PIN_SHA"
echo "  player files: $(ls "$DEST/data/players" | wc -l)"
echo "  size        : $(du -sh "$DEST/data" | cut -f1)"
echo
echo "Next: node scripts/afl_build_seasons.mjs"
