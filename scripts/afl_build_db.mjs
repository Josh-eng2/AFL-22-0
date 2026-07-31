/**
 * scripts/afl_build_db.mjs — Stage 2 of the players.json pipeline.
 *
 * Takes the per-season lines from afl_build_seasons.mjs and produces the
 * shipped players.json: best season per (player, club, decade), curated to a
 * draftable board per bucket, with positions, archetypes, traits, and
 * imputed values for stats the era never recorded.
 *
 * Run:  node scripts/afl_build_db.mjs [--review]
 *   --review  also writes docs/player-data-audit/position-review.md
 *
 * In:   vendor/afl-seasons.json
 * Out:  players.json  (+ optional review artifact)
 *
 * Implements build-out plan A.3 (curation), A.4 (imputation), A.6
 * (archetypes/traits). Positions come from afl_positions.mjs (A.5).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePosition, POSITIONS, fixName, NAME_BY_KEY, NAME_PREFIX_FIX,
         POSITION_OVERRIDES } from './afl_positions.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN   = path.join(ROOT, 'vendor', 'afl-seasons.json');
const OUT  = path.join(ROOT, 'players.json');
const REVIEW = path.join(ROOT, 'docs', 'player-data-audit', 'position-review.md');

const DECADES = ['1970s', '1980s', '1990s', '2000s', '2010s', '2020s'];

// Club → first year it existed under this bucket identity. Mirrors
// CLUB_FIRST_YEAR in validate_players.js; a bucket is legal if the decade
// overlaps the club's lifetime.
const CLUB_FIRST_YEAR = {
  WestCoast: 1987, BrisbaneLions: 1987, Adelaide: 1991,
  Fremantle: 1995, PortAdelaide: 1997, GoldCoast: 2011, GWS: 2012,
};

// Target board size per bucket. The NBA original ships ~937 entries across
// 178 buckets (~5.3/bucket); 18 clubs x 6 decades minus illegal combos is
// ~93 buckets, so 8-10 per bucket lands in the same 800-1000 range.
const TARGET_PER_BUCKET = 9;
const MIN_PER_BUCKET    = 5;

// ── Provisional quality composite ───────────────────────────────────────────
// PROVISIONAL, and deliberately so: the real `overall` composite (Brownlow +
// All-Australian + B&F + Coleman, era-normalised, defender-bias corrected) is
// Phase B. This exists only to RANK candidates for curation — which players
// make the board — not to set the rating the game plays on. add_rating.js
// still computes `rating`/`overall` from the stat line downstream.
function qualityScore(cd) {
  const s = cd.best;
  const statPart =
      (s.disposals  ?? 0) * 0.35 +
      (s.goals      ?? 0) * 2.20 +
      (s.marks      ?? 0) * 0.55 +
      (s.tackles    ?? 0) * 0.65 +
      (s.clearances ?? 0) * 0.85 +
      (s.hitouts    ?? 0) * 0.12;
  // Brownlow votes across the club-decade: the one era-neutral quality signal
  // present in the source for every decade we ship.
  const brownlowPart = Math.min(cd.decadeBrownlow, 40) * 0.9;
  // Longevity at the club in that decade — stops a one-year wonder outranking
  // a decade-defining champion on a single hot season.
  const gamesPart = Math.min(cd.decadeGames, 200) * 0.055;
  const finalsPart = Math.min(cd.decadeFinals, 25) * 0.35;
  return statPart + brownlowPart + gamesPart + finalsPart;
}

/**
 * Stamps each season row with its league-wide home-and-away goalkicking rank
 * for that year (1 = led the league, i.e. won the Coleman). Seasons with no
 * goals get null rather than a rank, so "didn't kick a goal" never reads as
 * "finished last but ranked".
 */
function computeGoalkickingRanks(seasons) {
  const byYear = new Map();
  for (const s of seasons) {
    if (!byYear.has(s.year)) byYear.set(s.year, []);
    byYear.get(s.year).push(s);
  }
  for (const rows of byYear.values()) {
    rows.sort((a, b) => (b.goalsHA || 0) - (a.goalsHA || 0));
    // Standard competition ranking: equal totals share a rank.
    let rank = 0, prevTotal = null;
    rows.forEach((r, i) => {
      const total = r.goalsHA || 0;
      if (total !== prevTotal) { rank = i + 1; prevTotal = total; }
      r.gkRank = total > 0 ? rank : null;
    });
  }
}

/** Slug for stable player ids. */
function slug(name) {
  return name.toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ── A.4: imputation of stats the era never recorded ─────────────────────────
/**
 * Builds per-(position, decade) medians from the earliest decades where a
 * stat IS recorded, so a 1970s midfielder gets a midfielder's tackle count
 * rather than a league-wide average or (far worse) a zero.
 */
function buildImputationTable(rows) {
  const byPosDec = {};
  for (const r of rows) {
    const k = `${r.pos}|${r.best.decade}`;
    byPosDec[k] ||= { tackles: [], clearances: [] };
    if (r.best.tackles    != null) byPosDec[k].tackles.push(r.best.tackles);
    if (r.best.clearances != null) byPosDec[k].clearances.push(r.best.clearances);
  }
  const med = a => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const table = {};
  for (const [k, v] of Object.entries(byPosDec)) {
    table[k] = { tackles: med(v.tackles), clearances: med(v.clearances) };
  }
  // Per-position fallback across all decades, for (pos, decade) pairs with
  // no recorded data at all (e.g. every 1970s bucket).
  const byPos = {};
  for (const r of rows) {
    byPos[r.pos] ||= { tackles: [], clearances: [] };
    if (r.best.tackles    != null) byPos[r.pos].tackles.push(r.best.tackles);
    if (r.best.clearances != null) byPos[r.pos].clearances.push(r.best.clearances);
  }
  const posFallback = {};
  for (const [p, v] of Object.entries(byPos)) {
    posFallback[p] = { tackles: med(v.tackles), clearances: med(v.clearances) };
  }
  return { table, posFallback };
}

/**
 * Fills a missing stat from the nearest recorded decade for that position,
 * scaled by the era's disposal trend so a 1975 tackle count isn't just a
 * 2015 tackle count copied across.
 *
 * Era scaling mirrors js/logic/era.js's DISPOSAL_LEAGUE_AVG shape (volume
 * rose into the 2010s), applied in reverse: earlier eras get proportionally
 * fewer of these possession-linked acts.
 */
const ERA_VOLUME = { '1970s': 0.86, '1980s': 0.88, '1990s': 0.94, '2000s': 0.99, '2010s': 1.03, '2020s': 1.00 };

function imputeStat(stat, pos, decade, imp) {
  // Prefer the same position in the nearest decade that has real data.
  const order = [...DECADES].sort((a, b) =>
    Math.abs(DECADES.indexOf(a) - DECADES.indexOf(decade)) -
    Math.abs(DECADES.indexOf(b) - DECADES.indexOf(decade)));
  let base = null, baseDec = null;
  for (const d of order) {
    const v = imp.table[`${pos}|${d}`]?.[stat];
    if (v != null) { base = v; baseDec = d; break; }
  }
  if (base == null) { base = imp.posFallback[pos]?.[stat]; baseDec = '2010s'; }
  if (base == null) return null;
  const scale = (ERA_VOLUME[decade] ?? 1) / (ERA_VOLUME[baseDec] ?? 1);
  return Math.round(base * scale * 10) / 10;
}

// ── A.6: archetypes ─────────────────────────────────────────────────────────
function assignArchetype(s, pos) {
  const disp = s.disposals ?? 0, gls = s.goals ?? 0, mks = s.marks ?? 0;
  const hit = s.hitouts ?? 0, tck = s.tackles ?? 0, clr = s.clearances ?? 0;

  if (pos === 'RUC') return hit >= 15 ? 'Ruck Bull' : (gls >= 1.0 ? 'Power Forward' : 'Ruck Bull');
  if (pos === 'KF')  return mks >= 5.5 ? 'Power Forward' : (gls >= 2.0 ? 'Power Forward' : 'Intercept Marker');
  if (pos === 'SF')  return gls >= 1.0 ? 'Goal Sneak' : (tck >= 3.0 ? 'Lockdown Defender' : 'Goal Sneak');
  if (pos === 'KD')  return mks >= 4.5 ? 'Intercept Marker' : 'Lockdown Defender';
  if (pos === 'HB')  return disp >= 20 ? 'Ball Magnet' : (mks >= 4.5 ? 'Intercept Marker' : 'Lockdown Defender');
  // MID
  if (disp >= 22 || clr >= 4.5) return 'Ball Magnet';
  if (gls >= 1.5) return 'Goal Sneak';
  if (tck >= 4.0) return 'Lockdown Defender';
  return 'Ball Magnet';
}

// ── A.6: traits (2-3 from the port plan §3.4 vocabulary) ────────────────────
const ALL_TRAITS = new Set([
  'Big Game Player', 'Elite Kick', 'Elite Disposal', 'Volume Goalkicker',
  'Intercept King', 'Team Man', 'Ball Winner', 'Onball General',
  'Run and Carry', 'Contested Marker', 'Hit-out Machine', 'Aerialist',
  'Set Shot Specialist', 'One-Club Champion', 'Ruck-Forward', 'Bag Hunter',
  'Pressure Machine', 'Tagger', 'Big Finals Performer', 'Line-Breaker',
  'Shutdown Back',
]);

function assignTraits(cd, s, pos, archetype) {
  const cand = [];
  const push = (t, w) => { if (ALL_TRAITS.has(t)) cand.push([t, w]); };

  const disp = s.disposals ?? 0, gls = s.goals ?? 0, mks = s.marks ?? 0;
  const tck = s.tackles ?? 0, clr = s.clearances ?? 0, hit = s.hitouts ?? 0;

  // Quality / recognition signals
  if (cd.decadeBrownlow >= 12) push('Ball Winner', 10);
  if (cd.decadeBrownlow >= 6)  push('Elite Disposal', 7);
  if (cd.decadeFinals   >= 8)  push('Big Finals Performer', 8);
  if (cd.decadeFinals   >= 4)  push('Big Game Player', 6);
  if (cd.oneClub && cd.careerGames >= 150) push('One-Club Champion', 9);

  // Role signals
  if (hit >= 20)               push('Hit-out Machine', 11);
  if (pos === 'RUC' && gls >= 0.8) push('Ruck-Forward', 7);
  if (gls >= 2.5)              push('Bag Hunter', 10);
  if (gls >= 1.5)              push('Volume Goalkicker', 8);
  if (gls >= 1.0 && pos === 'SF') push('Set Shot Specialist', 5);
  if (mks >= 6.0)              push('Contested Marker', 9);
  if (mks >= 5.0 && (pos === 'KF' || pos === 'RUC')) push('Aerialist', 6);
  if (pos === 'KD' && mks >= 4.5) push('Intercept King', 10);
  if (pos === 'KD' || pos === 'HB') push('Shutdown Back', 5);
  if (tck >= 4.5)              push('Pressure Machine', 8);
  if (tck >= 3.5 && pos === 'MID') push('Tagger', 4);
  if (clr >= 5.0)              push('Onball General', 9);
  if (disp >= 25)              push('Elite Disposal', 9);
  if (disp >= 20 && pos === 'HB') push('Run and Carry', 8);
  if ((s.rebound50s ?? 0) >= 3.5) push('Run and Carry', 7);
  if (gls >= 0.8 && pos === 'MID') push('Line-Breaker', 5);
  if ((s.kicks ?? 0) >= 13)    push('Elite Kick', 6);

  // Deterministic: sort by weight then name, dedupe, take 2-3.
  const seen = new Set(); const out = [];
  cand.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [t] of cand) { if (!seen.has(t)) { seen.add(t); out.push(t); } if (out.length === 3) break; }
  while (out.length < 2) {
    const filler = ['Team Man', 'Big Game Player', 'Elite Kick'].find(f => !seen.has(f));
    if (!filler) break;
    seen.add(filler); out.push(filler);
  }
  return out.slice(0, 3);
}

// ── popularity (kept simple; add_popularity.js NAMED table refines marquee) ─
function provisionalPopularity(cd) {
  const q = Math.min(cd.quality, 120) / 120;          // 0..1
  const brownlow = Math.min(cd.decadeBrownlow, 30) / 30;
  const raw = 35 + q * 40 + brownlow * 25;
  return Math.max(35, Math.min(99, Math.round(raw)));
}

function legalBucket(club, decade) {
  const first = CLUB_FIRST_YEAR[club];
  if (first == null) return true;
  return (parseInt(decade, 10) + 9) >= first;
}

function main() {
  const wantReview = process.argv.includes('--review');
  if (!fs.existsSync(IN)) {
    console.error(`Missing ${IN}\nRun: node scripts/afl_build_seasons.mjs`);
    process.exit(1);
  }
  const seasons = JSON.parse(fs.readFileSync(IN, 'utf8'));

  // Name repair, before anything keys off a name:
  //  1. NAME_BY_KEY disambiguates players who SHARE a name (Ablett Sr/Jr,
  //     both Josh Kennedys). Must happen first — position overrides and the
  //     engine's same-name draft guard both key on the final name.
  //  2. fixName restores apostrophes the source strips (OBrien -> O'Brien).
  //  3. NAME_PREFIX_FIX restores Dutch surname particles the source drops
  //     outright (Goey -> De Goey), which no rule can recover.
  const sourceNameByKey = new Map();
  for (const s of seasons) {
    sourceNameByKey.set(s.playerKey, fixName(s.name));
    s.name = NAME_BY_KEY[s.playerKey] ?? NAME_PREFIX_FIX[s.playerKey] ?? fixName(s.name);
  }
  assertNoOrphanedOverrides(sourceNameByKey);

  // ── Coleman Medal / leading-goalkicker rank, derived not sourced ──────────
  // The Coleman goes to the season's highest home-and-away goal aggregate,
  // which is a mechanical criterion we can apply directly to the corpus — so
  // this needs no external award table and carries no extra licensing risk.
  // Spot-checked against known winners: 1970/71 Hudson, 1983 Quinlan, 1991 &
  // 1998 Lockett, 2003 Lloyd, 2012 Riewoldt, 2017 Franklin, 2022 Curnow all
  // reproduce exactly.
  //
  // Two honest limits: the award was the "leading goalkicker" award before it
  // was named for Coleman in 1981, and a rank here reflects goals recorded in
  // this corpus for clubs we ship, so a tie or a missing club-season could in
  // principle shift a rank. It is used as a bounded bonus, never as a primary
  // term, so a rare off-by-one cannot move a rating far.
  computeGoalkickingRanks(seasons);

  // ── Career context per player (for one-club / longevity traits) ───────────
  const careerClubs = new Map(), careerGames = new Map();
  for (const s of seasons) {
    if (!careerClubs.has(s.playerKey)) careerClubs.set(s.playerKey, new Set());
    careerClubs.get(s.playerKey).add(s.club);
    careerGames.set(s.playerKey, (careerGames.get(s.playerKey) || 0) + s.games);
  }

  // ── Reduce to one candidate per (player, club, decade) ────────────────────
  /** @type {Map<string, any>} */
  const cds = new Map();
  for (const s of seasons) {
    if (!DECADES.includes(s.decade)) continue;
    if (!legalBucket(s.club, s.decade)) continue;
    const key = `${s.playerKey}|${s.club}|${s.decade}`;
    let cd = cds.get(key);
    if (!cd) {
      cd = {
        playerKey: s.playerKey, name: s.name, club: s.club, decade: s.decade,
        eraClubName: s.eraClubName, seasons: [],
        decadeGames: 0, decadeBrownlow: 0, decadeFinals: 0,
        decadeBrownlowGames: 0,
        colemanWins: 0, colemanTop3: 0, colemanTop10: 0,
      };
      cds.set(key, cd);
    }
    if (s.gkRank != null) {
      if (s.gkRank === 1) cd.colemanWins++;
      if (s.gkRank <= 3)  cd.colemanTop3++;
      if (s.gkRank <= 10) cd.colemanTop10++;
    }
    cd.seasons.push(s);
    cd.decadeGames    += s.games;
    cd.decadeBrownlow += s.brownlow || 0;
    cd.decadeFinals   += s.finals   || 0;
    // Games played inside the window where the source actually records votes.
    // This is the denominator that makes the Brownlow signal comparable, and
    // a 0 here means "no signal available", NOT "polled nothing" — the whole
    // 1970s and the 1980-83 seasons land in that case.
    if (s.brownlowRecorded) cd.decadeBrownlowGames += s.games;
    // Era name: prefer the identity the player actually played under most.
    if (s.eraClubName && !cd.eraClubName) cd.eraClubName = s.eraClubName;
  }

  // Pick the BEST single season in each club-decade (a real season, never an average).
  const statComposite = s =>
    (s.disposals ?? 0) * 0.35 + (s.goals ?? 0) * 2.2 + (s.marks ?? 0) * 0.55 +
    (s.tackles ?? 0) * 0.65 + (s.clearances ?? 0) * 0.85 + (s.hitouts ?? 0) * 0.12;

  const candidates = [];
  for (const cd of cds.values()) {
    cd.seasons.sort((a, b) => statComposite(b) - statComposite(a));
    cd.best = cd.seasons[0];
    cd.oneClub = careerClubs.get(cd.playerKey)?.size === 1;
    cd.careerGames = careerGames.get(cd.playerKey) || 0;
    // If the era-accurate club name differs, take it from the best season.
    if (cd.best.eraClubName) cd.eraClubName = cd.best.eraClubName;
    else if (cd.eraClubName && !cd.seasons.some(s => s.eraClubName)) delete cd.eraClubName;
    const rp = resolvePosition({ ...cd.best, name: cd.name, club: cd.club, decade: cd.decade });
    cd.pos = rp.pos; cd.posSource = rp.source; cd.posConf = rp.confidence; cd.posWhy = rp.why;
    cd.quality = qualityScore(cd);
    candidates.push(cd);
  }
  console.log(`Candidate player-club-decades: ${candidates.length.toLocaleString()}`);

  // ── A.4: imputation table built from REAL data only ───────────────────────
  const imp = buildImputationTable(candidates);

  // ── A.3: curate per bucket, with positional spread ────────────────────────
  const byBucket = new Map();
  for (const c of candidates) {
    const k = `${c.club}_${c.decade}`;
    if (!byBucket.has(k)) byBucket.set(k, []);
    byBucket.get(k).push(c);
  }

  // Every bucket must be draftable: the engine drafts KD/HB/MID/RUC/KF/SF, so
  // a board of six midfielders is a dead end. Seed one of each core role
  // (where the club-decade actually has one), then fill on quality.
  const CORE = ['KD', 'MID', 'RUC', 'KF'];
  const SECONDARY = ['HB', 'SF'];

  const db = {};
  const bucketStats = [];
  for (const [bucket, pool] of [...byBucket.entries()].sort()) {
    pool.sort((a, b) => b.quality - a.quality);
    const picked = [];
    const takenKeys = new Set();

    const take = c => { picked.push(c); takenKeys.add(c.playerKey); };

    // Seed core roles first.
    for (const role of [...CORE, ...SECONDARY]) {
      const c = pool.find(x => x.pos === role && !takenKeys.has(x.playerKey));
      if (c) take(c);
    }
    // Fill remaining slots by quality.
    for (const c of pool) {
      if (picked.length >= TARGET_PER_BUCKET) break;
      if (takenKeys.has(c.playerKey)) continue;
      take(c);
    }
    if (picked.length < MIN_PER_BUCKET) {
      bucketStats.push({ bucket, n: picked.length, thin: true });
      if (picked.length === 0) continue;
    } else {
      bucketStats.push({ bucket, n: picked.length, thin: false });
    }

    // ── Materialise entries ────────────────────────────────────────────────
    db[bucket] = picked
      .sort((a, b) => POSITIONS.indexOf(a.pos) - POSITIONS.indexOf(b.pos) || b.quality - a.quality)
      .map(c => {
        const s = c.best;
        const imputed = [];
        let tackles = s.tackles, clearances = s.clearances;
        if (tackles == null) {
          tackles = imputeStat('tackles', c.pos, c.decade, imp);
          if (tackles != null) imputed.push('tackles');
        }
        if (clearances == null) {
          clearances = imputeStat('clearances', c.pos, c.decade, imp);
          if (clearances != null) imputed.push('clearances');
        }
        const filled = { ...s, tackles, clearances };
        const archetype = assignArchetype(filled, c.pos);
        const traits = assignTraits(c, filled, c.pos, archetype);

        const entry = {
          id: `${slug(c.name)}_${String(s.year).slice(2)}`,
          name: c.name,
          pos: c.pos,
          disposals: s.disposals ?? 0,
          goals: s.goals ?? 0,
          marks: s.marks ?? 0,
          tackles: tackles ?? 0,
          clearances: clearances ?? 0,
          hitouts: s.hitouts ?? 0,
          archetype,
          traits,
          popularity: provisionalPopularity(c),
          season: s.year,
          games: s.games,
          // ── Career signals, persisted for Phase B ──────────────────────────
          // These come from the ~137 MB source corpus, which is gitignored.
          // Persisting them here is what lets scripts/add_overall.js rebuild
          // the award composite from the committed players.json alone, with no
          // vendored corpus present. Do not strip them.
          //   decadeBrownlow      — votes polled at this club this decade
          //   decadeBrownlowGames — games inside the vote-recording window
          //                         (0 => no Brownlow signal exists for this
          //                         entry; see BROWNLOW_FIRST_YEAR)
          //   decadeGames         — games played at this club this decade
          //   decadeFinals        — finals played at this club this decade
          //   seasonBrownlow      — votes polled in the single shipped season
          decadeBrownlow: c.decadeBrownlow,
          decadeBrownlowGames: c.decadeBrownlowGames,
          decadeGames: c.decadeGames,
          decadeFinals: c.decadeFinals,
          seasonBrownlow: s.brownlow || 0,
          careerGames: c.careerGames,
          oneClub: !!c.oneClub,
          //   coleman* — seasons finishing 1st / top-3 / top-10 in league
          //   home-and-away goalkicking while at this club this decade.
          //   Unlike the Brownlow this is available for every era we ship,
          //   which is what makes it the 1970s' main award signal.
          colemanWins: c.colemanWins,
          colemanTop3: c.colemanTop3,
          colemanTop10: c.colemanTop10,
        };
        if (c.eraClubName) entry.eraClubName = c.eraClubName;
        if (imputed.length) entry.imputed = imputed;
        return entry;
      });
  }

  // ── De-duplicate ids across the whole DB ─────────────────────────────────
  const idSeen = new Map();
  for (const [bucket, arr] of Object.entries(db)) {
    for (const e of arr) {
      if (!idSeen.has(e.id)) { idSeen.set(e.id, 1); continue; }
      const n = idSeen.get(e.id) + 1;
      idSeen.set(e.id, n);
      e.id = `${e.id}_${bucket.split('_')[0].toLowerCase().slice(0, 3)}${n}`;
    }
  }

  assertMarqueeSignals(db);

  fs.writeFileSync(OUT, JSON.stringify(db, null, 2));

  // ── Report ───────────────────────────────────────────────────────────────
  const buckets = Object.keys(db).length;
  const total = Object.values(db).reduce((n, a) => n + a.length, 0);
  console.log(`\nBuckets: ${buckets}   Entries: ${total}`);

  const perDec = {};
  const posCount = {};
  let imputedCount = 0, eraNameCount = 0;
  for (const [b, arr] of Object.entries(db)) {
    const d = b.split('_')[1];
    perDec[d] = (perDec[d] || 0) + arr.length;
    for (const e of arr) {
      posCount[e.pos] = (posCount[e.pos] || 0) + 1;
      if (e.imputed) imputedCount++;
      if (e.eraClubName) eraNameCount++;
    }
  }
  console.log('\nBy decade: ' + DECADES.map(d => `${d} ${perDec[d] || 0}`).join('  '));
  console.log('By position: ' + POSITIONS.map(p => `${p} ${posCount[p] || 0}`).join('  '));
  console.log(`Entries with imputed stats: ${imputedCount}`);
  console.log(`Entries with eraClubName  : ${eraNameCount}`);

  const thin = bucketStats.filter(b => b.thin);
  if (thin.length) {
    console.log(`\nThin buckets (<${MIN_PER_BUCKET}): ${thin.map(t => `${t.bucket}(${t.n})`).join(', ')}`);
  }

  // Position-source breakdown across shipped entries (how much is hand-reviewed).
  const shipped = new Set();
  for (const arr of Object.values(db)) for (const e of arr) shipped.add(e.name);
  const srcCount = { override: 0, 'override-decade': 0, heuristic: 0 };
  const lowConf = [];
  for (const c of candidates) {
    if (!shipped.has(c.name)) continue;
    srcCount[c.posSource] = (srcCount[c.posSource] || 0) + 1;
    if (c.posSource === 'heuristic' && c.posConf === 'low') lowConf.push(c);
  }
  console.log(`\nPosition source (shipped names): override ${srcCount.override + srcCount['override-decade']}, heuristic ${srcCount.heuristic}`);
  console.log(`Low-confidence heuristic calls  : ${lowConf.length}`);

  if (wantReview) writeReview(db, candidates, shipped);
  console.log(`\nWrote ${OUT}`);
}

// ── Rename/override collision tripwire ──────────────────────────────────────
/**
 * POSITION_OVERRIDES is keyed by FINAL player name, but NAME_BY_KEY rewrites
 * names to split players who share one. When a name is split, any override
 * still keyed on the old shared name is silently either dead or — much worse —
 * re-pointed at whichever player kept the bare name.
 *
 * That is not hypothetical. 'Scott Thompson' was overridden to KD for North
 * Melbourne's key defender; once the collision repair renamed him to
 * 'Scott D. Thompson', the override landed on Adelaide's 30-disposal
 * midfielder instead, shipping him as a key defender. It stayed invisible
 * until Phase B's positional calibration multiplied the error and pushed him
 * to the top of the board.
 *
 * So: any override keyed on a name that the rename layer has since split is
 * an error by construction. Fail rather than let it re-point silently.
 */
function assertNoOrphanedOverrides(sourceNameByKey) {
  const splitFrom = new Map();   // original shared name -> Set of final names
  for (const [key, finalName] of Object.entries(NAME_BY_KEY)) {
    const original = sourceNameByKey.get(key);
    if (!original) continue;
    if (!splitFrom.has(original)) splitFrom.set(original, new Set());
    splitFrom.get(original).add(finalName);
  }
  const orphans = Object.keys(POSITION_OVERRIDES).filter(
    name => splitFrom.has(name) && !splitFrom.get(name).has(name));

  if (orphans.length) {
    console.error('\nOrphaned position overrides (keyed on a name that has since been split):');
    for (const name of orphans) {
      console.error(`  - "${name}" -> ${POSITION_OVERRIDES[name]}   now split into: ` +
                    `${[...splitFrom.get(name)].join(' / ')}`);
    }
    console.error('\nRe-key each override onto the specific player it was meant for.');
    process.exit(1);
  }
}

// ── Marquee tripwire ────────────────────────────────────────────────────────
// The Brownlow/games signals are joined from the source corpus by playerKey,
// and a name repair, a club remap or a decade boundary change can silently
// sever that join — leaving a champion in the database with a zero career
// signal, which Phase B's composite would then read as "ordinary player".
// A zero here is indistinguishable from a genuine non-polling season, so it
// fails silently unless something asserts it doesn't.
//
// These are players whose Brownlow record is not in dispute. If any of them
// stops matching, the join is broken — fail the build rather than shipping a
// quietly wrong rating. Expected values are floors, not exact counts, so the
// tripwire survives a legitimate source refresh.
//
// Every entry here sits in the vote-recording era on purpose. A pre-1984
// champion (Leigh Matthews at Hawthorn in the 1970s is the canonical case)
// legitimately carries decadeBrownlow=0 because the source has no votes at
// all for those years — asserting a floor there would fail forever on data
// that is behaving correctly. `noBrownlowEra` covers that side instead: it
// asserts the entry exists and is uncovered, so the gap stays visible.
const MARQUEE = [
  { name: 'Wayne Carey',      bucket: 'NorthMelbourne_1990s', minBrownlow: 90 },
  { name: 'Robert Harvey',    bucket: 'StKilda_1990s',        minBrownlow: 120 },
  { name: 'Dustin Martin',    bucket: 'Richmond_2010s',       minBrownlow: 150 },
  { name: 'Gary Ablett Jr',   bucket: 'GoldCoast_2010s',      minBrownlow: 100 },
  { name: 'Gary Ablett Sr',   bucket: 'Geelong_1980s',        minBrownlow: 40 },
  { name: 'Scott Pendlebury', bucket: 'Collingwood_2010s',    minBrownlow: 150 },
  { name: 'Chris Judd',       bucket: 'WestCoast_2000s',      minBrownlow: 80 },
  // Pre-1984: assert the ABSENCE is the known coverage gap, not a lost join.
  { name: 'Leigh Matthews',   bucket: 'Hawthorn_1970s',       noBrownlowEra: true },
  { name: 'Kevin Bartlett',   bucket: 'Richmond_1970s',       noBrownlowEra: true },
];

function assertMarqueeSignals(db) {
  const problems = [];
  for (const m of MARQUEE) {
    const e = (db[m.bucket] || []).find(x => x.name === m.name);
    if (!e) { problems.push(`${m.name} is missing from ${m.bucket}`); continue; }
    if (!(e.decadeGames > 0)) {
      problems.push(`${m.name} (${m.bucket}) has decadeGames=${e.decadeGames} — the career-signal join is broken`);
    }
    if (m.noBrownlowEra) {
      // The point of these rows is that no vote signal should exist. If one
      // appears, the source has been backfilled and the composite's coverage
      // branch needs revisiting.
      if (e.decadeBrownlowGames > 0) {
        problems.push(`${m.name} (${m.bucket}) now has ${e.decadeBrownlowGames} vote-recorded games — the pre-1984 gap has closed; revisit BROWNLOW_FIRST_YEAR and add_overall.js`);
      }
      continue;
    }
    if (!(e.decadeBrownlow >= m.minBrownlow)) {
      problems.push(`${m.name} (${m.bucket}) has decadeBrownlow=${e.decadeBrownlow}, expected >= ${m.minBrownlow} — the career-signal join is broken`);
    }
    if (!(e.decadeBrownlowGames > 0)) {
      problems.push(`${m.name} (${m.bucket}) has decadeBrownlowGames=0 despite polling votes`);
    }
  }
  if (problems.length) {
    console.error('\nMarquee career-signal check FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nRefusing to write players.json with a severed career-signal join.');
    process.exit(1);
  }
  console.log(`Marquee career-signal check: ${MARQUEE.length}/${MARQUEE.length} OK`);
}

/** Review artifact: every shipped entry, its position, and how it was decided. */
function writeReview(db, candidates, shipped) {
  const byName = new Map();
  for (const c of candidates) byName.set(`${c.name}|${c.club}|${c.decade}`, c);

  let md = `# Position review — shipped database\n\n`;
  md += `Generated by \`node scripts/afl_build_db.mjs --review\`.\n\n`;
  md += `Every entry in \`players.json\`, the position it ships with, and how that\n`;
  md += `position was decided. \`override\` = hand-assigned in\n`;
  md += `\`scripts/afl_positions.mjs\`; \`heuristic\` = derived from the stat line.\n\n`;
  md += `Review protocol: scan for (a) any \`heuristic/low\` row whose name you\n`;
  md += `recognise, and (b) any row whose position contradicts its stat line\n`;
  md += `(e.g. high hitouts not marked RUC). Fix by adding to POSITION_OVERRIDES\n`;
  md += `and re-running.\n\n`;

  const lowRows = [];
  for (const [bucket, arr] of Object.entries(db).sort()) {
    md += `## ${bucket}\n\n`;
    md += `| pos | player | season | disp | gls | mks | tck | clr | hit | source | why |\n`;
    md += `|---|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const e of arr) {
      const c = byName.get(`${e.name}|${bucket.split('_')[0]}|${bucket.split('_')[1]}`);
      const src = c ? `${c.posSource}/${c.posConf}` : '?';
      const why = c ? c.posWhy : '';
      const imp = e.imputed ? ` _(imputed: ${e.imputed.join(', ')})_` : '';
      md += `| ${e.pos} | ${e.name}${imp} | ${e.season} | ${e.disposals} | ${e.goals} | ${e.marks} | ${e.tackles} | ${e.clearances} | ${e.hitouts} | ${src} | ${why} |\n`;
      if (c && c.posSource === 'heuristic' && c.posConf === 'low') lowRows.push({ bucket, e, c });
    }
    md += `\n`;
  }

  let head = `\n## Low-confidence heuristic calls (review these first)\n\n`;
  head += `| bucket | pos | player | disp | gls | mks | hit | why |\n|---|---|---|---|---|---|---|---|\n`;
  for (const { bucket, e, c } of lowRows) {
    head += `| ${bucket} | ${e.pos} | ${e.name} | ${e.disposals} | ${e.goals} | ${e.marks} | ${e.hitouts} | ${c.posWhy} |\n`;
  }
  head += `\n`;

  fs.mkdirSync(path.dirname(REVIEW), { recursive: true });
  fs.writeFileSync(REVIEW, md.replace('\n\n## ', head + '\n## '));
  console.log(`Wrote ${REVIEW} (${lowRows.length} low-confidence rows flagged)`);
}

main();
