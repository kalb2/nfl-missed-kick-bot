# NFL Missed Kick Bot

A small TypeScript bot that polls ESPN’s **public, keyless** NFL APIs and tweets whenever a kicker misses a field goal or a PAT / extra point.

It runs on its own — GitHub Actions cron and/or `npm start`. It does **not** use Cursor/Grok routines or X MCP credits.

## What it tweets

```
❌ Missed FG
Kicker: D.Carlson (NO)
Kick: 62 yards
Result: Wide Right
When: Q4 0:02
Score: NO 24-24 DET
#Saints #OnePride
```

```
❌ Missed FG
Kicker: J.Sanders (NYJ)
Kick: 54 yards
Result: Wide Left
When: Q2 2:44
Score: NYJ 10-3 TEN
#TakeFlight #Titans
```

```
❌ Missed PAT
Kicker: S.Shrader (IND)
Result: Wide Right
When: Q1 10:33
Score: BAL 0-6 IND
#ForTheShoe #RavensFlock
```

Those three are real Week 1 (2026-09-13) misses, taken from ESPN play-by-play. Each alert is labeled line-by-line (PAT omits the Kick/distance line) and ends with official primary season hashtags for both teams — kicking team first, never raw abbreviations like `#NO`. Those tags trigger custom team emojis on X. Tweets stay under 280 characters and are **plain text with no URLs** — X pay-per-use charges more for posts that include links.

## How detection works

1. **Scoreboard** — list in-progress games and recently finished ones.
2. **Game summary** — fetch drives/plays for each watched game.
3. **Missed FG** — a play whose `type.text === "Field Goal Missed"` (type id `"60"`), e.g.  
   `D.Carlson 62 yard field goal is No Good, Wide Right, Center-Z.Wood, Holder-R.Wright.`
4. **Missed PAT** — prefer structured `pointAfterAttempt.id === 62` / text `Extra Point Missed` when present (often *on the touchdown play*). Also treat play text matching `extra point is No Good` as a backup when ESPN omits `pointAfterAttempt`.  
   **Extra Point Good (`id` 61) is never treated as a miss.** Key off `id` / `text`, not `value` — ESPN sometimes sets `value: 1` on a miss.
5. Plays are collected from `drives.previous`, `drives.current`, and any other `plays[]` arrays in the payload.
6. Each miss is keyed by ESPN play `id` and persisted so the same kick is never tweeted twice.

Team comes from `teamParticipants` (`type === "offense"`) matched to the game’s competitors. Distance is parsed from the play text (FG only). Result detail (Wide Left / Right, Short, Blocked, Hit Right Upright, …) is parsed from the `No Good, …` clause.

## ESPN endpoints (unofficial)

These endpoints are **undocumented public JSON**. ESPN can change or rate-limit them at any time. This bot is a good citizen: two summary fetches at a time, ~20s in-memory cache per game, 30s default poll interval.

| Purpose | URL |
| --- | --- |
| Scoreboard | `GET https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard` |
| Game summary (primary) | `GET https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={eventId}` |
| CDN play-by-play (fallback) | `GET https://cdn.espn.com/core/nfl/playbyplay?xhr=1&gameId={eventId}` |
| Core plays list (fallback) | `GET https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{eventId}/competitions/{eventId}/plays?limit=400` |

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

Prints today’s misses from the live scoreboard without posting. Uses `--fresh` so a leftover `.state` file does not hide them:

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

**Cost tip:** keep tweets as plain-text alerts (kicker, distance, result, clock, score, official team season hashtags). Do not add ESPN or highlight URLs — X pay-per-use bills more for posts that contain links.

## GitHub Actions

Two workflows:

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | push / PR | `npm test` + typecheck |
| `poll.yml` | cron + manual | one poll, cache `.state/seen.json` |

`poll.yml` runs about every **5 minutes** during NFL windows (Sunday all day UTC, plus Thu/Fri and Mon/Tue overnight for TNF / SNF / MNF). If the scoreboard has no in-progress or recently finished game, it exits after the scoreboard call.

**Secrets** (same names as `.env`): `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`.

**Variables** (optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DRY_RUN` | `true` | Set `false` to actually tweet |
| `SEED_SEEN` | unset | Set `true` for one run to backfill without tweeting |

Actions state uses `actions/cache` on `.state/`. Caches can expire; the bot also ignores old finals (kickoff + ~4 hours + `RECENT_FINAL_WINDOW_MIN`), so a cache miss should not re-tweet last week. For the first live Sunday, run **Actions → Poll ESPN and tweet misses → Run workflow** with “Seed seen play IDs” enabled, then turn on posting.

Workflow concurrency is serialized so two crons cannot double-tweet.

### Actions minutes vs always-on

GitHub’s shortest reliable cron is **5 minutes**. A public repo is usually fine; a private repo’s 2,000 minute monthly quota can get tight if every Sunday is a full-day cron. Prefer `npm start` on a cheap always-on host if you want sub-minute latency or need to save Actions minutes:

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
| `STATE_PATH` | `.state/seen.json` | Seen play IDs |
| `RECENT_FINAL_WINDOW_MIN` | `45` | Extra time after a ~4h game |
| `SEED_SEEN` | `false` | Record misses, do not tweet |
| `ESPN_USER_AGENT` | bot UA | Override if ESPN blocks |

## Development

```bash
npm test
npm run typecheck
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
