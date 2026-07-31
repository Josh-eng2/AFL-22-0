#!/usr/bin/env bash
# Regenerates the derived fields on players.json, then inlines the shipped
# bundle at js/data/players.js.
#
# Order matters: add_overall.js consumes ratingRaw (produced by add_rating.js)
# as its production input, and inline_players.js must run last so the bundle
# carries the finished ratings.
set -e
cd "$(dirname "$0")/.."
node scripts/add_popularity.js
node scripts/add_rating.js
node scripts/add_overall.js
node scripts/inline_players.js
