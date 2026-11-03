# Season miss leaders

Weekly graphic of the 2026 regular-season leaders in missed field goals and missed extra points. The same rules as the on-box scan:

- Blocked field goals (ESPN type id `18`) and blocked PATs (`pointAfterAttempt` id `43`) count as misses.
- A kick erased by a penalty or a "No Play" / nullified / replayed-down ruling is skipped and listed in `skippedErasedPlays`. A flag enforced between downs still counts.
- Kickers in `kicker-exclude.json` stay in the season totals and are left off the board. Harrison Mevis (ESPN id `4574716`) is the current entry.
- Rank is total misses, then FG misses, then the kicker's name A–Z.
- Official season FGA/FGM/XPA/XPM come from `sports.core.api.espn.com`. A percentage line is printed only when those misses match the board (`PCT_MISMATCH` omits the line; `PCT_STATUS` is `ok`, `partial`, or `fallback`).

The PNG is 2160×3920 (1080×1960 CSS at scale 2). Field goals are `#1B4F8A`, extra points are `#8ECAE6`. In-bar labels look like `3 - 1 BLK` with no parentheses. Team logos are the PNGs in `logos/`, committed in the repo. The renderer refuses to shoot a board when one of those files is missing, so a wiped `/tmp` cannot blank the logos again.

This tool never posts to X. `regenerate.sh` and the GitHub workflow only write files. Download the PNG and upload it yourself. The suggested caption is `suggested-post.txt`.

## One command

```bash
bash board/regenerate.sh
```

Or `npm run board`. Output lands in `board/out/`:

| File | What |
| --- | --- |
| `season-miss-leaders-top10.png` | The graphic |
| `season-miss-leaders.json` | Top 10, block splits, percentage lines, suggested post |
| `season-miss-all.json` | Every kicker, Fitzgerald, skipped kicks |
| `suggested-post.txt` | Caption to paste with the image |
| `leaders.html` | Page the screenshot is taken from |
| `rescan-report.json` | Scan the PNG was built from |
| `espn-kicking-stats.json` | Official kicking totals used for the percentage lines |

`SHOW_PCT=0` is the shorter 2160×3360 layout. `SKIP_RESCAN=1` reuses an existing report. `PCT_STATS=path.json` skips the stats fetch. `RESCAN_MAX_WEEK=8` stops the scan at that week (blank uses the Tuesday auto week: days since 2026-09-08, divided by 7).

## Tests

```bash
npm run test:board
```

Fixtures in `fixtures/` are the 2026-11-03 scan (`rescan-report.json`, `rescan-all-misses.json`, `espn-kicking-stats.json`) and the Week 1–4 `all-miss-plays.json` catalog, which includes the Myers kick ESPN typed as a penalty / "No Play".

## GitHub Actions

**Actions → Season miss leaders board → Run workflow.** `workflow_dispatch` only. The job uploads the PNG, the JSON summary, and the suggested post as the `season-miss-leaders` artifact. It does not tweet and it does not wake `poll.yml`.
