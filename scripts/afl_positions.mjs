/**
 * scripts/afl_positions.mjs — position assignment (build-out plan A.5).
 *
 * Two layers, in priority order:
 *
 *   1. POSITION_OVERRIDES — the hand-review layer. Authoritative.
 *   2. guessPosition()    — a stat-line heuristic. A FIRST PASS ONLY.
 *
 * ── Why the heuristic can never be trusted alone ────────────────────────────
 * AFL stat lines under-determine position, badly, and worst for exactly the
 * players people recognise. Glenn Archer's best season reads 12.9 disposals /
 * 1.3 goals / 3.1 marks — statistically a small forward. He was one of the
 * most famous DEFENDERS of his era. Nothing in the numbers says otherwise.
 *
 * It's worse pre-2000: rebound_50s, inside_50s, one_percenters and
 * contested_marks — the columns that actually separate a half-back from a
 * small forward — are 0% populated before 1990 and only ~21% in the 1990s
 * (measured; see afl_build_seasons.mjs output). For the 1970s and 1980s the
 * heuristic is working from disposals / goals / marks / hitouts alone.
 *
 * So: the heuristic exists to handle depth players at scale, and every entry
 * that actually ships is reviewed against it. Disagreements are listed in
 * docs/player-data-audit/position-review.md.
 */

/**
 * Restores apostrophes the source corpus strips from surnames.
 *
 * AFL Tables (and therefore the mirror) renders O'Brien as "OBrien",
 * O'Loughlin as "OLoughlin", O'Meara as "OMeara" and so on. Left alone these
 * ship as visible typos on recognisable players. `Mc`/`Mac` names are NOT
 * affected (McLeod, McKay are correct as-is) and are deliberately excluded.
 *
 * The rule is safe because no real surname begins with a capital O or D
 * followed immediately by another capital.
 */
export function fixName(name) {
  if (!name) return name;
  return name.split(' ').map(part =>
    /^[OD][A-Z][a-z]/.test(part) ? `${part[0]}'${part.slice(1)}` : part
  ).join(' ');
}

/**
 * Surname prefixes the source drops entirely, keyed by player key.
 *
 * A second, separate source defect from the apostrophe one: AFL Tables stores
 * Jordan De Goey's surname as "Goey", Tom De Koning's as "Koning" and Matt de
 * Boer's as "Boer" — the Dutch/Afrikaans particle is missing from the
 * `last_name` field, not just unpunctuated. It can't be repaired by rule (the
 * particle isn't in the data at all), so the affected players are listed.
 */
export const NAME_PREFIX_FIX = {
  'goey_jordan_15031996':  'Jordan De Goey',
  'koning_tom_16071999':   'Tom De Koning',
  'koning_sam_26022001':   'Sam De Koning',
  'boer_matt_10031990':    'Matt de Boer',
};

/**
 * Display names for players who SHARE a name with another player in the
 * shipped database, keyed by the source's unique player key
 * (`surname_firstname_ddmmyyyy`).
 *
 * Two reasons this is not cosmetic:
 *  1. Accuracy — "Gary Ablett" with 33.8 disposals is Ablett JUNIOR. Shipping
 *     both under one name is an error a football audience spots instantly.
 *  2. Mechanics — the engine's `draftedPlayerNames` set blocks drafting the
 *     same NAME twice (its cross-era clone guard). Two distinct players
 *     sharing a name would wrongly block each other.
 *
 * Where football media has an established convention it is used (Ablett
 * Sr/Jr, Josh P. / Josh J. Kennedy, Rioli Sr/Jr, Tom J. / Tom T. Lynch);
 * otherwise the less famous of the pair is suffixed with their club.
 */
export const NAME_BY_KEY = {
  'ablett_gary_01101961':   'Gary Ablett Sr',
  'ablett_gary_14051984':   'Gary Ablett Jr',
  'kennedy_josh_20061988':  'Josh P. Kennedy',      // Hawthorn/Sydney midfielder
  'kennedy_josh_25081987':  'Josh J. Kennedy',      // Carlton/West Coast key forward
  'rioli_maurice_01091957': 'Maurice Rioli Sr',
  'rioli_maurice_01092002': 'Maurice Rioli Jr',
  'lynch_tom_15091990':     'Tom T. Lynch',         // Adelaide
  'lynch_tom_31101992':     'Tom J. Lynch',         // Gold Coast/Richmond
  'thompson_scott_09051986': 'Scott D. Thompson',   // North Melbourne defender
  'thompson_scott_14031983': 'Scott Thompson',      // Melbourne/Adelaide midfielder
  'brown_nathan_10021978':  'Nathan Brown (Rich)',
  'brown_nathan_14081976':  'Nathan Brown (Melb)',
  'brown_nathan_17121988':  'Nathan Brown (Coll)',
  'bell_peter_01031976':    'Peter Bell',
  'bell_peter_14101954':    'Peter Bell (StK)',
  'elliott_jamie_21081992': 'Jamie Elliott',
  'elliott_jamie_06021973': 'Jamie Elliott (Bris)',
  'lloyd_matthew_16041978': 'Matthew Lloyd',
  'lloyd_matthew_09081965': 'Matthew Lloyd (Syd)',
  'king_david_07031972':    'David King',
  'king_david_02021985':    'David King (Coll)',
  'moore_kelvin_15081950':  'Kelvin Moore',
  'moore_kelvin_25031984':  'Kelvin Moore (Rich)',
  'collins_andrew_25041965': 'Andrew Collins',
  'collins_andrew_17111988': 'Andrew Collins (Rich)',
  'clarke_david_31121952':  'David Clarke',
  'clarke_david_15051980':  'David Clarke (Carl)',
  'reid_sam_27121991':      'Sam Reid',
  'reid_sam_07111989':      'Sam Reid (GWS)',
  'welsh_peter_29061951':   'Peter Welsh',
  'welsh_peter_24011954':   'Peter Welsh (Haw)',
  'bond_shane_09071975':    'Shane Bond',
  'bond_shane_20061954':    'Shane Bond (Coll)',
};

/**
 * Hand-assigned positions, keyed by (disambiguated) player name.
 *
 * Scope: every marquee/recognisable player in the shipped database, plus
 * every entry where the heuristic disagreed with football reality during
 * review. Values are the player's PRIMARY role in the era the entry covers —
 * for genuine swingmen this is the role they're best remembered in, since
 * positions.js derives the secondary slot at runtime anyway.
 *
 * A name maps to one position across all eras. Players whose role genuinely
 * changed between decades are handled by NAME_DECADE_OVERRIDES below.
 */
export const POSITION_OVERRIDES = {
  // ── Ruckmen ───────────────────────────────────────────────────────────────
  'Todd Goldstein': 'RUC', 'Dean Cox': 'RUC', 'Aaron Sandilands': 'RUC',
  'Max Gawn': 'RUC', 'Brodie Grundy': 'RUC', 'Nic Naitanui': 'RUC',
  'Matthew Kreuzer': 'RUC', 'Tom Bellchambers': 'RUC', 'Sam Jacobs': 'RUC',
  'Shane Mumford': 'RUC', 'Ivan Maric': 'RUC', 'Mark Blicavs': 'RUC',
  'Simon Madden': 'RUC', 'Justin Madden': 'RUC', 'Greg Madden': 'RUC',
  'Scott Wynd': 'RUC', 'Paul Salmon': 'RUC', 'John Barnes': 'RUC',
  'Steven King': 'RUC', 'Peter Everitt': 'RUC', 'Jeff White': 'RUC',
  'Matthew Primus': 'RUC', 'Darren Jolly': 'RUC', 'Mark Jamar': 'RUC',
  'Ben Hudson': 'RUC', 'David Hille': 'RUC', 'Will Minson': 'RUC',
  'Gary Dempsey': 'RUC', 'Peter Moore': 'RUC', 'Mike Fitzpatrick': 'RUC',
  'Don Scott': 'RUC', 'Len Thompson': 'RUC', 'Graham Teasdale': 'RUC',
  'Rod Carter': 'RUC', 'Stephen MacPherson': 'RUC', 'Greg Wells': 'MID',
  'Sean Darcy': 'RUC', 'Reilly O\'Brien': 'RUC', 'Tim English': 'RUC',
  'Rowan Marshall': 'RUC', 'Toby Nankervis': 'RUC', 'Jarrod Witts': 'RUC',
  'Stefan Martin': 'RUC', 'Paul Hasleby': 'MID',

  // ── Key forwards ──────────────────────────────────────────────────────────
  'Tony Lockett': 'KF', 'Jason Dunstall': 'KF', 'Gary Ablett': 'KF',
  'Wayne Carey': 'KF', 'Matthew Richardson': 'KF', 'Matthew Lloyd': 'KF',
  'Barry Hall': 'KF', 'Nick Riewoldt': 'KF', 'Matthew Pavlich': 'KF',
  'Lance Franklin': 'KF', 'Jonathan Brown': 'KF', 'Brendan Fevola': 'KF',
  'Josh Kennedy': 'KF', 'Jack Riewoldt': 'KF', 'Travis Cloke': 'KF',
  'Tom Hawkins': 'KF', 'Joe Daniher': 'KF', 'Ben Brown': 'KF',
  'Charlie Curnow': 'KF', 'Jeremy Cameron': 'KF', 'Taylor Walker': 'KF',
  'Charlie Dixon': 'KF', 'Tom Lynch': 'KF', 'Harry McKay': 'KF',
  'Stephen Kernahan': 'KF', 'Doug Hawkins': 'HB', 'Peter Hudson': 'KF',
  'Bernie Quinlan': 'KF', 'Michael Roach': 'KF', 'Simon Beasley': 'KF',
  'Warwick Capper': 'KF', 'Dermott Brereton': 'KF', 'Gary Buckenara': 'KF',
  'Saverio Rocca': 'KF', 'Tony Modra': 'KF', 'Scott Cummings': 'KF',
  'Fraser Gehrig': 'KF', 'David Neitz': 'KF', 'Justin Koschitzke': 'KF',
  'Warren Tredrea': 'KF', 'Brad Ottens': 'KF', 'Kurt Tippett': 'KF',
  'Jarryd Roughead': 'KF', 'Drew Petrie': 'KF', 'Jack Darling': 'KF',
  'Mitch Brown': 'KF', 'Aaron Naughton': 'KF', 'Ben King': 'KF',
  'Mitch Robinson': 'MID', 'Peter Sumich': 'KF', 'Alastair Lynch': 'KF',
  'Darren Bennett': 'KF', 'Billy Brownless': 'KF', 'Mark Jackson': 'KF',
  'Ross Lyon': 'SF', 'Nick Naitanui': 'RUC',

  // ── Small forwards ────────────────────────────────────────────────────────
  'Eddie Betts': 'SF', 'Cyril Rioli': 'SF', 'Stephen Milne': 'SF',
  'Leon Davis': 'SF', 'Jeff Farmer': 'SF', 'Peter Matera': 'MID',
  'Phil Matera': 'SF', 'Andrew Walker': 'SF', 'Lindsay Thomas': 'SF',
  'Chad Wingard': 'SF', 'Robbie Gray': 'SF', 'Luke Breust': 'SF',
  'Paul Puopolo': 'SF', 'Jamie Elliott': 'SF', 'Toby Greene': 'SF',
  'Charlie Cameron': 'SF', 'Michael Walters': 'SF', 'Orazio Fantasia': 'SF',
  'Isaac Heeney': 'MID', 'Tom Papley': 'SF', 'Jack Higgins': 'SF',
  'Bobby Hill': 'SF', 'Kysaiah Pickett': 'SF', 'Izak Rankine': 'SF',
  'Peter Daicos': 'SF', 'Robert DiPierdomenico': 'MID', 'Alan Johnson': 'SF',
  'Ronnie Burns': 'SF', 'Nathan Buckley': 'MID', 'Ang Christou': 'HB',
  'Wayne Schwass': 'MID', 'Michael Long': 'MID', 'Che Cockatoo-Collins': 'SF',
  'Byron Pickett': 'SF', 'Daniel Motlop': 'SF', 'Shaun Burgoyne': 'HB',
  'Steven Motlop': 'SF', 'Danyle Pearce': 'HB',

  // ── Key defenders ─────────────────────────────────────────────────────────
  'Stephen Silvagni': 'KD', 'Dustin Fletcher': 'KD', 'Jeremy McGovern': 'KD',
  'Alex Rance': 'KD', 'Harris Andrews': 'KD', 'Jacob Weitering': 'KD',
  'Darren Glass': 'KD', 'Matthew Scarlett': 'KD', 'Ted Richards': 'KD',
  'Michael Hurley': 'KD', 'Tom Stewart': 'HB', 'Sam Taylor': 'KD',
  'Steven Silvagni': 'KD', 'Mick Martyn': 'KD', 'Glen Jakovich': 'KD',
  'Danny Frawley': 'KD', 'Chris Langford': 'KD', 'Gary Pert': 'KD',
  'David Dench': 'KD', 'Geoff Southby': 'KD', 'Kelvin Moore': 'KD',
  'Bruce Doull': 'KD', 'Rod Austin': 'KD', 'Ross Glendinning': 'KD',
  'Mark Lee': 'RUC', 'Scott Thompson': 'KD', 'Ben Rutten': 'KD',
  'Heath Scotland': 'HB', 'Darren Gaspar': 'KD', 'Matthew Broadbent': 'HB',
  'Nathan Bock': 'KD', 'Tom Lonergan': 'KD', 'Eric Mackenzie': 'KD',
  'Phil Davis': 'KD', 'Michael Talia': 'KD', 'Dougal Howard': 'KD',
  'Tom Barrass': 'KD', 'Jake Lever': 'KD', 'Steven May': 'KD',
  'Darcy Moore': 'KD', 'Sam Collins': 'KD', 'Callum Wilkie': 'KD',
  'Rory Lobb': 'KF', 'Trent Croad': 'KD',

  // ── Half-backs / rebounding defenders ─────────────────────────────────────
  'Glenn Archer': 'KD', 'Andrew McLeod': 'HB', 'Brett Kirk': 'MID',
  'Kade Simpson': 'HB', 'Adam Saad': 'HB', 'Bachar Houli': 'HB',
  'Brodie Smith': 'HB', 'Zach Tuohy': 'HB', 'Jayden Short': 'HB',
  'Daniel Rich': 'HB', 'Nick Vlastuin': 'HB', 'Jake Lloyd': 'HB',
  'Nathan Burke': 'MID', 'Gavin Wanganeen': 'HB', 'Chris Johnson': 'HB',
  'David King': 'MID', 'Craig Bradley': 'MID', 'Shaun Higgins': 'MID',
  'Sam Docherty': 'HB', 'Lachie Ash': 'HB', 'Nick Daicos': 'MID',
  'Jordan Dawson': 'MID', 'Bobby Skilton': 'MID', 'Rod Owen': 'SF',
  'Wayne Johnston': 'MID', 'Ken Hunter': 'HB', 'Gary O\'Donnell': 'HB',
  'Sean Wellman': 'KD', 'Dale Morris': 'KD', 'Corey Enright': 'HB',
  'Andrew Embley': 'MID', 'Ryan O\'Keefe': 'MID', 'Jarrad McVeigh': 'MID',
  'Grant Birchall': 'HB', 'Brent Harvey': 'MID',

  // ── Midfielders ───────────────────────────────────────────────────────────
  'Robert Harvey': 'MID', 'Greg Williams': 'MID', 'Dustin Martin': 'MID',
  'Patrick Cripps': 'MID', 'Marcus Bontempelli': 'MID', 'Shane Crawford': 'MID',
  'Chris Judd': 'MID', 'Gary Ablett Jr': 'MID', 'Joel Selwood': 'MID',
  'Scott Pendlebury': 'MID', 'Luke Hodge': 'HB', 'Sam Mitchell': 'MID',
  'Adam Goodes': 'MID', 'Simon Black': 'MID', 'Michael Voss': 'MID',
  'Nigel Lappin': 'MID', 'Jason Akermanis': 'SF', 'Leigh Matthews': 'MID',
  'Kevin Bartlett': 'MID', 'Keith Greig': 'MID', 'Barry Round': 'RUC',
  'Malcolm Blight': 'KF', 'Ian Stewart': 'MID', 'Francis Bourke': 'HB',
  'Bruce Monteath': 'MID', 'Trevor Barker': 'HB', 'Tim Watson': 'MID',
  'Terry Daniher': 'KF', 'Neale Daniher': 'MID', 'Paul Roos': 'HB',
  'Garry Wilson': 'MID', 'Bernie Harris': 'MID', 'Mark Ricciuto': 'MID',
  'Ben Cousins': 'MID', 'Daniel Kerr': 'MID', 'James Hird': 'MID',
  'Jobe Watson': 'MID', 'Zach Merrett': 'MID', 'Dyson Heppell': 'MID',
  'Marc Murphy': 'MID', 'Bryce Gibbs': 'MID', 'Trent Cotchin': 'MID',
  'Dane Swan': 'MID', 'Steele Sidebottom': 'MID', 'Adam Treloar': 'MID',
  'Tom Mitchell': 'MID', 'Lachie Neale': 'MID', 'Clayton Oliver': 'MID',
  'Christian Petracca': 'MID', 'Jack Macrae': 'MID', 'Josh Kelly': 'MID',
  'Stephen Coniglio': 'MID', 'Nat Fyfe': 'MID', 'Matt Priddis': 'MID',
  'Luke Parker': 'MID', 'Josh Kennedy Jr': 'MID', 'Rory Sloane': 'MID',
  'Ollie Wines': 'MID', 'Travis Boak': 'MID', 'Scott Thompson Adelaide': 'MID',
  'Anthony Koutoufides': 'MID', 'Ben Cunnington': 'MID', 'Jack Ziebell': 'MID',
  'Shaun Hart': 'MID', 'Kane Cornes': 'MID', 'Brett Ratten': 'MID',
  'Jude Bolton': 'MID', 'Brad Johnson': 'SF', 'Scott West': 'MID',
  'Daniel Cross': 'MID', 'Matthew Boyd': 'MID', 'Ryan Griffen': 'MID',
  'Corey McKernan': 'RUC', 'Anthony Stevens': 'MID', 'Adam Simpson': 'MID',
  'Joel Corey': 'MID', 'Cameron Ling': 'MID', 'Jimmy Bartel': 'MID',
  'Steve Johnson': 'SF', 'Paul Chapman': 'MID', 'Gary Ablett Junior': 'MID',
  'Darcy Parish': 'MID', 'Zak Butters': 'MID', 'Errol Gulden': 'MID',
  'Caleb Serong': 'MID', 'Andrew Brayshaw': 'MID', 'Tim Kelly': 'MID',
  'Jack Steele': 'MID', 'Jack Viney': 'MID', 'Angus Brayshaw': 'MID',
  'Dayne Beams': 'MID', 'Dayne Zorko': 'MID', 'Rory Laird': 'HB',
  'Elliot Yeo': 'MID', 'Luke Shuey': 'MID', 'Scott Selwood': 'MID',
  'Kane Lambert': 'MID', 'Dion Prestia': 'MID', 'Shane Edwards': 'SF',
  'Bontempelli Marcus': 'MID', 'Joel Smith': 'HB',

  // ── Corrections from the position review pass ─────────────────────────────
  // Each of these is a case where the stat-line heuristic reached a defensible
  // but factually wrong conclusion, caught by reading the generated review
  // artifact and the automated contradiction checks.

  // Midfielders the heuristic read as defenders (low goals + decent marks).
  'Nick Stevens': 'MID',        // Port/Carlton onballer, not a key defender
  'Shane Woewodin': 'MID',      // 2000 Brownlow medallist — midfielder
  'Wayne Harmes': 'MID',        // Carlton wingman (the 1979 GF knock-on)
  'Paul Williams': 'MID',       // Collingwood/Sydney midfielder
  'Graham Wright': 'MID',       // Collingwood rover
  'Dean Kemp': 'MID',           // 1994 Norm Smith medallist — midfielder
  'Brian Walsh': 'MID',         // 23.5 disposals is a rover, not a key forward
  'Mick Conlan': 'MID',         // Fitzroy rover
  'Leon Baker': 'MID',          // Essendon rover, 1985 Norm Smith
  'Tony Morwood': 'MID',        // Sydney midfielder
  'Doug Hawkins': 'MID',        // iconic Footscray wingman

  // Key forwards the heuristic read as smalls (tall marking targets).
  'Chris Tarrant': 'KF',        // 8.8 marks — key forward
  'Jarrad Waite': 'KF',         // 8.3 marks — key forward
  'Scott Lucas': 'KF',          // Essendon key forward
  'Chris Grant': 'KF',          // 8.4 marks — Footscray CHF
  'Jack Watts': 'KF',
  'Jack Lukosius': 'KF',
  'Earl Spalding': 'KF',
  'Max Crow': 'KF',
  'Ken Newland': 'KF',
  'Peter Mann': 'KF',
  'Laurie Sandilands': 'KF',
  'Max King': 'KF',
  'Jamarra Ugle-Hagan': 'KF',
  'Sam Reid': 'KF',             // Sydney key forward (see NAME_BY_KEY)
  'Brad Johnson': 'KF',         // Footscray half-forward, 7.3 marks
  'Ross Glendinning': 'KF',     // 1983 Brownlow; 3.8 goals is a forward season

  // Defenders the heuristic read as forwards/midfielders.
  'Daniel Merrett': 'KD',       // Brisbane key defender
  'Ashley McIntosh': 'KD',      // West Coast key defender
  'Peter Knights': 'KD',        // Hawthorn centre half-back
  'Gary Hardeman': 'KD',        // Melbourne centre half-back
  'Ben Holland': 'KD',
  'David Wirrpanda': 'HB',      // West Coast defender
  'Rex Hunt': 'HB',             // played back pocket, not forward
  'Brett Lovett': 'HB',         // Melbourne half-back/tagger
  'Guy McKenna': 'HB',          // West Coast half-back flanker
  'John Rantall': 'HB',         // back pocket
  'Merv Neagle': 'SF',          // Essendon/Sydney forward
  'Dick Clay': 'HB',            // Richmond half-back
  'Michael Mitchell': 'SF',     // Richmond small forward
  'Tom T. Lynch': 'HB',         // Adelaide forward/wing, not a key defender
  'Eric Hipwood': 'KF',         // 198cm Brisbane key forward
  'Scott Burns': 'MID',         // Collingwood midfielder
  'Brett Montgomery': 'HB',     // defender/mid; heuristic split him KD vs SF across clubs
  'Rohan Smith': 'HB',          // 300-game Footscray/Bulldogs half-back
};

/**
 * Rare cases where a player's primary role genuinely differed by decade.
 * Keyed `"Name|Decade"`; beats POSITION_OVERRIDES.
 */
export const NAME_DECADE_OVERRIDES = {
  // Ablett Sr was a genuine midfielder/rover early at Hawthorn before becoming
  // the definitive Geelong full-forward.
  'Gary Ablett Sr|1980s': 'KF',
  // Malcolm Blight: rover-turned-forward; his 1970s North years are forward.
  'Malcolm Blight|1970s': 'KF',
};

/**
 * Position overrides keyed by `"Name|Club|Decade"` — the finest grain, for
 * players whose role differed by CLUB within a decade. Beats everything else.
 */
export const NAME_CLUB_DECADE_OVERRIDES = {
  // Salmon was Essendon's key forward, then rucked at Hawthorn (27.5 hitouts
  // in the shipped season) before returning to Essendon as a forward-ruck.
  'Paul Salmon|Essendon|1980s': 'KF',
  'Paul Salmon|Essendon|1990s': 'KF',
  'Paul Salmon|Hawthorn|1990s': 'RUC',
  'Paul Salmon|Essendon|2000s': 'RUC',
};

const POSITIONS = ['KD', 'HB', 'MID', 'RUC', 'KF', 'SF'];

/**
 * Stat-line heuristic. First pass only — see file header.
 *
 * Era-aware: rebound50s / inside50s / onePercenters / contestedMarks /
 * marksInside50 are unavailable before ~1998, so the pre-2000 branch works
 * from disposals / goals / marks / hitouts alone and is correspondingly
 * less reliable (which is why the override table carries most 1970s-80s
 * marquee names explicitly).
 *
 * @param {object} s  a season row from afl_build_seasons.mjs
 * @returns {{pos: string, confidence: 'high'|'medium'|'low', why: string}}
 */
export function guessPosition(s) {
  const disp = s.disposals ?? 0;
  const gls  = s.goals ?? 0;
  const mks  = s.marks ?? 0;
  const hit  = s.hitouts ?? 0;
  const reb  = s.rebound50s;
  const i50  = s.inside50s;
  const onep = s.onePercenters;
  const mi50 = s.marksInside50;

  // 1. Ruck is the one role the stat line states outright.
  if (hit >= 8)  return { pos: 'RUC', confidence: 'high',   why: `hitouts ${hit}` };
  if (hit >= 4)  return { pos: 'RUC', confidence: 'medium', why: `hitouts ${hit}` };

  // 1b. Possession-volume guard, checked before any forward rule. Nobody
  // averaging 24+ disposals is a key forward or a key defender — those roles
  // simply don't see that much ball. Without this, high-scoring midfielders
  // (Dangerfield at 29.9 disposals and 1.9 goals) get read as key forwards
  // because they clear the goals-and-marks bar.
  if (disp >= 24) return { pos: 'MID', confidence: 'high', why: `disp ${disp} (volume guard)` };

  const hasAux = reb != null && i50 != null && onep != null;

  // Rule ORDER matters as much as the thresholds. Goals are the most decisive
  // signal in AFL, so forwards are separated first; only then are the
  // remaining low-scoring players split by whether they carry the ball
  // (half-back) or contest it in the air (key defender). Getting this order
  // wrong is what made 25-disposal rebounding half-backs read as key
  // defenders, and sub-2-goal modern key forwards read as smalls.
  if (hasAux) {
    // 2. Key forward: a marking target who scores. Modern key forwards share
    // a forward line and often sit under 2 goals a game, so the marking
    // profile plus low possession count carries as much weight as the goals.
    if (gls >= 1.8 && mks >= 5.0) return { pos: 'KF', confidence: 'high', why: `gls ${gls}, mks ${mks}` };
    if (gls >= 1.2 && mks >= 4.3 && disp < 17) {
      return { pos: 'KF', confidence: 'medium', why: `gls ${gls}, mks ${mks}, disp ${disp} (tall fwd profile)` };
    }
    if (gls >= 1.5 && (mi50 ?? 0) >= 1.8 && mks >= 4.0) {
      return { pos: 'KF', confidence: 'medium', why: `gls ${gls}, mi50 ${mi50}` };
    }
    // 3. Small forward: scores without the marking profile or the possessions.
    if (gls >= 0.9 && disp < 16 && mks < 5.0) {
      return { pos: 'SF', confidence: 'medium', why: `gls ${gls}, disp ${disp}, mks ${mks}` };
    }
    // 4. Midfield: volume and contested work beat everything below.
    if (disp >= 21 || (s.clearances ?? 0) >= 4.0) {
      return { pos: 'MID', confidence: 'high', why: `disp ${disp}, clr ${s.clearances}` };
    }
    // 5. Key defender: intercepting tall — marks heavily, doesn't score, and
    // crucially does NOT rack up possessions (that's a half-back).
    if (gls <= 0.6 && mks >= 5.0 && disp < 20) {
      return { pos: 'KD', confidence: 'high', why: `gls ${gls}, mks ${mks}, disp ${disp}` };
    }
    if (gls <= 0.5 && onep >= 4.5 && disp < 20) {
      return { pos: 'KD', confidence: 'medium', why: `gls ${gls}, 1% ${onep}` };
    }
    // 6. Half-back: low scoring, high possession, rebounds out of defence.
    if (gls <= 1.0 && (reb >= 2.2 || disp >= 17)) {
      return { pos: 'HB', confidence: 'high', why: `gls ${gls}, reb ${reb}, disp ${disp}` };
    }
    if (i50 >= 3.0 && disp >= 15) return { pos: 'MID', confidence: 'low', why: `i50 ${i50}, disp ${disp}` };
  } else {
    // Pre-2000 branch — thin evidence (no rebound_50s / inside_50s /
    // one_percenters before ~1998), low confidence by construction.
    if (gls >= 2.2 && mks >= 5.0) return { pos: 'KF', confidence: 'medium', why: `pre2000 gls ${gls}, mks ${mks}` };
    if (gls >= 3.0)               return { pos: 'KF', confidence: 'low',    why: `pre2000 gls ${gls}` };
    if (gls >= 1.2 && disp < 16)  return { pos: 'SF', confidence: 'low',    why: `pre2000 gls ${gls}, disp ${disp}` };
    if (disp >= 21)               return { pos: 'MID', confidence: 'medium', why: `pre2000 disp ${disp}` };
    if (gls <= 0.5 && mks >= 4.8 && disp < 19) {
      return { pos: 'KD', confidence: 'low', why: `pre2000 gls ${gls}, mks ${mks}, disp ${disp}` };
    }
    if (gls <= 0.8 && disp >= 15) return { pos: 'HB', confidence: 'low',    why: `pre2000 gls ${gls}, disp ${disp}` };
    if (disp >= 17)               return { pos: 'MID', confidence: 'low',   why: `pre2000 disp ${disp}` };
  }

  // 6. Fallback — genuinely ambiguous; review will catch these.
  if (gls >= 1.0) return { pos: 'SF',  confidence: 'low', why: 'fallback (scores a bit)' };
  if (mks >= 4.5) return { pos: 'KD',  confidence: 'low', why: 'fallback (marks)' };
  return { pos: 'HB', confidence: 'low', why: 'fallback' };
}

/**
 * Final position for a season row: override layer wins, heuristic fills in.
 * @returns {{pos:string, source:'override'|'override-decade'|'heuristic', confidence:string, why:string}}
 */
export function resolvePosition(s) {
  const cdk = `${s.name}|${s.club}|${s.decade}`;
  if (NAME_CLUB_DECADE_OVERRIDES[cdk]) {
    return { pos: NAME_CLUB_DECADE_OVERRIDES[cdk], source: 'override-club-decade', confidence: 'high', why: 'hand-reviewed (club+era specific)' };
  }
  const dk = `${s.name}|${s.decade}`;
  if (NAME_DECADE_OVERRIDES[dk]) {
    return { pos: NAME_DECADE_OVERRIDES[dk], source: 'override-decade', confidence: 'high', why: 'hand-reviewed (era-specific)' };
  }
  if (POSITION_OVERRIDES[s.name]) {
    return { pos: POSITION_OVERRIDES[s.name], source: 'override', confidence: 'high', why: 'hand-reviewed' };
  }
  const g = guessPosition(s);
  return { ...g, source: 'heuristic' };
}

export { POSITIONS };
