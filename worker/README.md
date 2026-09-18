# NFL slate scheduler (Cloudflare Worker)

Wakes [`../.github/workflows/poll.yml`](../.github/workflows/poll.yml) only when the stored ESPN slate says a game is in a live window. It does **not** tweet.

See the root [README](../README.md#cloudflare-worker-scheduler) for architecture, secrets, and deploy steps.

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
