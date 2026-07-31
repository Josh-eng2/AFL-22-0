'use strict';
/**
 * scripts/audit_stats.js — Realism triage for the player-data audit.
 *
 * This is NOT structural validation (that's validate_players.js). It's a
 * heuristic pass that surfaces LIKELY-wrong stat lines so an audit batch can
 * fix the worst offenders first instead of eyeballing 800+ rows blind. Every
 * flag is a *candidate for review*, not a proven error.
 *
 * Run:             node scripts/audit_stats.js
 * One decade only: node scripts/audit_stats.js --decade=1980
 *
 * Checks:
 *   1. DUP     — different players sharing an identical 5-stat line.
 *   2. SELFDUP — the same player with an identical line in two buckets.
 *   3. OUT     — a single stat beyond an era-aware plausibility ceiling.
 *   4. SUPER   — "superman" lines leading 3+ categories at once.
 *   5. IMPUTE  — imputation sanity: a stat flagged imputed that looks wrong,
 *                or an un-flagged stat sitting at exactly 0 in an era where
 *                that stat was not recorded (the A.4 blank-semantics trap).
 *
 * ── AFL note on DUP ──────────────────────────────────────────────────────────
 * Unlike the NBA original — where every entry was hand-entered and a duplicate
 * line meant copy-paste — these lines are machine-derived from real per-game
 * data, so an exact duplicate is far more likely to be a genuine coincidence
 * between two low-output players (a 1970s line is only three numbers wide:
 * disposals, goals, marks). DUP is reported for completeness but is low-signal
 * here; IMPUTE and OUT are the checks that matter.
 */
const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'players.json');
const db  = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const arg      = process.argv.find(a => a.startsWith('--decade='));
const onlyDec  = arg ? arg.split('=')[1].replace(/s$/, '') : null;

const DECADE_OF = key => (key.match(/_(\d{4})s$/) || [])[1];

const STATS = ['disposals', 'goals', 'marks', 'tackles', 'clearances'];

// ── Era-aware plausibility ceilings ───────────────────────────────────────────
// Set just ABOVE the real single-season per-game records so a flag means
// "beyond anything ever recorded" rather than merely "very good".
// Reference points: Tom Mitchell's 2018 (~35 disposals/gm) is the modern
// disposal peak; Peter Hudson/Bob Pratt averaged ~7.5 goals a game in their
// best years; ruck hitout seasons top out around 45-50.
function ceilings(decade) {
  const d = Number(decade);
  return {
    // Disposal volume rose over time, but NOT as much as intuition suggests:
    // the 1970s was kick-dominated and its best ball-winners posted huge
    // numbers (Wayne Richardson averaged 32.8 in 1971 off 27 kicks a game;
    // David Thorpe 31.4 the same year). Verified against the source before
    // setting this — an earlier ceiling of 32 flagged a real record.
    disposals:  d <= 1980 ? 35 : 38,
    goals:      8.5,
    marks:      14,
    tackles:    12,
    clearances: 13,
    hitouts:    52,
  };
}

const flat = [];
for (const [key, players] of Object.entries(db)) {
  const decade = DECADE_OF(key);
  if (onlyDec && decade !== onlyDec) continue;
  for (const p of players) flat.push({ ...p, _bucket: key, _decade: decade });
}

const findings = { DUP: [], SELFDUP: [], OUT: [], SUPER: [], IMPUTE: [] };

// ── 1 & 2: duplicate stat lines ───────────────────────────────────────────────
const lineKey = p => STATS.map(s => p[s]).join('|');
const byLine  = {};
for (const p of flat) (byLine[lineKey(p)] ||= []).push(p);
for (const [line, group] of Object.entries(byLine)) {
  if (group.length < 2) continue;
  const names = new Set(group.map(g => g.name));
  const entry = { line, players: group.map(g => `${g.name} (${g._bucket})`) };
  if (names.size > 1) findings.DUP.push(entry);
  else               findings.SELFDUP.push(entry);
}

// ── 3: single-stat outliers ───────────────────────────────────────────────────
for (const p of flat) {
  const c = ceilings(p._decade);
  for (const k of Object.keys(c)) {
    if ((p[k] ?? 0) > c[k]) {
      findings.OUT.push(`${p.name} (${p._bucket}): ${k} = ${p[k]} > ceiling ${c[k]}`);
    }
  }
}

// ── 4: "superman" lines — leading 3+ categories league-wide in their decade ───
const byDecade = {};
for (const p of flat) (byDecade[p._decade] ||= []).push(p);
for (const [dec, group] of Object.entries(byDecade)) {
  const leaders = {};
  for (const s of STATS) {
    // Rank on REAL values only. Imputed tackles/clearances are per-position
    // medians, so every top-ranked 1970s midfielder would otherwise "lead"
    // both of them by construction and trip this check meaninglessly.
    leaders[s] = group
      .filter(p => !(p.imputed || []).includes(s))
      .sort((a, b) => (b[s] ?? 0) - (a[s] ?? 0))
      .slice(0, 3).map(p => p.id);
  }
  for (const p of group) {
    const led = STATS.filter(s => leaders[s].includes(p.id));
    if (led.length >= 3) {
      findings.SUPER.push(`${p.name} (${p._bucket}) top-3 in ${led.join(', ')} for the ${dec}s`);
    }
  }
}

// ── 5: imputation sanity (the A.4 blank-semantics trap) ──────────────────────
// tackles were not recorded before 1987, clearances before ~1998. In those
// windows the value MUST be imputed — a bare 0 means the pipeline treated
// "not recorded" as "did nothing", which silently poisons era normalisation.
for (const p of flat) {
  const d = Number(p._decade);
  const imp = p.imputed || [];
  if (d <= 1980 && !imp.includes('tackles') && p.tackles === 0) {
    findings.IMPUTE.push(`${p.name} (${p._bucket}): tackles 0 and NOT imputed — tackles were unrecorded pre-1987`);
  }
  if (d <= 1990 && !imp.includes('clearances') && p.clearances === 0) {
    findings.IMPUTE.push(`${p.name} (${p._bucket}): clearances 0 and NOT imputed — clearances were unrecorded pre-~1998`);
  }
  for (const s of imp) {
    if ((p[s] ?? 0) <= 0) {
      findings.IMPUTE.push(`${p.name} (${p._bucket}): ${s} flagged imputed but value is ${p[s]}`);
    }
  }
  // An imputed value should look like a plausible estimate, not an outlier.
  if (imp.includes('tackles') && p.tackles > 8) {
    findings.IMPUTE.push(`${p.name} (${p._bucket}): imputed tackles ${p.tackles} looks too high`);
  }
  if (imp.includes('clearances') && p.clearances > 9) {
    findings.IMPUTE.push(`${p.name} (${p._bucket}): imputed clearances ${p.clearances} looks too high`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const sec = (title, items, fmt = x => x) => {
  console.log(`\n${title} — ${items.length}`);
  if (!items.length) { console.log('  (none)'); return; }
  items.slice(0, 40).forEach(i => console.log(`  ${fmt(i)}`));
  if (items.length > 40) console.log(`  … and ${items.length - 40} more`);
};

console.log(`Audited ${flat.length} entries${onlyDec ? ` (decade ${onlyDec}s)` : ''}.`);
sec('IMPUTE  — imputation/blank-semantics problems', findings.IMPUTE);
sec('OUT     — stat beyond era plausibility ceiling', findings.OUT);
sec('SUPER   — dominates 3+ categories in its decade', findings.SUPER);
sec('DUP     — identical line, different players (low signal, see header)',
    findings.DUP, e => `[${e.line}] ${e.players.join(' | ')}`);
sec('SELFDUP — identical line, same player twice', findings.SELFDUP,
    e => `[${e.line}] ${e.players.join(' | ')}`);

const hard = findings.IMPUTE.length + findings.OUT.length;
console.log(`\n${hard === 0 ? 'No hard problems found.' : `${hard} hard problem(s) — review IMPUTE/OUT above.`}`);
