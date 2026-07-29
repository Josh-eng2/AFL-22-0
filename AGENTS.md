# AFL 22-0 (in-progress AFL port)

## Status — read this first

This repo is a **work-in-progress AFL port** of the NBA game "Can You Go 82-0?".
The full build plan — decisions, translation table, data project, sequencing — is
in [`docs/afl-port-plan.md`](docs/afl-port-plan.md). Read it before making changes;
it explains *why* things are structured the way they are, not just what to do next.

**Only the data layer has been ported so far** (stripped NBA data/scripts, wrote a
41-player AFL stub `players.json`, adapted `add_rating.js` / `add_popularity.js` /
`validate_players.js` to the AFL schema). The game engine — `js/logic/state.js`
(club list, decades, positions, coaches), `positions.js`, `chemistry.js`,
`simulation.js`, `era.js`, the playoff bracket, and all UI copy in `render.js` /
`events.js` / `index.html` — is **still the NBA version** and has not been touched.
Concretely: `state.js`'s `TEAMS` list still has NBA franchises, not AFL clubs, so it
does not match the club names now in `players.json` (`Carlton`, `Essendon`,
`NorthMelbourne`) — every draft spin will come back with zero available players
until the engine port (Phase 4 in the plan) happens. Don't be surprised by this; it's
the expected state mid-port, not a bug to silently patch around.

## Cursor Cloud specific instructions

This is a **100% static, client-side browser game** — vanilla JS ES modules, HTML,
and CSS. There is **no backend, no build step, no bundler, and no package manager**
(no `package.json`/lockfile). Node.js and Python 3 are preinstalled; nothing needs
to be installed to run or test the app.

### Running the app (development)
Serve the repo root over HTTP (ES modules do not work reliably over `file://`):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works (`npx serve`, etc.). As noted above, the draft wheel
will not currently find players — that's expected until the engine port lands.

### Lint / test / build
There is **no lint tooling, no automated test suite, and no build step required to
run** this repo. Once the engine port is done, "testing" means manually playing the
game in a browser, same as the NBA original: draft a full roster via the club/era
wheel, pick a coach, then simulate a season and confirm a results screen appears.

One committed-generated stylesheet: `css/tailwind.css` is a static Tailwind build
(config in `tailwind.config.js`). After adding/removing Tailwind classes in
`index.html` or `js/**`, regenerate it with `bash scripts/build_tailwind.sh` (uses
`npx`, no package.json).

### Data regeneration
The player database is committed pre-generated at `js/data/players.js` (inlined
from `players.json`, the source of truth). To regenerate after editing
`players.json`:

```bash
scripts/update_players.sh   # add_popularity.js -> add_rating.js -> inline_players.js
node scripts/validate_players.js
```

Note: `update_players.sh` and `add_rating.js` **mutate `players.json` in place**
(adding/overwriting `popularity`, `ratingRaw`, `rating`, `overall`) — only run them
when you mean to. `add_rating.js`'s `overall` field currently just mirrors `rating`;
there is no AFL equivalent yet of the NBA version's 2K-derived composite rating —
see `docs/afl-port-plan.md` §4.4 before building one.

### External services (all optional, degrade gracefully)
- **Google Fonts** — loaded at runtime; falls back to system fonts if blocked.
- **jsDelivr confetti** — lazy-loaded by `withConfetti()` in `js/ui/render.js` only
  when a celebration fires; silently skipped if unreachable.
- **Firebase Firestore/Analytics** (`js/utils/firebase.js`) — still points at the
  NBA game's Firebase project config. Needs a **new, separate Firebase project**
  before shipping (see the port plan §7.3) — do not let this game write to the NBA
  game's leaderboard/analytics collections.

### Not yet ported / intentionally removed
- `.github/workflows/refresh-challenge-pages.yml` was **deleted**, not adapted —
  it auto-commits generated Daily Challenge pages on a nightly schedule, and
  `js/logic/challenge.js` still has the NBA challenge catalog. Re-add it once
  Phase 7 (challenges + daily pages) is done; leaving it live earlier would have
  auto-committed wrong NBA-flavored content to this repo on schedule.
- `favicon.svg` / `og-image.svg` / `logo-badge.svg` are still the NBA
  basketball-themed assets (kept, not deleted, since Phase 7 branding work hasn't
  started) — `favicon.ico` and `og-image.png` (the generated outputs) were deleted
  since they'd be stale/misleading in the meantime.
- `CNAME`, `sitemap.xml` were NBA-domain-specific and deleted; recreate for the new
  domain during Phase 7 (SEO/launch).

### Git workflow
When shipping code changes, **always open a pull request** into `main` (do not push
directly to `main`). Push a feature branch, then create the PR with `gh pr create`
or the GitHub compare URL.
