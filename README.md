# NFL Missed Kick Bot

A small TypeScript bot that polls ESPN’s **public, keyless** NFL APIs and tweets whenever a kicker misses a field goal or a PAT / extra point.

It runs on its own — a Cloudflare Worker watches the ESPN slate and wakes GitHub Actions only when games are on, or you can use `npm start`. It does **not** use Cursor/Grok routines or X MCP credits. The Worker never tweets.

## What it tweets

```
❌ Missed FG
Kicker: Daniel Carlson (NO)
Kick: 62 yards
Result: Wide Right
When: Q4 0:02
Score: NO 24-24 DET
Season: 2 missed FG · 0 missed PAT
#Saints #OnePride
```

```
❌ Missed FG
Kicker: Jason Sanders (NYJ)
Kick: 54 yards
Result: Wide Left
When: Q2 2:44
Score: NYJ 10-3 TEN
Season: 1 missed FG · 0 missed PAT
#JetUp #TitanUp
```

```
❌ Missed PAT
Kicker: Spencer Shrader (IND)
Result: Wide Right
When: Q1 10:33
Score: BAL 0-6 IND
Season: 0 missed FG · 1 missed PAT
#ForTheShoe #RavensFlock
```

Those three are real Week 1 (2026-09-13) misses, taken from ESPN play-by-play. Each alert is labeled line-by-line (PAT omits the Kick/distance line). A **Season** line shows that kicker’s regular-season miss totals (FG and PAT only, inclusive of the kick just posted). Tweets end with official primary season hashtags for both teams — kicking team first, never raw abbreviations like `#NO`. Those tags trigger custom team emojis on X. Tweets stay under 280 characters and are **plain text with no URLs** — X pay-per-use charges more for posts that include links. If a post would exceed 280 characters, hashtags are dropped first; the Season line is kept ahead of hashtags and is dropped only after Score / When.

## How detection works

1. **Scoreboard** — list in-progress games and recently finished ones.
2. **Game summary** — fetch drives/plays for each watched game.
3. **Missed FG** — a play whose `type.text === "Field Goal Missed"` (type id `"60"`), e.g.  
   `D.Carlson 62 yard field goal is No Good, Wide Right, Center-Z.Wood, Holder-R.Wright.`
4. **Missed PAT** — prefer structured `pointAfterAttempt.id === 62` / text `Extra Point Missed` when present (often *on the touchdown play*). Also treat play text matching `extra point is No Good` as a backup when ESPN omits `pointAfterAttempt`.  
   **Extra Point Good (`id` 61) is never treated as a miss.** Key off `id` / `text`, not `value` — ESPN sometimes sets `value: 1` on a miss.
5. Plays are collected from `drives.previous`, `drives.current`, and any other `plays[]` arrays in the payload.
6. Each miss is keyed by ESPN play `id` and persisted so the same kick is never tweeted twice.
7. **Kicker name** — play text is `D.Carlson` / `W. Lutz`. Tweets prefer a full first + last name from the summary boxscore kicking athletes, a play participant athlete (`displayName` / `fullName` / first+last), or the ESPN athlete profile when `athleteId` is known. Initials remain the fallback.
8. **Season tallies** — each poll recomputes per-kicker miss counts from ESPN play-by-play for regular-season games (`seasontype=2`) that have already started this season (weeks 1…current, or all 18 once the postseason begins). The same miss detectors as above are used. Kickers are keyed by athlete id when the play has one (core `/plays` `participants[].athlete`), otherwise by a normalized name + team. Full names and initial forms (`Wil Lutz` / `W. Lutz`) alias to the same kicker. Tallies are not incremented from a local counter; ESPN PBP is the source of truth. Completed games may be cached in `.state/tallies.json` so later polls skip them; if that file is missing the bot rebuilds from ESPN. In-progress games are always refetched. Within one process, a game is not parsed twice.

Team comes from `teamParticipants` (`type === "offense"`) matched to the game’s competitors. Distance is parsed from the play text (FG only). Result detail (Wide Left / Right, Short, Blocked, Hit Right Upright, …) is parsed from the `No Good, …` clause.

## ESPN endpoints (unofficial)

These endpoints are **undocumented public JSON**. ESPN can change or rate-limit them at any time. This bot is a good citizen: two summary fetches at a time, ~20s in-memory cache per game, 30s default poll interval.

| Purpose | URL |
| --- | --- |
| Scoreboard (today / current week) | `GET https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard` |
| Scoreboard by week | same + `?seasontype=2&week=12` (Worker refresh; type 1=pre, 2=reg, 3=post) |
| Game summary (primary) | `GET https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={eventId}` |
| CDN play-by-play (fallback) | `GET https://cdn.espn.com/core/nfl/playbyplay?xhr=1&gameId={eventId}` |
| Core plays list (fallback) | `GET https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{eventId}/competitions/{eventId}/plays?limit=400` |
| Athlete profile (name fallback) | `GET https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/{athleteId}` |

`site.api.espn.com` is the same summary/scoreboard path ESPN publishes more often, but Akamai frequently returns **403** from datacenter IPs. The bot tries `site.web.api.espn.com` first and falls back to `site.api.espn.com`.

If `summary.drives` is empty or the site summary fails, it unwraps `gamepackageJSON` from the CDN feed, then the core `/plays` list (same play objects, `$ref`-heavy). Alternate feeds are skipped when the summary already has drives — one extra request per game only when needed.

## Setup

Requires **Node.js 20+**.

```bash
git clone https://github.com/kalb2/nfl-missed-kick-bot.git
cd nfl-missed-kick-bot
npm install
cp .env.example .env
```

### Dry-run against live ESPN (no tweets)

Prints today’s misses from the live scoreboard without posting — including the Season tally line and a `[season]` leaderboard of kickers who have missed this regular season. Uses `--fresh` so a leftover `.state` file does not hide them:

```bash
npm run dry-run -- --fresh
```

You should see any Week-style misses currently on the board (Carlson / Sanders / Shrader on 2026-09-13).

### Always-on process

```bash
# still dry-run until you set DRY_RUN=false and X credentials
npm start
```

`npm start` polls every `POLL_INTERVAL_MS` (default 30s). `npm run once` is a single pass — what GitHub Actions runs.

On first deploy, seed already-occurred misses so they are not blasted out:

```bash
SEED_SEEN=true npm run once
```

## X / Twitter credentials

The bot posts with **OAuth 1.0a user context** for a dedicated bot account. It never uses the X MCP.

1. Create a dedicated X account for the bot (or use an existing one).
2. Apply / sign in at [developer.x.com](https://developer.x.com) and create a **Project** + **App**.
3. In the app settings, set user-authentication permissions to **Read and write**.
4. Open **Keys and tokens** and generate:
   - API Key → `X_API_KEY`
   - API Key Secret → `X_API_KEY_SECRET`
   - Access Token → `X_ACCESS_TOKEN`
   - Access Token Secret → `X_ACCESS_TOKEN_SECRET`
5. Put those four values in `.env` locally, or in **GitHub → Settings → Secrets and variables → Actions**.
6. Set `DRY_RUN=false` (or the `DRY_RUN` repository variable to `false`) only after the secrets are in place.

If any secret is missing, the bot logs tweets instead of posting.

**Cost tip:** keep tweets as plain-text alerts (kicker, distance, result, clock, score, season miss tallies, official team season hashtags). Do not add ESPN or highlight URLs — X pay-per-use bills more for posts that contain links.

## Architecture

```
ESPN scoreboard (slow)     Workers KV slate          poll.yml
        │                        │                       │
        ▼                        ▼                       ▼
 Cloudflare Worker ──if live──► repository_dispatch ──► TypeScript bot ──► X
  cron every 2 min              event `nfl-poll`         (tweets)
  reads KV only
```

1. The Worker in [`worker/`](worker/) refreshes ESPN’s NFL scoreboard/calendar only when the stored slate is empty, older than 7 days, or has no remaining kickoff. Kickoffs are written to Workers KV as UTC ISO times.
2. Every 2 minutes it reads **that KV slate only**. No ESPN scoreboard or summary calls on idle ticks.
3. If any kickoff is in the live window (30 minutes before through 4 hours + 45 minutes after), it wakes `poll.yml` via GitHub `repository_dispatch` (`nfl-poll`), at most once every 5 minutes.
4. `poll.yml` runs the existing TypeScript bot. Tweets stay there. The Worker never talks to X.

Weekday GitHub crons are gone. Thanksgiving, Christmas, Saturday internationals, flex moves, TNF, and SNF/MNF are covered because ESPN’s week scoreboard already lists those kickoffs — not because we guessed a weekday.

### How holidays are covered

ESPN’s site scoreboard includes `leagues[0].calendar` (preseason / regular / postseason weeks) and per-week `events[].date` kickoffs. The Worker stores those dates, then opens the live window from the kickoff clock:

| Example (2026, from ESPN) | Kickoff (UTC) | America/Denver |
| --- | --- | --- |
| Thanksgiving CHI @ DET | `2026-11-26T18:00:00.000Z` | Thu 11:00 AM MT |
| Thanksgiving PHI @ DAL | `2026-11-26T21:30:00.000Z` | Thu 2:30 PM MT |
| Christmas GB @ CHI | `2026-12-25T18:00:00.000Z` | Fri 11:00 AM MT |
| Christmas BUF @ DEN | `2026-12-25T21:30:00.000Z` | Fri 2:30 PM MT |
| TNF / flex / London | whatever ESPN posts that week | derived from UTC |

A Sunday-only Actions cron would miss all of those. The Worker does not care what weekday it is.

## Cloudflare Worker scheduler

Package: [`worker/`](worker/) (own `package.json`, `wrangler.jsonc`, TypeScript). The root bot package is unchanged.

### What is stored in KV

| Key | Value |
| --- | --- |
| `slate` | `{ refreshedAt, source, seasonYear?, games: [{ id, kickoff, name, week, seasonType }] }` |
| `lastDispatchAt` | UTC ISO of the last GitHub `repository_dispatch` |

`kickoff` is always UTC ISO. Docs and dry-run output also show America/Denver.

### When the Worker dispatches

- **Yes:** at least one stored kickoff is inside `[kickoff − 30m, kickoff + 4h45m]` **and** it has not dispatched in the last 5 minutes.
- **No:** empty window → return immediately (KV read only).
- **Refresh ESPN** (not every tick): slate missing/empty, `refreshedAt` older than 168 hours, or every stored kickoff is past the post-window *and* the last refresh was at least 6 hours ago (backoff so offseason does not hammer ESPN).

`poll.yml` concurrency group `missed-kick-poll` still serializes overlapping Actions runs.

### Deploy (`wrangler deploy`)

Requires a free Cloudflare account. CI does **not** deploy live; it typechecks, tests, and runs `wrangler deploy --dry-run`.

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create SLATE
```

Paste the printed namespace id into [`worker/wrangler.jsonc`](worker/wrangler.jsonc) (`kv_namespaces[0].id`). Then set secrets and deploy:

```bash
npx wrangler secret put GITHUB_TOKEN
# optional: protect POST /tick and POST /refresh
npx wrangler secret put SCHEDULER_ADMIN_SECRET
npx wrangler deploy
```

Seed the slate immediately (otherwise the first cron tick does it):

```bash
curl -X POST https://nfl-missed-kick-scheduler.<account>.workers.dev/refresh \
  -H "Authorization: Bearer $SCHEDULER_ADMIN_SECRET"
```

Local (Miniflare KV, no Cloudflare credentials required for the bundle):

```bash
cd worker
cp .dev.vars.example .dev.vars   # put a PAT in GITHUB_TOKEN to actually dispatch
npm test
npm run dry-run                  # live ESPN → print slate + live window; no KV / GitHub / X
npm run dry-run -- --at 2026-11-26T18:05:00Z
npx wrangler dev --test-scheduled
curl http://localhost:8787/status
curl -X POST http://localhost:8787/tick
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
```

### Cloudflare secrets and vars

**Secret** (Dashboard → Workers → Settings → Variables and Secrets, or `wrangler secret put`):

| Secret | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | PAT that can create a `repository_dispatch` on `kalb2/nfl-missed-kick-bot` |
| `SCHEDULER_ADMIN_SECRET` | no | If set, `POST /tick` and `POST /refresh` require `Authorization: Bearer …` |

GitHub token permissions:

- **Fine-grained PAT:** repository `kalb2/nfl-missed-kick-bot`, **Contents: Read and write** (needed for `POST /repos/{owner}/{repo}/dispatches`).
- **Classic PAT:** `public_repo` on this public repo, or `repo` if you ever make it private.

**Vars** (already in `wrangler.jsonc`; override in the dashboard if needed):

| Var | Default | Purpose |
| --- | --- | --- |
| `GITHUB_OWNER` | `kalb2` | Repo owner for dispatch |
| `GITHUB_REPO` | `nfl-missed-kick-bot` | Repo name for dispatch |
| `GITHUB_EVENT_TYPE` | `nfl-poll` | `repository_dispatch` type (`poll.yml` listens for this) |
| `PRE_KICKOFF_MIN` | `30` | Minutes before kickoff to start waking Actions |
| `POST_KICKOFF_MIN` | `285` | Minutes after kickoff to keep waking (4h + 45m) |
| `DISPATCH_COOLDOWN_MIN` | `5` | Minimum minutes between dispatches |
| `SLATE_MAX_AGE_HOURS` | `168` | ESPN refresh at least weekly (flex updates) |
| `REFRESH_MIN_INTERVAL_HOURS` | `6` | Backoff when the slate has no remaining kickoff |
| `LOOKAHEAD_DAYS` | `16` | Extra ESPN weeks to prefetch on refresh |
| `ESPN_USER_AGENT` | browser UA | Same idea as the bot; `site.api` often 403s from cloud IPs |

Workers free tier is enough: one cron every 2 minutes (~720 invocations/day), one KV read per tick, ESPN only on refresh, KV writes only on refresh / dispatch.

## GitHub Actions

Two workflows:

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | push / PR | root tests + Worker tests + `wrangler deploy --dry-run` |
| `poll.yml` | Worker `repository_dispatch` (`nfl-poll`) or manual | one poll, cache `.state/seen.json` and `.state/tallies.json` |

Worker-driven `repository_dispatch` uses the same live posting defaults the old schedule runs used: `DRY_RUN` and `SEED_SEEN` from repository variables (not the manual workflow inputs). Manual **Run workflow** still defaults `dry_run` to true so a dashboard click cannot tweet by accident.

If the scoreboard has no in-progress or recently finished game, the bot exits after the scoreboard call.

**Secrets** (same names as `.env`): `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`.

**Variables** (optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DRY_RUN` | `true` | Set `false` to actually tweet (Worker wakes and `npm start`) |
| `SEED_SEEN` | unset | Set `true` for one run to backfill without tweeting |

Actions state uses `actions/cache` on `.state/`. Caches can expire; the bot also ignores old finals (kickoff + ~4 hours + `RECENT_FINAL_WINDOW_MIN`), so a cache miss should not re-tweet last week. For the first live Sunday, run **Actions → Poll ESPN and tweet misses → Run workflow** with “Seed seen play IDs” enabled, then turn on posting.

Workflow concurrency is serialized so two wakes cannot double-tweet.

### Actions minutes vs always-on

GitHub’s shortest reliable cron is **5 minutes**, but this repo no longer uses a weekday cron. The Worker is the wake source, so Actions minutes are spent only while games are in window. A public repo is usually fine; a private repo’s 2,000 minute monthly quota is much safer than an all-Sunday cron. Prefer `npm start` on a cheap always-on host if you want sub-minute latency:

- A $4–6 VPS, Railway, Render, or Fly.io machine
- `DRY_RUN=false npm start` under systemd or Docker
- Mount / persist `.state/seen.json`

## Environment

See [`.env.example`](.env.example).

| Variable | Default | Notes |
| --- | --- | --- |
| `X_API_KEY` / `X_API_KEY_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET` | (none) | OAuth 1.0a |
| `DRY_RUN` | `true` | Log instead of post |
| `POLL_INTERVAL_MS` | `30000` | Loop mode only |
| `STATE_PATH` | `.state/seen.json` | Seen play IDs (season tallies live beside it as `tallies.json`) |
| `RECENT_FINAL_WINDOW_MIN` | `45` | Extra time after a ~4h game |
| `SEED_SEEN` | `false` | Record misses, do not tweet |
| `ESPN_USER_AGENT` | bot UA | Override if ESPN blocks |

## Development

```bash
npm test
npm run typecheck
cd worker && npm test && npm run typecheck
```

Fixtures under `test/fixtures/` are trimmed copies of real 2026-09-13 ESPN plays (Carlson FG, Sanders FG, Shrader PAT, plus Extra Point Good as a negative case).

## Caveats

- ESPN’s site/v2 APIs are unofficial. Field names, type ids, and availability can change.
- PAT misses live on the **TD play** via `pointAfterAttempt`, not a separate “extra point” play. Detection depends on that field (or equivalent text).
- Blocked kicks are treated as misses when the play text says so; two-point conversions are ignored.
- First start mid-game will tweet every unseen miss still inside the watch window unless you `--seed`.
- Do not commit `.env` or `.state/`.

## License

MIT
