# NFL slate scheduler (Cloudflare Worker)

Optional later wake for [`../.github/workflows/poll.yml`](../.github/workflows/poll.yml): when deployed, it dispatches only when the stored ESPN slate says a game is in a live window. It does **not** tweet.

**Live polling does not require this Worker.** `poll.yml` has its own Thursday–Monday (plus early Tuesday UTC) GitHub Actions cron until someone deploys here with a GitHub PAT. Keep this package in-tree.

See the root [README](../README.md#deploy-worker) to publish from **Actions → Deploy Cloudflare Worker → Run workflow**. Architecture and secrets are in [Cloudflare Worker scheduler](../README.md#cloudflare-worker-scheduler-optional--future).

```bash
npm install
npm test
npm run typecheck
npm run dry-run
npm run dry-run -- --at 2026-11-26T18:05:00Z
npx wrangler dev --test-scheduled
# then: curl http://localhost:8787/status
#       curl -X POST http://localhost:8787/tick
#       curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json&cron=*/2+*+*+*+THU,FRI,SAT,SUN,MON"
#       curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json&cron=0+15+*+*+TUE,WED"
#
# Dense ticks: Thu–Mon UTC every 2 min + Tue 00:00–07:59 UTC (late MNF).
# Midweek: refresh-only cron, no 2-minute wakes.
```
