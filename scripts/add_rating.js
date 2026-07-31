'use strict';
/**
 * scripts/add_rating.js
 * Adds fields to every player in players.json:
 *   ratingRaw — the raw weighted value of the stat line (native scale)
 *   rating    — that value mapped onto a 0–100 scale
 *
 * This script does NOT set `overall`. `overall` is the field gameplay logic
 * reads (simulation strength, AI draft scoring, star/GOAT tiers, badge
 * colours) and it is built by scripts/add_overall.js, which runs after this
 * one and consumes `ratingRaw` as one of its six inputs.
 * Run:  node scripts/add_rating.js
 *
 * Raw formula (linear weighted value of a season-average stat line):
 *   ratingRaw = BASE
 *             + disposals  * 0.35
 *             + goals      * 2.20
 *             + marks      * 0.55
 *             + tackles    * 0.65
 *             + clearances * 0.85
 *
 * Weights are a first pass loosely anchored to AFL Fantasy's public scoring
 * conventions (goal ≈ 6, kick ≈ 3, handball ≈ 2, mark ≈ 3, tackle ≈ 4) —
 * disposals here is a blended kick+handball rate so it sits below either
 * individually; clearances carry a premium over a plain disposal because a
 * clearance is a higher-difficulty, higher-value possession. These are
 * NOT final — re-derive once the real ~800-1000 player dataset lands (see
 * docs/afl-port-plan.md §9), same as the NBA original's own weights were
 * fitted against its live DB. hitouts is intentionally excluded — it's a
 * display/synergy-only stat (see docs/afl-port-plan.md §D4), not part of
 * the balance-scored five, so it doesn't belong in the value formula either.
 *
 * 0–100 mapping: linear from the 2nd-percentile raw value (→ OVR_LO) to the
 * 99th-percentile raw value (→ OVR_HI), clamped to [OVR_MIN, OVR_MAX]. Anchors
 * are derived from the live data so the scale self-adjusts if stats change.
 * With only ~40 stub players the percentile anchors are noisy — revisit once
 * the real dataset lands.
 *
 * ── Relationship to `overall` ───────────────────────────────────────────────
 * `rating` is a pure stat-line value and is NOT what the game plays on. It
 * cannot be: AFL stat volume tracks position far more than quality, so rating
 * a key defender this way ranks him with the fringe players (the Glenn Archer
 * problem — see scripts/add_overall.js).
 *
 * `overall` is built separately by scripts/add_overall.js from Brownlow rate,
 * All-Australian and club best-and-fairest selections, goalkicking honours,
 * longevity and this stat line — defender-bias corrected and era-normalised.
 * `ratingRaw` feeds that composite as its production term; `rating` itself is
 * kept for display and for the audit scripts.
 *
 * An earlier version of this file set `overall = rating` as a placeholder.
 * It no longer does, and nothing here should reintroduce it — overwriting
 * `overall` after add_overall.js has run would silently revert the game to
 * stat-only ratings.
 */
const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'players.json');
const db  = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const BASE = 2.0;
const W = { disposals: 0.35, goals: 2.20, marks: 0.55, tackles: 0.65, clearances: 0.85 };

// 0–100 mapping knobs
const OVR_LO = 60;   // overall assigned to the low anchor (p2 raw)
const OVR_HI = 99;   // overall assigned to the high anchor (p99 raw)
const OVR_MIN = 55;  // hard floor (players below the low anchor)
const OVR_MAX = 99;  // hard ceiling

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function rawRating(p) {
  const raw = BASE
    + (p.disposals  || 0) * W.disposals
    + (p.goals      || 0) * W.goals
    + (p.marks      || 0) * W.marks
    + (p.tackles    || 0) * W.tackles
    + (p.clearances || 0) * W.clearances;
  return Math.round(raw * 10) / 10; // 1 decimal place
}

// ── Pass 1: raw value for everyone ────────────────────────────────────────────
const players = [];
for (const key of Object.keys(db)) {
  for (const p of db[key]) {
    p.ratingRaw = rawRating(p);
    players.push(p);
  }
}

// ── Derive mapping anchors from the raw distribution ─────────────────────────
const sorted = players.map(p => p.ratingRaw).sort((a, b) => a - b);
const pct = f => sorted[Math.floor(f * (sorted.length - 1))];
const lo = pct(0.02);
const hi = pct(0.99);

// ── Pass 2: mapped 0–100 overall ─────────────────────────────────────────────
let min = Infinity, max = -Infinity, sum = 0;
for (const p of players) {
  const scaled = OVR_LO + ((p.ratingRaw - lo) / (hi - lo)) * (OVR_HI - OVR_LO);
  p.rating  = clamp(Math.round(scaled), OVR_MIN, OVR_MAX);
  // Deliberately does NOT touch p.overall — see the header. That is
  // add_overall.js's output and this script runs before it.
  sum += p.rating;
  if (p.rating < min) min = p.rating;
  if (p.rating > max) max = p.rating;
}

fs.writeFileSync(SRC, JSON.stringify(db, null, 2), 'utf8');

console.log(`Done.`);
console.log(`  Total players : ${players.length}`);
console.log(`  Raw anchors   : p2=${lo}  p99=${hi}`);
console.log(`  Overall range : ${min} … ${max}  (avg ${(sum / players.length).toFixed(1)})`);
console.log(`Wrote ${SRC}`);
