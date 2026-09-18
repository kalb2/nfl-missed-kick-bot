import { configFromEnv } from "./config.js";
import { dispatchRepositoryEvent } from "./github.js";
import { handleScheduled, loadLastDispatchAt, loadSlate, logTick, refreshStoredSlate, runTick } from "./scheduler.js";
import type { SchedulerDeps } from "./scheduler.js";
import { gamesInWindow, nextKickoffIso } from "./window.js";

function depsFromEnv(env: Env): SchedulerDeps {
  const config = configFromEnv(env);
  return {
    kv: env.SLATE,
    config,
    github: {
      dispatch: (input) => dispatchRepositoryEvent(input),
    },
  };
}

async function authorize(request: Request, secret: string): Promise<boolean> {
  if (!secret) return true;
  const header = request.headers.get("Authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function statusPayload(env: Env, nowMs: number): Promise<Record<string, unknown>> {
  const config = configFromEnv(env);
  const slate = await loadSlate(env.SLATE);
  const lastDispatchAt = await loadLastDispatchAt(env.SLATE);
  const live = slate ? gamesInWindow(slate.games, nowMs, config) : [];
  return {
    ok: true,
    now: new Date(nowMs).toISOString(),
    zoneNote: "Kickoffs are UTC ISO. Operator timezone for docs is America/Denver.",
    tweets: false,
    refreshedAt: slate?.refreshedAt ?? null,
    gameCount: slate?.games.length ?? 0,
    live: live.map((game) => ({ id: game.id, name: game.name, kickoff: game.kickoff })),
    nextKickoff: slate ? (nextKickoffIso(slate.games, nowMs) ?? null) : null,
    lastDispatchAt: lastDispatchAt ?? null,
    github: `${config.githubOwner}/${config.githubRepo}`,
    eventType: config.githubEventType,
    crons: {
      denseTick: "Thu–Mon UTC every 2 min + Tue 00:00–07:59 UTC (late MNF / Monday Denver)",
      refreshOnly: "Tue+Wed 15:00 UTC — slate refresh, no dispatch",
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const nowMs = Date.now();
      const config = configFromEnv(env);

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) {
        return json(await statusPayload(env, nowMs));
      }

      if (request.method === "POST" && (url.pathname === "/tick" || url.pathname === "/refresh")) {
        if (!(await authorize(request, config.adminSecret))) {
          return json({ error: "Unauthorized" }, 401);
        }
        const deps = depsFromEnv(env);
        if (url.pathname === "/refresh") {
          const result = await refreshStoredSlate(deps, nowMs);
          const tick = await runTick(deps, nowMs);
          logTick(tick);
          return json({ refreshed: result.slate, tick });
        }
        const tick = await runTick(deps, nowMs);
        logTick(tick);
        return json(tick);
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(JSON.stringify({ message: "unhandled error", error: message }));
      return json({ error: "Internal server error" }, 500);
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const nowMs = controller.scheduledTime || Date.now();
    const tick = await handleScheduled(controller.cron, depsFromEnv(env), nowMs);
    logTick(tick);
  },
} satisfies ExportedHandler<Env>;
