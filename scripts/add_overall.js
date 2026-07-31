'use strict';
/**
 * scripts/add_overall.js — Phase B: the rating the game actually plays on.
 *
 * Replaces the Phase A placeholder (`overall = rating`, a pure stat-line
 * value) with an award/career composite: what a player actually achieved,
 * not merely what their per-game averages look like.
 *
 * Run:  node scripts/add_overall.js  [--explain=<player name>]
 * In/Out: players.json (adds `overall`, `overallParts`)
 *
 * MUST run after add_rating.js — it consumes `ratingRaw` as one input.
 *
 * ── Why a composite at all ──────────────────────────────────────────────────
 * A stat line alone cannot rank AFL players. The stat columns the source
 * carries (disposals, goals, marks, tackles, clearances) measure *volume*,
 * and volume is a function of position far more than of quality. A key
 * defender's job produces almost none of it: Glenn Archer's best season reads
 * 12.9 disposals / 1.3 goals, statistically indistinguishable from a fringe
 * small forward, and he is one of the most decorated defenders of his era.
 * Rating on stats alone ships him as a 60-something, which is simply wrong.
 * Awards measure standing among peers, which is what a rating should express.
 *
 * ── The three stages ────────────────────────────────────────────────────────
 *   B.1  raw composite   — weighted achievement score on native scales
 *   B.2  position calibration — correct the vote-bias against defenders
 *   B.3  per-era quantile normalisation — make eras comparable, peak = 99
 *
 * ── Load-bearing rule: a missing signal is NOT a zero ────────────────────────
 * This is the same trap as blank-vs-zero in the stat columns (data/README.md),
 * one level up. Brownlow votes do not exist in the source before 1984, so
 * every 1970s entry has none. Scoring that as "polled no votes" would rate the
 * entire decade as journeymen — Leigh Matthews and Kevin Bartlett included.
 *
 * Instead each input declares whether it is AVAILABLE for a given entry, and
 * the weighted mean is taken over available inputs only, renormalising by the
 * weight actually present. An entry missing the Brownlow term is scored on
 * what remains, rather than penalised for a gap in the historical record.
 */
const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const SRC    = path.join(ROOT, 'players.json');
const AWARDS = path.join(ROOT, 'data', 'awards');

const db = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const DECADES = ['1970s', '1980s', '1990s', '2000s', '2010s', '2020s'];
const POSITIONS = ['KD', 'HB', 'MID', 'RUC', 'KF', 'SF'];

const clamp01 = v => Math.max(0, Math.min(1, v));

// ── Optional award tables ───────────────────────────────────────────────────
// Committed under data/awards/ with provenance. Absent tables degrade to
// "signal unavailable" for every entry, which the weight renormalisation then
// handles — the build stays correct, just less informed.
function loadAwardTable(file) {
  const p = path.join(AWARDS, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const allAustralian = loadAwardTable('all-australian.json');
const bestAndFairest = loadAwardTable('best-and-fairest.json');

/**
 * Counts award selections for a player inside a club-decade window.
 * Tables are keyed by player name -> array of years, which is why the
 * name-collision repair in afl_positions.mjs has to happen upstream: two
 * different Gary Abletts sharing a key would pool their honours.
 */
function countInDecade(table, name, decade) {
  if (!table) return null;                       // unavailable, not zero
  const years = table.players?.[name];
  if (!years) return 0;                          // present in table, no honours
  const start = parseInt(decade, 10);
  return years.filter(y => y >= start && y <= start + 9).length;
}

// ── B.1: the raw composite ──────────────────────────────────────────────────
//
// Weights express what the game wants a rating to mean: peer recognition
// first, sustained output second, raw volume last. Brownlow carries the most
// weight of any single input because it is the one league-wide, era-neutral,
// per-round quality vote the source records — but it is capped at 55% of the
// available weight so a defender who never polls cannot be floored by it.
const INPUTS = [
  {
    key: 'brownlow',
    weight: 0.34,
    label: 'Brownlow rate',
    // Positional: umpire votes are the single most position-biased signal in
    // the database (see B.2). Corrected within position rather than raw.
    positional: true,
    // Votes per game across the club-decade, over the window where votes are
    // actually recorded. A rate rather than a total so a 1990s player with 200
    // games isn't automatically ahead of a 2010s player with 100.
    score(p) {
      if (!(p.decadeBrownlowGames > 0)) return null;   // pre-1984: no signal
      const rate = p.decadeBrownlow / p.decadeBrownlowGames;
      // Ceiling at 1.0 votes/game: the measured p99 is 0.99 and the maximum
      // 1.19, so this saturates only for the genuinely singular seasons.
      return clamp01(rate / 1.0);
    },
  },
  {
    key: 'allAustralian',
    weight: 0.20,
    label: 'All-Australian',
    score(p) {
      const n = countInDecade(allAustralian, p.name, p._decade);
      if (n == null) return null;
      // Three selections in a decade is an all-time-great cadence.
      return clamp01(n / 3);
    },
  },
  {
    key: 'bestAndFairest',
    weight: 0.16,
    label: 'Club best & fairest',
    // The key defender's rescue signal: B&F is voted by the club's own
    // coaches, who see defensive work the Brownlow's umpire votes never
    // reward. This is why it earns real weight despite being club-relative.
    score(p) {
      const n = countInDecade(bestAndFairest, p.name, p._decade);
      if (n == null) return null;
      return clamp01(n / 3);
    },
  },
  {
    key: 'longevity',
    weight: 0.14,
    label: 'Games + finals',
    // Sustained selection is itself a quality signal — a club does not play a
    // passenger 200 times — and it is fully recorded in every era.
    //
    // Career games blend in alongside the club-decade stint because an entry
    // is a stint but a reputation is a career. Scored on the stint alone, Gary
    // Ablett Jr's Gold Coast years read 0.39: he was the best player in the
    // competition, but he arrived mid-decade at an expansion club and played
    // no finals, so the stint is short and finals-less through no fault of
    // his. The stint still leads (0.65) — it is what the card depicts — with
    // the career term stopping a mid-career club switch from reading as a
    // lack of durability.
    score(p) {
      const stintGames  = clamp01((p.decadeGames  || 0) / 200);
      const stintFinals = clamp01((p.decadeFinals || 0) / 15);
      const stint  = clamp01(stintGames * 0.75 + stintFinals * 0.25);
      const career = clamp01((p.careerGames || 0) / 300);
      return clamp01(stint * 0.65 + career * 0.35);
    },
  },
  {
    key: 'production',
    weight: 0.16,
    label: 'Stat line',
    // Positional: disposal/goal volume is a function of role far more than of
    // quality — the original reason a stat-only rating fails for defenders.
    positional: true,
    // The floor under everyone. Deliberately the smallest weight: it is the
    // most position-biased input, and leaning on it is precisely the mistake
    // Phase B exists to correct. It still matters — it separates players whose
    // careers left no award footprint at all, which is most of the database.
    score(p, ctx) {
      if (p.ratingRaw == null) return null;
      const { rawLo, rawHi } = ctx;
      return clamp01((p.ratingRaw - rawLo) / (rawHi - rawLo));
    },
  },
];

// ── Goalkicking honours: an additive BONUS, not a weighted input ────────────
//
// Deliberately outside the weighted mean. As an input it would be scored 0 for
// every key defender and half-back, so not kicking goals would actively drag
// their composite down — re-introducing the exact positional penalty B.2
// exists to remove, through the back door. A defender who never features in
// the goalkicking honours has told us nothing about how well they defended.
//
// As a bonus it can only ever add. Winning the league goalkicking three times
// in a decade is worth the full COLEMAN_BONUS_MAX; not featuring costs
// nothing. This is also the signal that carries the 1970s, where the Brownlow
// term does not exist: it is derived from the corpus, so every era has it.
const COLEMAN_BONUS_MAX = 0.12;

function colemanBonus(p) {
  const wins  = p.colemanWins  || 0;
  const top3  = p.colemanTop3  || 0;
  const top10 = p.colemanTop10 || 0;
  // Tiered so a Coleman win counts far more than a top-10 finish, and the
  // tiers don't double-count (top3 includes wins, top10 includes top3).
  const s = wins * 1.0 + (top3 - wins) * 0.5 + (top10 - top3) * 0.2;
  return clamp01(s / 3) * COLEMAN_BONUS_MAX;
}

/**
 * Weighted mean over AVAILABLE inputs, renormalised by the weight actually
 * present. Returns the composite in [0,1] plus the per-input breakdown, which
 * is retained on the entry so any rating can be explained after the fact.
 */
function composite(scores) {
  let sum = 0, wsum = 0;
  for (const inp of INPUTS) {
    const s = scores[inp.key];
    if (s == null) continue;
    sum  += s * inp.weight;
    wsum += inp.weight;
  }
  return wsum === 0 ? 0 : sum / wsum;
}

module.exports = { INPUTS, composite, colemanBonus, countInDecade, DECADES, POSITIONS, clamp01 };

function run() {
  // ── Flatten, tagging each entry with its bucket context ───────────────────
  const flat = [];
  for (const [bucket, arr] of Object.entries(db)) {
    const decade = bucket.split('_')[1];
    for (const p of arr) { p._decade = decade; p._bucket = bucket; flat.push(p); }
  }

  const missingRaw = flat.filter(p => p.ratingRaw == null).length;
  if (missingRaw) {
    console.error(`${missingRaw} entries have no ratingRaw.`);
    console.error(`add_overall.js must run AFTER add_rating.js — see scripts/update_players.sh.`);
    process.exit(1);
  }

  // Anchors for the production term, from the live distribution.
  const raws = flat.map(p => p.ratingRaw).sort((a, b) => a - b);
  const ctx = {
    rawLo: raws[Math.floor(0.02 * (raws.length - 1))],
    rawHi: raws[Math.floor(0.98 * (raws.length - 1))],
  };

  // ── B.1: score every input on its native scale ────────────────────────────
  for (const p of flat) {
    p._scoresRaw = {};
    for (const inp of INPUTS) p._scoresRaw[inp.key] = inp.score(p, ctx);
    p._raw = clamp01(composite(p._scoresRaw) + colemanBonus(p));
  }

  reportInputAvailability(flat);

  // ── B.2: correct the positional bias inside the biased inputs ─────────────
  calibratePositions(flat);
  for (const p of flat) p._cal = clamp01(composite(p._scores) + colemanBonus(p));

  reportCalibration(flat);

  // ── B.3 ───────────────────────────────────────────────────────────────────
  normaliseByEra(flat);

  // Report before the cleanup below strips the working fields it reads.
  reportFinal(flat);

  const explain = process.argv.find(a => a.startsWith('--explain='));
  if (explain) explainPlayer(flat, explain.split('=').slice(1).join('='));

  // ── Persist ───────────────────────────────────────────────────────────────
  for (const p of flat) {
    p.overall = p._overall;
    // Retained so a rating is always explainable — which input carried it, and
    // which were unavailable. Stripped from the shipped bundle by
    // inline_players.js; nothing at runtime reads it.
    p.overallParts = p._parts;
    // Drop every working field. Enumerating by prefix rather than by name so
    // a new intermediate can't quietly leak into players.json (and from there
    // into the shipped bundle) just because someone forgot to list it here.
    for (const k of Object.keys(p)) if (k.startsWith('_')) delete p[k];
  }

  fs.writeFileSync(SRC, JSON.stringify(db, null, 2), 'utf8');
  console.log(`\nWrote ${SRC}`);
}

function reportInputAvailability(flat) {
  console.log('\n── B.1 composite inputs ──────────────────────────────────────');
  console.log('input                weight   available   note');
  for (const inp of INPUTS) {
    const n = flat.filter(p => p._scoresRaw[inp.key] != null).length;
    const pct = Math.round(100 * n / flat.length);
    let note = '';
    if (n === 0) note = 'TABLE ABSENT — weight redistributed';
    else if (pct < 100) note = 'partial — weight redistributed where absent';
    console.log(
      `${inp.label.padEnd(20)} ${String(inp.weight).padEnd(8)} ` +
      `${String(n).padStart(4)}/${flat.length} ${String(pct + '%').padStart(5)}   ${note}`);
  }
  const withBonus = flat.filter(p => colemanBonus(p) > 0).length;
  console.log(`${'Goalkicking honours'.padEnd(20)} +${COLEMAN_BONUS_MAX} max  ` +
              `${String(withBonus).padStart(4)}/${flat.length} ` +
              `${String(Math.round(100 * withBonus / flat.length) + '%').padStart(5)}   ` +
              `additive bonus — never penalises`);
}

// ── B.2: defender-bias calibration ──────────────────────────────────────────
/**
 * Vote-based awards systematically under-reward defenders. This is not a
 * modelling assumption — it is measured directly in this database: mean
 * Brownlow votes per club-decade run ~49 for midfielders against ~12 for key
 * defenders, a 4x gap that reflects what umpires reward (ball-winning) rather
 * than what defenders do. Left uncorrected, the composite would rank every
 * great defender below every average midfielder.
 *
 * The correction equalises each position's MEDIAN composite against the
 * database-wide median, then damps that correction by CALIBRATION_STRENGTH so
 * genuine positional differences in impact are not erased entirely — a full
 * correction would assert that the best small forward and the best midfielder
 * are equally valuable, which is its own distortion.
 *
 * Medians, not means, so a handful of outliers cannot set a whole position's
 * factor. Factors are clamped so no position can be rescaled beyond reason.
 */
const CALIBRATION_STRENGTH = 0.70;

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Percentile rank of `v` within an ascending array (0 = lowest, 1 = highest).
 */
function percentileOf(sortedAsc, v) {
  if (sortedAsc.length <= 1) return 1;
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedAsc[mid] < v) lo = mid + 1; else hi = mid; }
  let hi2 = lo;
  while (hi2 < sortedAsc.length && sortedAsc[hi2] === v) hi2++;
  // Midpoint of the tied run, so equal values share a percentile.
  return ((lo + hi2 - 1) / 2) / (sortedAsc.length - 1);
}

/**
 * Rewrites the position-biased inputs in place, replacing each with a blend of
 * its absolute score and the player's percentile rank WITHIN THEIR OWN
 * POSITION. Non-positional inputs pass through untouched.
 *
 * Applying the correction per-input rather than to the finished composite is
 * deliberate. An earlier version rescaled the final score by a per-position
 * factor; because the bias is concentrated in two inputs but the factor hit
 * every input at once, the correction needed to be so large it saturated its
 * own clamp (1.60x for key defenders) and then over-promoted the top of that
 * position rather than lifting its middle. It also amplified any position
 * mislabel into a rating error — a midfielder wrongly tagged KD was multiplied
 * to the top of the board, which is exactly how the Scott Thompson position
 * bug surfaced. Correcting inside the biased input avoids both failure modes.
 *
 * CALIBRATION_STRENGTH controls how far to go. At 1.0 each position's
 * distribution is identical, which asserts the best small forward and the best
 * midfielder are equally valuable — its own distortion. At 0 the defender bias
 * stands. 0.70 removes most of the bias while leaving genuine positional
 * differences in impact partly intact.
 */
function calibratePositions(flat) {
  // Per-position ascending distributions for each positional input.
  const dists = {};
  for (const inp of INPUTS) {
    if (!inp.positional) continue;
    dists[inp.key] = {};
    for (const pos of POSITIONS) {
      dists[inp.key][pos] = flat
        .filter(p => p.pos === pos && p._scoresRaw[inp.key] != null)
        .map(p => p._scoresRaw[inp.key])
        .sort((a, b) => a - b);
    }
  }

  for (const p of flat) {
    p._scores = {};
    for (const inp of INPUTS) {
      const v = p._scoresRaw[inp.key];
      if (v == null || !inp.positional) { p._scores[inp.key] = v; continue; }
      const pct = percentileOf(dists[inp.key][p.pos], v);
      p._scores[inp.key] = clamp01(v * (1 - CALIBRATION_STRENGTH) + pct * CALIBRATION_STRENGTH);
    }
    p._parts = {};
    for (const inp of INPUTS) {
      const v = p._scores[inp.key];
      p._parts[inp.key] = v == null ? null : Math.round(v * 1000) / 1000;
    }
  }
}

function reportCalibration(flat) {
  console.log('\n── B.2 defender-bias calibration ─────────────────────────────');
  console.log('Evidence — the bias, measured in this database. Mean Brownlow');
  console.log('votes per club-decade, by position (entries with the signal):');
  const mv = {};
  for (const pos of POSITIONS) {
    const g = flat.filter(p => p.pos === pos && p.decadeBrownlowGames > 0);
    mv[pos] = g.length ? g.reduce((n, p) => n + p.decadeBrownlow, 0) / g.length : 0;
    console.log(`  ${pos.padEnd(4)} ${mv[pos].toFixed(1).padStart(6)} votes   (n=${g.length})`);
  }
  const ratio = mv.MID / (mv.KD || 1);
  console.log(`\n  Midfielders poll ${ratio.toFixed(1)}x the votes of key defenders. That gap is`);
  console.log(`  what umpires reward, not a measure of how good defenders are.`);

  console.log(`\nEffect (strength ${CALIBRATION_STRENGTH}) — median composite by position:`);
  console.log('pos     n    before     after    change');
  for (const pos of POSITIONS) {
    const g = flat.filter(p => p.pos === pos);
    const before = median(g.map(p => p._raw));
    const after  = median(g.map(p => p._cal));
    const delta  = after - before;
    console.log(
      `${pos.padEnd(5)} ${String(g.length).padStart(3)}   ${before.toFixed(3).padStart(7)}   ` +
      `${after.toFixed(3).padStart(7)}   ${(delta >= 0 ? '+' : '') + delta.toFixed(3)}`);
  }
}

// ── B.3: per-era quantile normalisation ─────────────────────────────────────
/**
 * Makes eras comparable. Each player is ranked WITHIN their own decade, then
 * that percentile is read off the pooled cross-era distribution — so a decade
 * is judged on its own internal spread rather than against absolute values
 * that drift with how the game was played and recorded.
 *
 * This is what rescues the 1970s. Those entries have no Brownlow term at all,
 * so their raw composites sit systematically lower; comparing them directly
 * against the 2010s on absolute value would rate an entire era as second-rate
 * for a gap in record-keeping. Ranking within-decade is immune to that: what
 * carries across is a player's standing among their contemporaries.
 *
 * Every decade's top player is anchored to OVR_MAX, which encodes the
 * intended claim — each era's best is an all-time great — and keeps the draft
 * board competitive whichever decade the wheel lands on.
 *
 * Ported from the NBA original's normalize_2k_overalls_by_era.py.
 */
const OVR_MIN = 58;
const OVR_MAX = 99;

function normaliseByEra(flat) {
  // Pooled target distribution, on the calibrated composite.
  const pooled = flat.map(p => p._cal).sort((a, b) => a - b);
  const pooledAt = q => pooled[Math.min(pooled.length - 1, Math.max(0, Math.round(q * (pooled.length - 1))))];

  const pooledLo = pooledAt(0.0);
  const pooledHi = pooledAt(1.0);
  const span = pooledHi - pooledLo || 1;

  for (const dec of DECADES) {
    const group = flat.filter(p => p._decade === dec);
    if (!group.length) continue;
    const sorted = [...group].sort((a, b) => a._cal - b._cal);
    const n = sorted.length;
    sorted.forEach((p, i) => {
      // Percentile rank within the decade (0 = worst, 1 = best in era).
      const pct = n === 1 ? 1 : i / (n - 1);
      // Read that percentile off the pooled cross-era distribution.
      const target = pooledAt(pct);
      const unit = (target - pooledLo) / span;
      p._overall = Math.round(OVR_MIN + unit * (OVR_MAX - OVR_MIN));
    });
    // Anchor: each era's best is a 99.
    sorted[n - 1]._overall = OVR_MAX;
  }
}

function reportFinal(flat) {
  console.log('\n── B.3 era normalisation self-check ──────────────────────────');
  console.log('decade    n    min    p25    med    p75    max   (peak must be 99)');
  let bad = 0;
  for (const dec of DECADES) {
    const g = flat.filter(p => p._decade === dec).map(p => p._overall).sort((a, b) => a - b);
    if (!g.length) continue;
    const q = f => g[Math.floor(f * (g.length - 1))];
    const peak = g[g.length - 1];
    if (peak !== OVR_MAX) bad++;
    console.log(
      `${dec.padEnd(8)} ${String(g.length).padStart(3)} ${String(g[0]).padStart(6)} ` +
      `${String(q(0.25)).padStart(6)} ${String(q(0.5)).padStart(6)} ${String(q(0.75)).padStart(6)} ` +
      `${String(peak).padStart(6)}   ${peak === OVR_MAX ? 'ok' : 'FAIL'}`);
  }
  if (bad) {
    console.error(`\n${bad} decade(s) not anchored to ${OVR_MAX} — normalisation is broken.`);
    process.exit(1);
  }

  console.log('\nPosition spread after calibration + normalisation:');
  console.log('pos     n    min    med    max');
  for (const pos of POSITIONS) {
    const g = flat.filter(p => p.pos === pos).map(p => p._overall).sort((a, b) => a - b);
    if (!g.length) continue;
    console.log(
      `${pos.padEnd(5)} ${String(g.length).padStart(3)} ${String(g[0]).padStart(6)} ` +
      `${String(g[Math.floor(0.5 * (g.length - 1))]).padStart(6)} ${String(g[g.length - 1]).padStart(6)}`);
  }

  const all = flat.map(p => p._overall).sort((a, b) => a - b);
  const q = f => all[Math.floor(f * (all.length - 1))];
  console.log(`\nOverall distribution: min ${all[0]}  p50 ${q(0.5)}  p75 ${q(0.75)}  ` +
              `p90 ${q(0.9)}  p95 ${q(0.95)}  p99 ${q(0.99)}  max ${all[all.length - 1]}`);
  console.log('(These percentiles are the basis for the gameplay thresholds — see data/README.md.)');

  console.log('\nTop 20 by overall:');
  [...flat].sort((a, b) => b._overall - a._overall).slice(0, 20).forEach(p =>
    console.log(`  ${String(p._overall).padStart(3)}  ${p.name.padEnd(22)} ${p.pos.padEnd(4)} ${p._bucket}`));
}

function explainPlayer(flat, name) {
  const hits = flat.filter(p => p.name.toLowerCase().includes(name.toLowerCase()));
  console.log(`\n── explain: "${name}" ─────────────────────────────────────────`);
  if (!hits.length) { console.log('  no match'); return; }
  for (const p of hits) {
    console.log(`\n${p.name} — ${p._bucket} (${p.pos}) → overall ${p._overall}`);
    for (const inp of INPUTS) {
      const v = p._parts[inp.key];
      console.log(`  ${inp.label.padEnd(20)} w=${inp.weight}  ` +
                  (v == null ? 'UNAVAILABLE (weight redistributed)' : v.toFixed(3)));
    }
    console.log(`  ${'Goalkicking bonus'.padEnd(20)} +${colemanBonus(p).toFixed(3)} ` +
                `(${p.colemanWins || 0} led / ${p.colemanTop3 || 0} top-3 / ${p.colemanTop10 || 0} top-10)`);
    console.log(`  raw ${p._raw.toFixed(3)} → calibrated ${p._cal.toFixed(3)} → overall ${p._overall}`);
  }
}

// Entry point last: run() reads consts declared throughout this file, so
// invoking it earlier would hit the temporal dead zone.
if (require.main === module) run();
