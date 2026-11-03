# Reliability audit

Checked on 2026-11-03 against the code in this branch and the live worker. Nothing here was deployed, no secret was changed, and no tweet or `repository_dispatch` was sent.

The worker status page at 21:30 UTC that day was:

- `refreshedAt`: `2026-11-01T17:44:10.000Z` (about 52 hours earlier)
- `gameCount`: 43
- `nextKickoff`: `2026-11-06T01:15:00.000Z`
- `live`: empty
- `lastDispatchAt`: `2026-11-03T05:58:10.000Z` (end of the Monday-night window)
- `hasGithubToken`: true

Tuesday's refresh cron is `0 15 * * TUE,WED` (`worker/src/cron.ts` line 15). 15:00 UTC had already passed. The slate timestamp did not move. That is the bug below, and it is the same shape as the Nov 1 report (slate still showing Oct 25). Nov 1 17:44 UTC is exactly 168 hours after Oct 25 17:44 UTC, which is the old "refresh if older than 7 days" rule. The Tue Oct 27 and Wed Oct 28 runs did not refresh either.

Poll history from GitHub Actions, same week:

| Day | `schedule` runs | `repository_dispatch` runs |
| --- | --- | --- |
| Sun Nov 1 | 5 (02:39, 09:41, 16:22, 20:37, 23:51 UTC) | 65 |
| Mon Nov 2 | 3 | 61 |

The Actions cron is registered every 5 minutes (`poll.yml` lines 20–21) but GitHub started it hours apart. During games the worker's dispatch, about every 6 minutes, is what actually polls. A worker that stops dispatching does not fall back to a 5-minute poll.

## High

### 1. The midweek slate refresh runs and then does nothing

**What happens.** Dense ticks refresh ESPN only when the slate is empty, older than the max age, or every stored kickoff is already past the window (`worker/src/window.ts` lines 102–130, `slate-fresh` at line 130). The Tue/Wed cron called that same check. A slate that still has next week's games and is younger than the max age returns `slate-fresh` and never calls ESPN. Lookahead is 16 days, so a Sunday refresh already contains the next Thursday game. The cron still fires. `refreshedAt` stays put. `/status` keeps showing a full slate and a plausible next kickoff.

That is why Nov 1 still showed Oct 25 until the 168-hour mark, and why Nov 3 at 21:30 UTC still showed Sunday's refresh after the Tuesday 15:00 UTC cron.

**Why it matters.** A flex or a reschedule after that Sunday fetch is invisible to the worker until the max age elapses. The worker then wakes Actions at the old kickoff and not at the new one. Because the Actions cron is hours apart, a game the worker does not wake can be missed entirely.

**Fix in this PR.** The Tue/Wed cron always fetches ESPN (`worker/src/scheduler.ts` lines 150–155, `maybeRefresh(..., "always")`). Dense ticks now treat a slate older than 48 hours as stale (`worker/src/config.ts` line 14, `worker/wrangler.jsonc` `SLATE_MAX_AGE_HOURS`). This does not take effect until the existing **Deploy Cloudflare Worker** workflow is run. This PR does not deploy it.

### 2. A bad ESPN refresh can wipe a good slate, and a thrown refresh used to skip dispatch

**What happens.** `fetchNflSlate` replaces KV with whatever the scoreboard returned (`worker/src/espn.ts`). An empty or truncated 200 used to overwrite the 43-game slate. The scheduled handler catches errors and only logs them (`worker/src/index.ts` lines 140–147), so a thrown refresh also skipped the dispatch that tick.

**Why it matters.** One bad scoreboard during a game both forgets kickoffs and, on that tick, does not wake the poll.

**Fix in this PR.** An empty board is rejected when upcoming games are already stored (`worker/src/window.ts` lines 86–94). Games the new board simply omitted are kept; a new kickoff for the same id is kept (`worker/src/window.ts` the `applySlateRefresh` merge). A failed refresh records `lastRefreshError`, leaves the old slate, and the tick still dispatches (`worker/src/scheduler.ts` lines 137–146). Dense ticks wait 6 hours before calling ESPN again after a failure (`worker/src/scheduler.ts` lines 111–117) so a dead ESPN is not hit every 2 minutes. Needs the same worker deploy.

### 3. GitHub PAT expiry is silent, and dispatch is the real poller

**What happens.** `WORKER_GITHUB_PAT` is checked only when someone runs Deploy Cloudflare Worker. After that, a 401 is returned as `dispatch-failed` and logged. `/status` kept `hasGithubToken: true` (the secret is set, it is just rejected) and did not store the error. Nothing opened a `bot-alert` issue. The PAT cannot open an issue itself once GitHub is rejecting it.

**Why it matters.** Sunday's 5 schedule runs were 3–7 hours apart, against 65 dispatches. A dead PAT drops the bot into those gaps. A miss that ESPN publishes between two late cron runs can fall outside the watch window with no push notification.

**Fix in this PR.** Each poll (the Actions `GITHUB_TOKEN`, which already has `issues: write`) reads the public status page and opens one `[bot-alert]` issue labeled `scheduler-unhealthy` when:

- the slate is missing or older than 72 hours
- `lastRefreshError` or `lastDispatchError` is set (those fields appear after the worker deploy)
- a game has been inside the live window for 15 minutes and the last successful dispatch is older than that

(`src/scheduler-health.ts` lines 36–71, called from `src/index.ts` line 166). The issue closes itself when status looks fine. It never tweets. Until the worker is redeployed, a dead PAT is still caught by the stale-`lastDispatchAt` rule, but only on the next Actions schedule run, which can be hours later. A worker that is completely down (status page unreachable) is logged and not alerted, so a one-off network blip does not page you.

### 4. A run that dies after the write-ahead claim never tweets and never alerts

**What happens.** Before posting, the play is saved as `posting` (`src/poll.ts` line 391). Any later poll treats the play as handled (`src/store.ts` `has()`). If the job is killed after that save and before `posted` or `failed` is saved, the tweet may or may not have gone out, and the next poll skips it with no issue. The workflow timeout is 10 minutes (`poll.yml`).

**Why it matters.** That is a missed tweet with no `bot-alert` push. Retrying the tweet could double-post, so the old code chose silence.

**Fix in this PR.** A `posting` claim older than 15 minutes opens one `tweet_failed` issue and is marked `failed`. It is not tweeted again (`src/poll.ts` lines 47–54 and `recoverAbandonedPostings`).

### 5. The worker stopped waking polls at kickoff + 4h45, including delays and overtime

**What happens.** While ESPN still says `in`, the bot keeps watching no matter how late it is (`src/espn.ts` line 392). The worker did not. It stopped dispatching at kickoff + 285 minutes. A weather delay or a long overtime that is still in progress after that loses the 6-minute poll and falls back to the sparse Actions cron. Quarter text for overtime is already correct (`src/detect.ts` `formatQuarter`, period 5 → `OT`).

**Fix in this PR.** Dispatch window and the bot's post-game watch are both 6 hours (`worker/src/config.ts` line 10, `POST_KICKOFF_MIN` 360, `src/espn.ts` `GAME_WATCH_BASE_MIN` 315 plus the 45-minute recent-final window). In-progress games were already uncapped. A delay past 6 hours is still only covered by the sparse cron.

## Medium

### ESPN slow, down, or partial during a game

Each ESPN call aborts at 15 seconds (`src/espn.ts` `FETCH_TIMEOUT_MS`, and the same in `worker/src/espn.ts` line 8) and tries the backup host. A scoreboard failure throws out of `pollOnce`. The workflow goes red. There is no `bot-alert` issue for that, unlike state failures. One bad poll is retried on the next wake. A multi-hour ESPN outage is a series of red runs, which you only see if Actions failure mail is on.

A single game whose summary throws is a `console.warn` and that game is skipped for that poll (`src/poll.ts` line 253). The next poll tries again. If the last successful poll in the window got a partial drive list that omitted the miss, the miss is not detected and nobody is alerted.

The same-run recheck (60s, one wait per run) drops a miss that ESPN erases before the re-fetch, and holds it for the next poll if the re-fetch itself fails. That path is in good shape. It does not invent a miss from a partial payload.

**Recommendation.** Open one deduped `bot-alert` when the scoreboard has failed on consecutive polls, and close it when a poll succeeds. Do not alert on a single 15-second timeout. Do not change miss detection.

### X API errors, 429s, duplicates, retries

`src/twitter.ts` posts once. Any throw, including HTTP 429, is caught in `src/poll.ts` (the "Don't retry" comment near line 421). The play is marked `failed` and a `tweet_failed` issue is opened. That is deliberate: a timeout can mean X accepted the tweet. A 429 means X rejected it, so a single retry of that status would be safe and would avoid a manual post. Other errors should stay manual.

Duplicates: the write-ahead claim plus `has(playId)` stops a second tweet when the run finishes. Dry runs do not write the GitHub state. This PR does not change tweet text or what counts as a miss.

### Two polls at once, and races on `bot-state`

`poll.yml` lines 43–45 use one concurrency group and do not cancel the in-progress run, so a cron run and a dispatch queue instead of overlapping. The state write sends the blob sha and throws on a non-2xx, including 409 (`src/state-backend.ts` line 127). The run then posts nothing and opens `bot-state-unavailable`. That is the right failure. There is no in-run retry, so that run's other new misses wait for the next poll.

A local `npm start` with the same token can still 409 against Actions. Fail closed is correct. Do not merge the two copies automatically.

If polls queue because `npm ci` plus a 60-second recheck runs long, tweets get later. They are not duplicated.

### Flex, international kickoffs, holidays, Saturday, postseason

Flex inside the old 7-day window was the high finding above. After the 48-hour change, a kickoff edit is picked up on the next Tue/Wed cron or once the slate is 48 hours old, whichever comes first. A flex announced inside that 48 hours still uses the stored time until then. The merge keeps an omitted game at its old time rather than deleting it, so a partial board cannot drop a game, but it also cannot show a new time for a game ESPN left out.

Thursday–Monday UTC plus Tuesday 00:00–07:59 covers Thanksgiving 2026 (Thursday), Christmas 2026 (Friday), Saturday internationals, and a Sunday London kickoff. Tests: `worker/test/cron.test.ts`, `worker/test/window.test.ts`. There is no Wednesday cron. The NFL does not kick off then. An early Saturday or Sunday kickoff is inside the dense window as long as the stored time is right.

Postseason weeks are included. The worker calendar skips ESPN season type 4 (offseason) only (`worker/src/espn.ts` line 84). The bot watches whatever the current scoreboard marks in progress, including postseason. The Season line is attached only for regular season (`src/poll.ts` lines 475–477). That matches the existing tally rule and was not changed. Preseason games on the current scoreboard would be tweeted if one is in progress. Tallies stay regular-season only.

At most 3 calendar weeks are fetched per refresh (`worker/src/espn.ts` line 10). Sixteen days of lookahead is about three NFL weeks. A fourth overlapping week would be dropped.

### `DRY_RUN` defaults to true

`poll.yml` line 90 uses `vars.DRY_RUN || 'true'`. If that variable is missing, the run is green, tweets nothing, and does not open issues (issue creation is skipped on dry runs). The live dispatch history is consistent with `DRY_RUN=false` being set. Worth knowing if the variable is ever cleared.

### Free-plan Worker CPU

Cloudflare's free plan allows 10 ms of CPU per cron invocation. Waiting on ESPN does not count; parsing several scoreboards can. The README says the free tier is enough. This audit did not confirm the account plan. The Nov 3 stale slate is explained by the no-op refresh, not by a CPU kill: a no-op never parses ESPN. If a real refresh is killed, `lastRefreshError` may never be saved. The 72-hour status alert is the backstop. Do not add a paid plan for this.

## Low

- **Actions cache key is the run id** (`poll.yml` `missed-kicks-${{ github.run_id }}`). Every run writes a new cache. Tallies rebuild from ESPN. The handled-play list is on `bot-state`, not in the cache.
- **Core play list is capped at 400** (`src/espn.ts` line 21). A normal game, including overtime, is well under that. The site summary is the primary feed.
- **Season tally fetch failure** logs a warning (`src/tallies.ts`) and can undercount the Season line. The miss is still tweeted. Counting rules were not changed.
- **Holiday and overtime labels** are covered, as above. Blocked kicks still count. Penalty-erased kicks still do not. An unnamed kicker is still not guessed.
- **Worker logs** already include the dispatch error string. `/status` now also returns `lastRefreshError`, `lastDispatchError`, and `slateAgeHours`, after deploy.

## What was left alone

Tweet wording, field-goal and PAT detection, block counting, penalty / No Play / reversed handling, and the "never guess the kicker" rule. No webhook, no new secret, no new paid service. Alerting stays a `bot-alert` GitHub issue, which is the push you already get.

## What you need to do for the fixes to be live

Merging (when you want to) turns on the poll-side health issue and the abandoned-`posting` alert. The slate refresh and the 6-hour window change when you run **Actions → Deploy Cloudflare Worker** on `main`. That is the same button as today. It also re-checks `WORKER_GITHUB_PAT`. This PR does not run it.
