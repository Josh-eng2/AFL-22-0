/**
 * js/logic/state.js — Global Game State & Configuration Constants
 *
 * Exports:
 *   • All static config constants (TEAMS, DECADES, COACHES, TEAM_COLORS, …)
 *   • `S`          — the live, mutable game-state object (ES module live binding)
 *   • `startGame`  — resets / initialises S for a new draft session
 *   • `pick`       — tiny array-random-pick utility used across multiple modules
 *   • `getPlayerSeed` / `buildBracket` — playoff seeding helpers
 *   • `getUtcDateString` / `seedDailyRng` / `clearDailyRng` — Daily Challenge PRNG
 */

import { getLockedPlayer, todayUTC } from './challenge.js';

// ── Static configuration ──────────────────────────────────────────────────────

// All 18 current AFL clubs. Bucket keys are Club_Decade (no spaces) — see
// scripts/validate_players.js's CLUB_FIRST_YEAR for which decades each newer
// club is actually eligible for (West Coast/Brisbane 1987+, Adelaide 1991+,
// Fremantle 1995+, Port Adelaide 1997+, Gold Coast 2011+, GWS 2012+). The
// draft wheel (draft.js spinResult) only ever lands on a (club, decade)
// combo that actually has players in the DB, so listing all 18 here is safe
// even while most clubs have zero data yet — as more players.json coverage
// is added, those combos become spinnable automatically with no code change.
export const TEAMS = [
  'Carlton', 'Collingwood', 'Essendon', 'Geelong', 'Hawthorn', 'Melbourne',
  'NorthMelbourne', 'Richmond', 'StKilda', 'WesternBulldogs', 'Sydney',
  'WestCoast', 'BrisbaneLions', 'Adelaide', 'Fremantle', 'PortAdelaide',
  'GoldCoast', 'GWS',
];

export const DECADES = ['1970s', '1980s', '1990s', '2000s', '2010s', '2020s'];

// Defence -> forward axis. See docs/afl-port-plan.md §3.2.
export const POSITIONS     = ['KD', 'HB', 'MID', 'RUC', 'KF', 'SF'];
export const ALL_POSITIONS  = [...POSITIONS]; // starters-only format — no bench
export const TOTAL_ROUNDS   = 6;

/**
 * Snake draft pick order for 1v1 (12 total picks, 6 per player).
 * Pattern: 1-2-2-1-1-2-2-1-1-2-2-1 — extends the same alternating-round
 * snake the NBA original used, just carried out to a 6th round.
 * Indexed by overall pick number (0 = first pick).
 */
export const SNAKE_ORDER = [1, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2, 1];

export const ERA_DESC = {
  '1970s': 'Jesaulenko · Hudson · Hart',
  '1980s': 'Matthews · Lockett · Krakouer',
  '1990s': 'Carey · Ablett · Voss',
  '2000s': 'Judd · Cousins · Franklin',
  '2010s': 'Dangerfield · Martin · Ablett Jr',
  '2020s': 'Petracca · Neale · Cripps',
};

// Approximate guernsey colors — good enough for badges/accents now;
// refine during Phase 7 branding work (docs/afl-port-plan.md).
export const TEAM_COLORS = {
  Carlton:         { bg: '#0F1131', accent: '#FFFFFF' },
  Collingwood:     { bg: '#000000', accent: '#FFFFFF' },
  Essendon:        { bg: '#CC2031', accent: '#000000' },
  Geelong:         { bg: '#0A2240', accent: '#FFFFFF' },
  Hawthorn:        { bg: '#4D2004', accent: '#FBBF15' },
  Melbourne:       { bg: '#0F1131', accent: '#C62126' },
  NorthMelbourne:  { bg: '#013B9B', accent: '#FFFFFF' },
  Richmond:        { bg: '#000000', accent: '#FFD200' },
  StKilda:         { bg: '#ED1C24', accent: '#000000' },
  WesternBulldogs: { bg: '#00539F', accent: '#DA1A32' },
  Sydney:          { bg: '#ED171F', accent: '#FFFFFF' },
  WestCoast:       { bg: '#003087', accent: '#F2A900' },
  BrisbaneLions:   { bg: '#7A003C', accent: '#FDBE57' },
  Adelaide:        { bg: '#002B5C', accent: '#E21937' },
  Fremantle:       { bg: '#2A1A54', accent: '#FFFFFF' },
  PortAdelaide:    { bg: '#008E9B', accent: '#000000' },
  GoldCoast:       { bg: '#D2062B', accent: '#FBB917' },
  GWS:             { bg: '#F57920', accent: '#231F20' },
};

// Six AFL archetypes replacing the NBA six. See docs/afl-port-plan.md §3.3.
export const ARCHETYPE_STYLE = {
  'Ball Magnet':        { bg: '#dbeafe', text: '#1d4ed8' },
  'Goal Sneak':         { bg: '#fef3c7', text: '#92400e' },
  'Lockdown Defender':  { bg: '#f3e8ff', text: '#6d28d9' },
  'Power Forward':      { bg: '#ede9fe', text: '#5b21b6' },
  'Intercept Marker':   { bg: '#dcfce7', text: '#15803d' },
  'Ruck Bull':          { bg: '#ffedd5', text: '#9a3412' },
};

// Seven premiership-winning AFL coaches, one per rough era. Internal `id`s
// are kept identical to the NBA original (auerbach/holzman/riley/jackson/
// popovich/kerr/rivers) — chemistry.js and simulation.js branch on these ids,
// so keeping them stable means only the DISPLAY fields needed to change here.
export const COACHES = [
  {
    id:     'auerbach',
    name:   'Ron Barassi',
    era:    '1970s',
    system: 'Barassi Drive',
    desc:   'Defense-first — Tall Timber, Defensive Anchor, and All-Australian Defence bonuses amplified; interior defense penalties negated.',
    accent: '#4ade80',
  },
  {
    id:     'holzman',
    name:   'Tom Hafey',
    era:    '1970s',
    system: 'Run and Carry',
    desc:   'Unselfish ball movement — Onball General and Perimeter Lockdown bonuses amplified ×1.5.',
    accent: '#0369a1',
  },
  {
    id:     'riley',
    name:   'Allan Jeans',
    era:    '1980s',
    system: 'Hawthorn Discipline',
    desc:   'Defense and transition driven — End-to-End Rush and All-Australian Defence amplified ×1.5; Defensive Liability penalty negated.',
    accent: '#f87171',
  },
  {
    id:     'jackson',
    name:   'Kevin Sheedy',
    era:    '1990s',
    system: 'Positional Flexibility',
    desc:   'Star-driven — Dynamic Duo and Go-To Gun bonuses amplified ×1.5; Clashing Egos penalty softened to −2%.',
    accent: '#c084fc',
  },
  {
    id:     'popovich',
    name:   'Leigh Matthews',
    era:    '2000s',
    system: 'Contested Footy',
    desc:   'Contested-first — rewards efficient clearance work; Onball General bonus amplified ×1.5.',
    accent: '#60a5fa',
  },
  {
    id:     'kerr',
    name:   'Alastair Clarkson',
    era:    '2010s',
    system: 'Cluster Press',
    desc:   'Pressure and precision driven — Sharpshooting Swarm, Two-Way Precision, and Onball General bonuses amplified; Defensive Sieve penalty heightened.',
    accent: '#fbbf24',
  },
  {
    id:     'rivers',
    name:   'Chris Fagan',
    era:    '2020s',
    system: 'Team First',
    desc:   'Cohesion-first — Dynamic Duo and All-Australian Defence bonuses amplified ×1.5; Clashing Egos penalty fully negated.',
    accent: '#34d399',
  },
];

// ── Finals CPU opponents ──────────────────────────────────────────────────────
// Real premiership-winning AFL sides. Strength values are carried over
// unchanged from the NBA original's calibrated Elo-like scale (only the
// display names changed) so the finals bracket math stays tuned.
export const CPU_TEAMS = [
  { name: "'89 Hawthorn",        strength: 2.38 },
  { name: "'15 Hawthorn",        strength: 2.37 },
  { name: "'03 Brisbane Lions",  strength: 2.25 },
  { name: "'86 Hawthorn",        strength: 2.20 },
  { name: "'99 North Melbourne", strength: 2.15 },
  { name: "'01 Brisbane Lions",  strength: 2.00 },
  { name: "'11 Geelong",         strength: 1.95 },
  { name: "'80 Richmond",        strength: 1.94 },
  { name: "'20 Richmond",        strength: 1.93 },
  { name: "'96 North Melbourne", strength: 1.92 },
  { name: "'21 Melbourne",       strength: 1.91 },
  { name: "'19 Richmond",        strength: 1.90 },
  { name: "'22 Geelong",         strength: 1.89 },
  { name: "'02 Brisbane Lions",  strength: 1.88 },
  { name: "'24 Brisbane Lions",  strength: 1.87 },
];

// ── Utility ───────────────────────────────────────────────────────────────────

// mulberry32 — fast, deterministic 32-bit PRNG. Powers the Daily Challenge:
// pick() is the single choke point every draft-random call goes through
// (team/decade spins, skip re-rolls), so seeding just this one generator
// off the UTC calendar date makes the entire draft sequence identical for
// every player who plays that day, with no other call site needing to know
// about it. Real gameplay (Math.random() elsewhere, e.g. season simulation)
// is untouched — only which teams/decades/players get OFFERED is seeded,
// not how a season actually plays out.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

let _seededRng = null;

/**
 * Today's UTC calendar date as 'YYYY-MM-DD' — the Daily Challenge boundary is
 * a global instant, not per-timezone midnight. Delegates to challenge.js
 * todayUTC() so the seeded board and the day's challenge can never disagree
 * about what "today" is (the two implementations drifted apart once before).
 */
export function getUtcDateString() {
  return todayUTC();
}

/** Seeds pick() deterministically off a date string — same draft sequence for every player that day. */
export function seedDailyRng(dateStr) {
  _seededRng = mulberry32(hashStringToSeed(dateStr));
}

/** Restores pick() to real randomness. Called on every draft (re)start so a seed never leaks into solo/blind/1v1. */
export function clearDailyRng() {
  _seededRng = null;
}

/** Pick a random element from an array — seeded during the Daily Challenge, real-random otherwise. */
export const pick = arr => arr[Math.floor((_seededRng ? _seededRng() : Math.random()) * arr.length)];

/**
 * Cosmetic-only random pick — NEVER seeded. Slot-machine tumble frames and
 * other purely visual noise must use this instead of pick(): a cosmetic call
 * that goes through the seeded generator consumes a draw from the Daily
 * Challenge's deterministic stream, and the number of those calls varies with
 * DOM state and render count (mid-spin re-renders, missing elements), which
 * silently desyncs the "same board for everyone" guarantee between players.
 */
export const pickCosmetic = arr => arr[Math.floor(Math.random() * arr.length)];

// ── Finals helpers ────────────────────────────────────────────────────────────

/**
 * Returns a finals seed (1–8) based on the regular-season win total (out of
 * 22 games).
 * @param {number} wins
 * @returns {number}
 */
export function getPlayerSeed(wins) {
  // Smooth ladder across seeds 1–8, scaled from the NBA original's 82-game
  // bands (70/60/55/50/45/42/40) to a 22-game home-and-away season.
  if (wins >= 19) return 1;
  if (wins >= 16) return 2;
  if (wins >= 15) return 3;
  if (wins >= 14) return 4;
  if (wins >= 12) return 5;
  if (wins >= 11) return 6;
  if (wins >= 10) return 7;
  return 8;
}

/**
 * Builds the first-round bracket of four matchups.
 * The player occupies their seed slot; remaining 7 slots are filled by the
 * top CPU teams sorted by strength.
 *
 * @param {number} playerSeed       1–8
 * @param {number} playerStrength   adjusted Elo-like strength number
 * @returns {Array<[object, object]>}  four [teamA, teamB] pairs
 */
export function buildBracket(playerSeed, playerStrength) {
  const cpuSorted = [...CPU_TEAMS].sort((a, b) => b.strength - a.strength);
  // seeds is 0-indexed; index 0 = seed 1
  const seeds = Array(8).fill(null);
  seeds[playerSeed - 1] = { name: 'Your Team', strength: playerStrength, isPlayer: true };

  let cpuIdx = 0;
  for (let i = 0; i < 8; i++) {
    if (!seeds[i]) seeds[i] = { ...cpuSorted[cpuIdx++], isPlayer: false };
  }

  // AFL Final Eight seed pairing for the first week: qualifying finals are
  // 1v4 and 2v3 (winners get the double-chance bye into the Preliminary
  // Final); elimination finals are 5v8 and 6v7. playoffs.js's
  // getBracketDisplayState()/applyPlayoffRound() interpret these four
  // matchups against the real Final Eight structure (see docs/afl-port-plan.md
  // §6.4) rather than a symmetric single-elimination tree.
  return [
    [seeds[0], seeds[3]], // QF1: 1 v 4
    [seeds[1], seeds[2]], // QF2: 2 v 3
    [seeds[4], seeds[7]], // EF1: 5 v 8
    [seeds[5], seeds[6]], // EF2: 6 v 7
  ];
}

// ── Mutable game state (ES module live binding) ───────────────────────────────
//
// Rules:
//   • Always access S via the named import — never destructure it at the
//     module top level, since startGame() replaces the entire object.
//   • All modules that read S must do so inside function bodies, not at
//     module-init time, so they always pick up the live reference.

/** @type {object} */
export let S = {
  phase:          'mode-select', // 'mode-select' | 'more-modes' | 'drafting' | 'season-sim' | 'results' | 'playoffs' | 'trophy-room' | 'series-result'
  mode:           null,          // 'solo' | '1v1'
  currentPlayer:  1,             // 1 or 2 (1v1 only)
  p1:             null,          // snapshot of P1 after sequential draft (old 1v1 flow — kept for compat)
  seriesResult:   null,
  coach:          null,
  selectedEra:    null,
  // 1v1 alternating draft state (set by startGame1v1)
  p1Coach: null, p1Era: null, p2Coach: null, p2Era: null,
  p1Roster: null, p2Roster: null,
  p1Round: 0, p2Round: 0,
  draftLog: [],
};

const EMPTY_ROSTER = () => ({ KD: null, HB: null, MID: null, RUC: null, KF: null, SF: null });

/**
 * Resets S to a fresh drafting state.
 * Called by the events module when a coach + era have been selected.
 *
 * @param {string} era  e.g. '1990s' or 'all'
 */
export function startGame(era = 'all') {
  const coach         = S.coach;         // preserve the coach selected in the previous phase
  const mode          = S.mode;
  const currentPlayer = S.currentPlayer;
  const p1            = S.p1;
  const dailyChallenge = S.dailyChallenge ?? null; // daily mode context survives the reset
  const dailyDate      = S.dailyDate      ?? null;
  const dynastyOpponent = S.dynastyOpponent ?? null;
  // Skips: daily/dynasty-duel = 0; classic-like = 1
  const skipBudget = (mode === 'daily' || mode === 'dynasty-duel') ? 0 : 1;
  S = {
    phase:            'drafting',
    coach,
    coachLocked:      false,   // locks on the first spin — commit before you see players
    coachPickerOpen:  false,
    eraLocked:        false,   // locks on the first spin — same moment as coach
    eraPickerOpen:    false,
    mode,
    currentPlayer,
    p1,
    seriesResult:     null,
    seriesRevealedCount: 0,
    selectedEra:      era,
    gameId:           crypto.randomUUID(),
    round:            0,
    usedDecades:      [],
    usedPlayerIds:    [],
    draftedPlayerNames: new Set(), // names of players currently on the roster (blocks cross-era clones)
    teamSkips:        skipBudget,
    decadeSkips:      skipBudget,
    drySpins:         0,        // consecutive boards without a star+ player (pity timer)

    spinState:        'idle',   // 'idle' | 'spinning' | 'done'
    currentSpin:      null,     // { team, decade }
    availablePlayers: [],
    draftBoard:       [],       // pick board — all available players from the current spin's team/decade
    selectedPlayer:   null,
    roster: EMPTY_ROSTER(),
    result:  null,
    playoffs: null,
    teamName: '',
    runSaved: false,
    globalScoreSubmitted: false,
    globalSubmitError:    null,
    globalSubmittedChampion: false,

    // Paced season reveal
    seasonGames:     [],
    seasonRevealIdx: 0,
    seasonPaused:    false,
    rivalTease:      false,  // Rivalry Night banner currently showing
    rivalTeased:     false,  // one-shot guard — tease fires once per season

    // Daily Challenge context (null outside daily runs)
    dailyChallenge,
    dailyDate,
    dailyResult: null,       // { pass, pending, detail, streak } — set at sim time

    // Dynasty Duel / More Modes extras
    dynastyOpponent,
    dynastyDuelResult: null,
  };

  // Locked-player daily challenges start with the star already in their slot,
  // registered exactly like a drafted pick (id/name/decade dedup all apply).
  if (dailyChallenge?.type === 'locked') {
    const locked = getLockedPlayer(dailyChallenge);
    if (locked) {
      const pos = dailyChallenge.params.pos;
      S.roster[pos] = locked;
      S.usedPlayerIds.push(locked.id);
      S.draftedPlayerNames.add(locked.name);
      if (locked.decade) S.usedDecades.push(locked.decade);
    }
  }
}

/**
 * Initialises S for a 1v1 or GM vs AI alternating draft.
 * Called after coaches/eras are set on S.
 */
export function startGame1v1() {
  const { p1Coach, p1Era, p2Coach, p2Era } = S;
  const mode = S.mode === 'gm-ai' ? 'gm-ai' : '1v1';
  const isAi = mode === 'gm-ai';
  S = {
    phase:    'drafting',
    mode,
    currentPlayer: 1,
    p1Coach, p1Era, p2Coach, p2Era,
    p1Roster: EMPTY_ROSTER(),
    p2Roster: EMPTY_ROSTER(),
    p1Round:  0,
    p2Round:  0,
    draftLog: [],
    eraLocked:     false,
    eraPickerOpen: false,
    coachLocked:   false,
    coachPickerOpen: false,

    // Shared draft-pool tracking
    gameId:    crypto.randomUUID(),
    usedDecades: [],
    usedPlayerIds: [],
    draftedPlayerNames: new Set(),
    // Per-player skip budgets — AI never skips
    p1TeamSkips: 1, p1DecadeSkips: 1,
    p2TeamSkips: isAi ? 0 : 1,
    p2DecadeSkips: isAi ? 0 : 1,
    drySpins:   0,
    spinState:  'idle',
    currentSpin: null,
    availablePlayers: [],
    draftBoard: [],
    selectedPlayer: null,

    // Solo-mode fields kept to avoid undefined refs
    roster: EMPTY_ROSTER(),
    round: 0,
    result: null,
    playoffs: null,
    teamName: '',
    runSaved: false,
    globalScoreSubmitted: false,
    globalSubmitError: null,
    globalSubmittedChampion: false,
    teamSkips: 0,
    decadeSkips: 0,
    seriesResult: null,
    seriesRevealedCount: 0,
    p1: null,
    selectedEra: p1Era || 'all',
    coach: isAi ? p1Coach : null,
    dynastyOpponent: null,
    dynastyDuelResult: null,
  };
}
