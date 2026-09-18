# NFL Missed Kick Bot

A small TypeScript bot that polls ESPN’s **public, keyless** NFL APIs and tweets whenever a kicker misses a field goal or a PAT / extra point.

It runs on its own — **GitHub Actions cron** dense-polls ESPN on NFL game days (Thursday–Monday UTC, plus early Tuesday UTC for late MNF), or you can use `npm start`. It does **not** use Cursor/Grok routines or X MCP credits.

A Cloudflare Worker in [`worker/`](worker/) is **optional / future**: once deployed it can `repository_dispatch` the same workflow only while a stored kickoff is in a live window. The bot does **not** need that Worker (or any Cloudflare credentials) to poll tonight. The Worker never tweets.

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
ESPN scoreboard
        │
        ▼
 GitHub Actions cron (primary) ──► poll.yml ──► TypeScript bot ──► X
  */5 Thu–Mon UTC                              (tweets)
  */5 Tue 00:00–07:59 UTC (late MNF)
        ▲
        │ optional later
 Cloudflare Worker ──if live──► repository_dispatch (`nfl-poll`)
  (not required; no Cloudflare credentials needed to poll)
```

1. **`poll.yml` cron is the primary wake.** It fires every 5 minutes Thursday–Monday UTC, plus Tuesday 00:00–07:59 UTC so late MNF that is still Monday evening in America/Denver stays covered. That window includes TNF, Friday/Saturday slates (internationals, Christmas), Sunday, and MNF. Tuesday after 08:00 UTC and all Wednesday have no Actions cron.
2. Each cron run hits the ESPN scoreboard. If nothing is in-progress or recently finished, the bot **exits after that one call** — no season-tally refresh, no per-game summaries.
3. The Worker in [`worker/`](worker/) is kept in-tree as an **optional** later wake: it can store ESPN kickoffs in KV and `repository_dispatch` `nfl-poll` only while a game is in a live window. It is **not** required for the bot to run. Publish it with **Actions → Deploy Cloudflare Worker → Run workflow** once `CLOUDFLARE_API_TOKEN` and `WORKER_GITHUB_PAT` are set.
4. Tweets stay in the TypeScript bot. The Worker never talks to X.

### How holidays are covered

Actions cron already runs all day Thursday–Monday UTC, so Thanksgiving, Christmas (when it lands Thu–Fri), Saturday internationals, and flex moves do not need a Worker. ESPN’s daily scoreboard lists those games; idle hours still exit after the scoreboard call.

| Example (2026, from ESPN) | Kickoff (UTC) | America/Denver | Actions cron? |
| --- | --- | --- | --- |
| Thanksgiving CHI @ DET | `2026-11-26T18:00:00.000Z` | Thu 11:00 AM MT | Thursday `*/5` |
| Thanksgiving PHI @ DAL | `2026-11-26T21:30:00.000Z` | Thu 2:30 PM MT | Thursday `*/5` |
| Christmas GB @ CHI | `2026-12-25T18:00:00.000Z` | Fri 11:00 AM MT | Friday `*/5` |
| Christmas BUF @ DEN | `2026-12-25T21:30:00.000Z` | Fri 2:30 PM MT | Friday `*/5` |
| TNF / flex / London | whatever ESPN posts that week | derived from UTC | Thu–Mon `*/5` |

A Sunday-only cron would miss all of those. Tue afternoon / Wednesday stay quiet because NFL kickoffs do not land then.

## Cloudflare Worker scheduler (optional / future)

Package: [`worker/`](worker/) (own `package.json`, `wrangler.jsonc`, TypeScript). **Do not delete it.** It is not the live wake source until someone deploys it with a GitHub PAT; GitHub Actions cron covers game days without it. The root bot package does not depend on a live Worker.

### What is stored in KV

| Key | Value |
| --- | --- |
| `slate` | `{ refreshedAt, source, seasonYear?, games: [{ id, kickoff, name, week, seasonType }] }` |
| `lastDispatchAt` | UTC ISO of the last GitHub `repository_dispatch` |

`kickoff` is always UTC ISO. Docs and dry-run output also show America/Denver.

### When the Worker runs (UTC crons)

Cloudflare cron is UTC. Operator timezone for reading the table is America/Denver.

| Cron | When (UTC) | Denver (approx.) | Job |
| --- | --- | --- | --- |
| `*/2 * * * THU,FRI,SAT,SUN,MON` | every 2 min Thu–Mon | Wed 5–6 PM through Mon evening | Read KV; dispatch if a kickoff is in the live window |
| `*/2 0-7 * * TUE` | every 2 min Tue 00:00–07:59 | Mon ~5–6 PM through ~12–1 AM Tue | Same tick — late MNF / OT still Monday local |
| `0 15 * * TUE,WED` | 15:00 Tue and Wed | ~8–9 AM | Refresh slate if empty / stale / next kickoff missing. **No dispatch.** |

There is **no** `*/2 * * * *` all-week cron. Tuesday after 08:00 UTC and all of Wednesday are refresh-only (the 15:00 job), not dense ticks.

### When the Worker dispatches

- **Yes (dense tick only):** at least one stored kickoff is inside `[kickoff − 30m, kickoff + 4h45m]` **and** it has not dispatched in the last 5 minutes.
- **No:** empty window → return immediately (KV read only). Midweek refresh cron never dispatches.
- **Refresh ESPN** (not every tick): slate missing/empty, `refreshedAt` older than 168 hours, or every stored kickoff is past the post-window *and* the last refresh was at least 6 hours ago (backoff so offseason does not hammer ESPN). The Tue/Wed 15:00 cron is what keeps KV current over the idle midweek.

`poll.yml` concurrency group `missed-kick-poll` still serializes overlapping Actions runs.

### Deploy Worker

GitHub Actions publishes `nfl-missed-kick-scheduler` and sets its `GITHUB_TOKEN` from existing repo secrets. After this workflow is on `main`:

1. Confirm repository secrets (Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN` — Workers Scripts Edit + Workers KV Storage Edit
   - `WORKER_GITHUB_PAT` — PAT that can `repository_dispatch` this repo
2. Optional: set repository variable `CLOUDFLARE_ACCOUNT_ID` if the token can see more than one Cloudflare account. The workflow auto-detects the account from the token when there is only one.
3. **Actions → Deploy Cloudflare Worker → Run workflow** (use the `main` branch).
4. The job deploys the Worker and pipes `WORKER_GITHUB_PAT` into the Worker secret `GITHUB_TOKEN` (the value is never echoed). After that, Worker cron ticks can `repository_dispatch` type `nfl-poll`.

`wrangler.jsonc` already points `SLATE` at KV namespace `nfl-missed-kick-slate` (`dc5248300f0c41898bba2959b3d5c314`). CI still does **not** deploy on push; it only typechecks, tests, and runs `wrangler deploy --dry-run`.

Local deploy remains available for debugging:

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
# optional: protect POST /tick and POST /refresh
npx wrangler secret put SCHEDULER_ADMIN_SECRET
npx wrangler deploy
```

Seed the slate immediately (otherwise the first Thu–Mon tick or the Tue/Wed refresh cron does it):

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
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json&cron=*/2+*+*+*+THU,FRI,SAT,SUN,MON"
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json&cron=0+15+*+*+TUE,WED"
```

### Cloudflare secrets and vars

**Secret** (Dashboard → Workers → Settings → Variables and Secrets, or `wrangler secret put`):

| Secret | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | PAT that can create a `repository_dispatch` on `kalb2/nfl-missed-kick-bot`. The deploy workflow sets this from repo secret `WORKER_GITHUB_PAT`. |
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

Workers free tier is enough: 2-minute ticks only Thu–Mon plus 8 hours Tuesday UTC (~3.8k invocations/week, not 7×720), one KV read per tick, ESPN on refresh / the Tue–Wed 15:00 cron, KV writes only on refresh / dispatch.

## GitHub Actions

Three workflows:

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | push / PR | root tests + Worker tests + `wrangler deploy --dry-run` |
| `poll.yml` | **cron (primary)** + optional Worker `repository_dispatch` (`nfl-poll`) + manual | one poll, cache `.state/seen.json` and `.state/tallies.json` |
| `deploy-worker.yml` | **manual** (Actions → Deploy Cloudflare Worker → Run workflow) | `wrangler deploy` + set Worker secret `GITHUB_TOKEN` from `WORKER_GITHUB_PAT` |

`poll.yml` dense-polls every **5 minutes** Thursday–Monday UTC, plus Tuesday 00:00–07:59 UTC for late MNF (Monday evening America/Denver). That is the live wake until a Cloudflare Worker is deployed. `repository_dispatch` type `nfl-poll` remains so the Worker can still wake it later.

Cron and Worker-driven `repository_dispatch` use the same live posting defaults: `DRY_RUN` and `SEED_SEEN` from repository variables (not the manual workflow inputs). Manual **Run workflow** still defaults `dry_run` to true so a dashboard click cannot tweet by accident.

If the scoreboard has no in-progress or recently finished game, the bot exits after the scoreboard call (no season-tally ESPN fan-out).

**Secrets** (same names as `.env` unless noted): `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`. Worker deploy additionally needs `CLOUDFLARE_API_TOKEN` and `WORKER_GITHUB_PAT` (piped into the Worker as `GITHUB_TOKEN`; never commit either value).

**Variables** (optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DRY_RUN` | `true` | Set `false` to actually tweet (cron / optional Worker / `npm start`) |
| `SEED_SEEN` | unset | Set `true` for one run to backfill without tweeting |
| `CLOUDFLARE_ACCOUNT_ID` | auto-detect | Only needed if `CLOUDFLARE_API_TOKEN` can see more than one account |

Actions state uses `actions/cache` on `.state/`. Caches can expire; the bot also ignores old finals (kickoff + ~4 hours + `RECENT_FINAL_WINDOW_MIN`), so a cache miss should not re-tweet last week. For the first live Sunday, run **Actions → Poll ESPN and tweet misses → Run workflow** with “Seed seen play IDs” enabled, then turn on posting.

Workflow concurrency is serialized so two wakes cannot double-tweet.

### Actions minutes vs always-on

GitHub’s shortest reliable cron is **5 minutes**. This repo uses that on Thu–Mon (plus early Tuesday UTC). Empty hours still spend an Actions minute on `npm ci` + one scoreboard fetch, then exit. A public repo is usually fine; a private repo’s 2,000 minute monthly quota can get tight. After a Worker is deployed you can drop the weekday crons again. Prefer `npm start` on a cheap always-on host if you want sub-minute latency:

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
