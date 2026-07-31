/**
 * scripts/afl_build_seasons.mjs — Stage 1 of the players.json pipeline.
 *
 * Reduces the vendored per-GAME corpus into per-(player, club, decade)
 * BEST-SEASON lines, which is the unit the game actually plays on.
 *
 *   source row  = one player, one game
 *   output row  = one player, one club, one decade  (their best season in it)
 *
 * Run:  node scripts/afl_build_seasons.mjs
 * In:   vendor/afl-data/data/players/*.csv   (bash scripts/afl_vendor_data.sh)
 * Out:  vendor/afl-seasons.json              (intermediate, gitignored)
 *
 * ── Why best season and not a decade average ────────────────────────────────
 * A decade average is a number no player ever actually posted. The audit
 * rubric requires each entry to be a real season that player had at that
 * club, and "best season" also matches the all-time-team fantasy the game is
 * built on. Seasons under MIN_GAMES are ineligible so a 3-game cameo can't
 * win a bucket on a fluke average.
 *
 * ── Blank semantics (docs/afl-build-out-plan.md §0.3 / A.4) ─────────────────
 * This is the load-bearing part of this script. A blank cell in the source
 * means two different things depending on the column, and conflating them
 * silently poisons era normalisation downstream:
 *
 *   ZERO_BLANK  — goals, behinds, hit_outs, brownlow_votes.
 *                 Blank is a genuine ZERO. Most players don't kick a goal,
 *                 ruck a contest, or poll a vote in a given game. Counting
 *                 these as "missing" would inflate every average.
 *
 *   MISSING_BLANK — disposals, marks, tackles, clearances.
 *                 Blank means NOT RECORDED for that game. Tackles aren't in
 *                 the data before 1987 and clearances before ~1998; a player
 *                 who took the field always had *some* disposals. Averaging
 *                 must skip these rows, never treat them as 0 — otherwise
 *                 every 1970s player looks like a non-tackler.
 *
 * A season whose stat has NO recorded games at all emits `null` for that
 * stat, which stage 2 (afl_build_db.mjs) imputes and stamps as `imputed`.
 *
 * ── The Brownlow exception: an ERA-BOUNDED zero-blank ───────────────────────
 * `brownlow_votes` is zero-blank only from 1984 onward. Before that the column
 * is blank for EVERY row in the corpus — measured, not assumed: 8,028 sampled
 * 1970-83 game rows carry zero non-empty vote values, while 1984-2024 rows
 * carry them normally. AFL Tables only publishes per-game Brownlow votes back
 * to 1984.
 *
 * So for 1970-1983 a blank means NOT RECORDED, exactly like a missing-blank —
 * the same cell, in the same column, means different things either side of the
 * boundary. Treating it as a genuine zero would encode "no 1970s player ever
 * polled a Brownlow vote", which is false and would make an entire era look
 * like journeymen to any rating that reads this signal.
 *
 * Each season row therefore carries `brownlowRecorded`, and consumers MUST
 * branch on it rather than reading a 0 at face value. See BROWNLOW_FIRST_YEAR.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT   = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC    = path.join(ROOT, 'vendor', 'afl-data', 'data', 'players');
const OUT    = path.join(ROOT, 'vendor', 'afl-seasons.json');

// Only decades the game ships. 1960s is deliberately excluded: measured
// coverage is ~51% disposals / 46% marks / 0% tackles, too thin to field a
// fair board (docs/afl-build-out-plan.md §0.3, port plan D5).
const MIN_YEAR = 1970;
const MAX_YEAR = 2029;

// A season must be a real body of work to represent a player-club-decade.
const MIN_GAMES = 8;

// ── Column classification (see header) ──────────────────────────────────────
const ZERO_BLANK    = new Set(['goals', 'behinds', 'hit_outs', 'brownlow_votes']);
const MISSING_BLANK = new Set(['disposals', 'marks', 'tackles', 'clearances',
                               'kicks', 'handballs', 'rebound_50s', 'inside_50s',
                               'contested_possessions', 'contested_marks',
                               'marks_inside_50', 'one_percenters', 'goal_assist']);

// Per-game stats we average. hitouts is display/synergy-only (port plan D4)
// but still needs a real value for rucks.
const AVG_STATS = [
  'disposals', 'goals', 'marks', 'tackles', 'clearances', 'hit_outs',
  'kicks', 'handballs', 'rebound_50s', 'inside_50s',
  'contested_possessions', 'contested_marks', 'marks_inside_50', 'one_percenters',
];
// Season totals (not averaged) — these are career/season signals, not rates.
const SUM_STATS = ['brownlow_votes'];

// First season for which the source records Brownlow votes at all. Before this
// the column is uniformly blank and a 0 total is an ARTEFACT, not a result.
// See the header note; `brownlowRecorded` on each row carries this downstream.
const BROWNLOW_FIRST_YEAR = 1984;

/**
 * Source club name → the game's bucket-key club, plus the era-accurate
 * display name where they differ (port plan §3.1).
 *
 * Fitzroy folds into the Brisbane Lions bucket: the clubs merged in 1997 and
 * the Lions carry the combined lineage. Brisbane Bears likewise.
 */
const CLUB_MAP = {
  'Adelaide':               { club: 'Adelaide' },
  'Brisbane Lions':         { club: 'BrisbaneLions' },
  'Brisbane Bears':         { club: 'BrisbaneLions',   eraClubName: 'Brisbane Bears' },
  'Fitzroy':                { club: 'BrisbaneLions',   eraClubName: 'Fitzroy' },
  'Carlton':                { club: 'Carlton' },
  'Collingwood':            { club: 'Collingwood' },
  'Essendon':               { club: 'Essendon' },
  'Fremantle':              { club: 'Fremantle' },
  'Geelong':                { club: 'Geelong' },
  'Gold Coast':             { club: 'GoldCoast' },
  'Greater Western Sydney': { club: 'GWS' },
  'Hawthorn':               { club: 'Hawthorn' },
  'Melbourne':              { club: 'Melbourne' },
  'North Melbourne':        { club: 'NorthMelbourne' },
  'Kangaroos':              { club: 'NorthMelbourne', eraClubName: 'Kangaroos' },
  'Port Adelaide':          { club: 'PortAdelaide' },
  'Richmond':               { club: 'Richmond' },
  'St Kilda':               { club: 'StKilda' },
  'Sydney':                 { club: 'Sydney' },
  'South Melbourne':        { club: 'Sydney',          eraClubName: 'South Melbourne' },
  'West Coast':             { club: 'WestCoast' },
  'Footscray':              { club: 'WesternBulldogs', eraClubName: 'Footscray' },
  'Western Bulldogs':       { club: 'WesternBulldogs' },
};

/** Minimal CSV split — this corpus has no quoted/embedded commas in the columns we read. */
function splitRow(line) { return line.split(','); }

/** games_played carries stray markers in the source (e.g. "2↑"). Keep digits only. */
function toInt(v) {
  if (v == null) return null;
  const m = String(v).match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}
function toNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === 'NA') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const r1 = n => (n == null ? null : Math.round(n * 10) / 10);

function readPersonal(file) {
  try {
    const L = fs.readFileSync(file, 'utf8').trim().split('\n');
    if (L.length < 2) return null;
    const H = L[0].split(',');
    const r = splitRow(L[1]);
    const get = k => { const i = H.indexOf(k); return i >= 0 ? (r[i] || '').trim() : ''; };
    const first = get('first_name'), last = get('last_name');
    if (!first && !last) return null;
    return {
      name: `${first} ${last}`.trim(),
      born: get('born_date'),
      debut: get('debut_date'),
      height: toInt(get('height')),
      weight: toInt(get('weight')),
    };
  } catch { return null; }
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Missing vendored corpus at ${SRC}\nRun: bash scripts/afl_vendor_data.sh`);
    process.exit(1);
  }

  const files = fs.readdirSync(SRC).filter(f => f.endsWith('_performance_details.csv'));
  console.log(`Reading ${files.length} player files from vendor/afl-data …`);

  const seasons = [];
  const unmappedClubs = new Map();
  let playersSeen = 0, rowsRead = 0, seasonsKept = 0, seasonsDroppedGames = 0;

  for (const pf of files) {
    const stem = pf.replace(/_performance_details\.csv$/, '');
    const personal = readPersonal(path.join(SRC, `${stem}_personal_details.csv`));
    if (!personal) continue;
    playersSeen++;

    let txt;
    try { txt = fs.readFileSync(path.join(SRC, pf), 'utf8'); } catch { continue; }
    const L = txt.split('\n');
    if (L.length < 2) continue;
    const H = L[0].split(',').map(s => s.trim());
    const col = Object.fromEntries(H.map((h, i) => [h, i]));
    if (col.team == null || col.year == null) continue;

    // Bucket every game row by (club, year) — the season is the unit we reduce to.
    /** @type {Map<string, {club:string, eraClubName?:string, year:number, rows:string[][]}>} */
    const byClubYear = new Map();

    for (let i = 1; i < L.length; i++) {
      if (!L[i]) continue;
      const r = splitRow(L[i]);
      if (r.length < 5) continue;
      const year = toInt(r[col.year]);
      if (year == null || year < MIN_YEAR || year > MAX_YEAR) continue;
      const rawClub = (r[col.team] || '').trim();
      const mapped = CLUB_MAP[rawClub];
      if (!mapped) { unmappedClubs.set(rawClub, (unmappedClubs.get(rawClub) || 0) + 1); continue; }
      rowsRead++;
      const key = `${mapped.club}|${year}`;
      if (!byClubYear.has(key)) byClubYear.set(key, { ...mapped, year, rows: [] });
      byClubYear.get(key).rows.push(r);
    }

    for (const { club, eraClubName, year, rows } of byClubYear.values()) {
      const games = rows.length;
      if (games < MIN_GAMES) { seasonsDroppedGames++; continue; }

      const line = { games };

      for (const stat of AVG_STATS) {
        const ci = col[stat];
        if (ci == null) { line[stat] = null; continue; }
        let sum = 0, n = 0;
        for (const r of rows) {
          const raw = r[ci];
          const v = toNum(raw);
          if (v == null) {
            // Blank. Meaning depends on the column — see file header.
            if (ZERO_BLANK.has(stat)) { sum += 0; n++; }
            // MISSING_BLANK: skip the row entirely (not recorded).
          } else { sum += v; n++; }
        }
        line[stat] = n > 0 ? sum / n : null;   // null => no recorded games => impute later
        line[`${stat}__recorded`] = n;
      }

      for (const stat of SUM_STATS) {
        const ci = col[stat];
        if (ci == null) { line[stat] = 0; continue; }
        let sum = 0;
        for (const r of rows) sum += (toNum(r[ci]) ?? 0);   // blank = 0 vote
        line[stat] = sum;
      }

      // Finals appearances in this season — a real "big finals" signal for traits.
      const isFinal = r => /^(EF|QF|SF|PF|GF)$/.test(String(r[col.round] || '').toUpperCase().trim());
      const finals = rows.filter(isFinal).length;

      // Home-and-away goal TOTAL, for the Coleman Medal / leading-goalkicker
      // signal. Deliberately a total, not the per-game average already in
      // AVG_STATS: the award goes to the season's highest aggregate, so a
      // 22-game 3-a-game season must outrank a 9-game 4-a-game one. Finals
      // are excluded because the Coleman counts home-and-away goals only.
      let goalsHA = 0;
      if (col.goals != null) {
        for (const r of rows) if (!isFinal(r)) goalsHA += (toNum(r[col.goals]) ?? 0);
      }

      seasons.push({
        playerKey: stem,
        name: personal.name,
        born: personal.born,
        debut: personal.debut,
        height: personal.height,
        weight: personal.weight,
        club,
        ...(eraClubName ? { eraClubName } : {}),
        year,
        decade: `${Math.floor(year / 10) * 10}s`,
        games,
        finals,
        goalsHA,
        disposals:  r1(line.disposals),
        goals:      r1(line.goals),
        marks:      r1(line.marks),
        tackles:    r1(line.tackles),
        clearances: r1(line.clearances),
        hitouts:    r1(line.hit_outs),
        kicks:      r1(line.kicks),
        handballs:  r1(line.handballs),
        rebound50s: r1(line.rebound_50s),
        inside50s:  r1(line.inside_50s),
        contestedPoss:  r1(line.contested_possessions),
        contestedMarks: r1(line.contested_marks),
        marksInside50:  r1(line.marks_inside_50),
        onePercenters:  r1(line.one_percenters),
        brownlow:   line.brownlow_votes,
        // Whether a Brownlow total of 0 is a RESULT or an ARTEFACT. Pre-1984
        // the source records no votes at all, so consumers must not read the
        // 0 as "polled nothing". See BROWNLOW_FIRST_YEAR.
        brownlowRecorded: year >= BROWNLOW_FIRST_YEAR,
        recorded: {
          disposals:  line.disposals__recorded  ?? 0,
          marks:      line.marks__recorded      ?? 0,
          tackles:    line.tackles__recorded    ?? 0,
          clearances: line.clearances__recorded ?? 0,
          hitouts:    line.hit_outs__recorded   ?? 0,
        },
      });
      seasonsKept++;
    }
  }

  // ── Assert the Brownlow coverage boundary still matches the source ────────
  // BROWNLOW_FIRST_YEAR is a claim about the data, so verify it rather than
  // trusting it. If a source refresh ever backfills pre-1984 votes this fires,
  // and the constant (plus the composite that keys off it) should be revisited
  // — that would be good news worth acting on, not a failure to suppress.
  {
    const pre  = seasons.filter(s => s.year <  BROWNLOW_FIRST_YEAR);
    const post = seasons.filter(s => s.year >= BROWNLOW_FIRST_YEAR);
    const preVotes  = pre.reduce((n, s) => n + (s.brownlow || 0), 0);
    const postVoters = post.filter(s => (s.brownlow || 0) > 0).length;
    if (preVotes > 0) {
      console.warn(`\n!! Brownlow coverage changed: ${preVotes} votes now present before ${BROWNLOW_FIRST_YEAR}.`);
      console.warn(`   Revisit BROWNLOW_FIRST_YEAR here and the coverage branch in scripts/add_overall.js.`);
    }
    if (postVoters === 0) {
      console.error(`\nBrownlow coverage check FAILED: no player polls a vote in ${BROWNLOW_FIRST_YEAR}+.`);
      console.error(`The brownlow_votes column is not being read. Refusing to write a voteless corpus.`);
      process.exit(1);
    }
    console.log(`Brownlow coverage: 0 votes pre-${BROWNLOW_FIRST_YEAR} (expected), ${postVoters.toLocaleString()} vote-polling seasons after.`);
  }

  fs.writeFileSync(OUT, JSON.stringify(seasons));

  // ── Report ───────────────────────────────────────────────────────────────
  console.log(`\nPlayers with personal details : ${playersSeen}`);
  console.log(`Game rows in ${MIN_YEAR}-${MAX_YEAR}      : ${rowsRead.toLocaleString()}`);
  console.log(`Seasons kept (>=${MIN_GAMES} games)     : ${seasonsKept.toLocaleString()}`);
  console.log(`Seasons dropped (<${MIN_GAMES} games)   : ${seasonsDroppedGames.toLocaleString()}`);

  if (unmappedClubs.size) {
    console.log('\n!! UNMAPPED CLUB NAMES (rows skipped) — add to CLUB_MAP:');
    [...unmappedClubs.entries()].sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  "${k}"`));
  }

  // Blank-semantics evidence: how many seasons have NO recorded value per stat,
  // by decade. This is what stage 2 has to impute.
  const byDec = {};
  for (const s of seasons) {
    byDec[s.decade] ||= { n: 0, tackles: 0, clearances: 0, disposals: 0, marks: 0 };
    byDec[s.decade].n++;
    for (const st of ['tackles', 'clearances', 'disposals', 'marks']) {
      if (s.recorded[st] === 0) byDec[s.decade][st]++;
    }
  }
  console.log('\nSeasons with ZERO recorded games for a stat (=> needs imputation):');
  console.log('decade  seasons   tackles  clearances   disposals     marks');
  for (const d of Object.keys(byDec).sort()) {
    const b = byDec[d];
    const p = k => `${((b[k] / b.n) * 100).toFixed(0)}%`.padStart(10);
    console.log(`${d.padEnd(8)}${String(b.n).padStart(7)}${p('tackles')}${p('clearances')}${p('disposals')}${p('marks')}`);
  }
  console.log(`\nWrote ${OUT}`);
}

main();
