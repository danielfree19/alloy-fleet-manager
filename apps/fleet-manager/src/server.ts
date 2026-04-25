import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "./config.js";
import type { DbPool } from "./db/pool.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerCollectorRoutes } from "./routes/collectors.js";
import { registerConfigRoutes } from "./routes/configs.js";
import { registerAssignmentRoutes } from "./routes/assignments.js";
import { registerHeartbeatRoutes } from "./routes/heartbeats.js";
import { registerRolloutRoutes } from "./routes/rollouts.js";
import { registerAgentConfigRoutes } from "./routes/agent-configs.js";
import { registerPipelineRoutes } from "./routes/pipelines.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerRemotecfgRoutes } from "./remotecfg/routes.js";
import { reportValidatorCapability } from "./services/validator.js";
import { loadCatalog } from "./catalog/loader.js";

export interface BuildServerDeps {
  config: AppConfig;
  db: DbPool;
}

export async function buildServer({ config, db }: BuildServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        config.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
          : undefined,
    },
    disableRequestLogging: false,
    trustProxy: true,
  });

  await app.register(sensible);

  // Probe the alloy binary early so operators see one clear log line at
  // startup ("strict validation enabled" vs "DISABLED, falling back").
  // Without this they'd only find out on first pipeline write.
  reportValidatorCapability();

  // Load the template catalog once at boot. Doing it here (instead of
  // lazily on first request) means a malformed FLEET_CATALOG_URL fails
  // fast and is visible in the container's startup logs rather than
  // only surfacing for users browsing the UI catalog page.
  try {
    await loadCatalog();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    app.log.warn({ err: msg }, "failed to load template catalog; /catalog will 500");
  }

  // CORS. In development the Vite dev server runs on :5173 and needs to hit
  // the manager on :9090 with an `Authorization` header, so we allow it
  // explicitly. In production the UI is served from the same origin as the
  // API (fastify @fastify/static under /ui/) and CORS is effectively unused,
  // but we still allow it for operators who want to front the API with their
  // own tooling.
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allowed = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
      ];
      cb(null, allowed.includes(origin));
    },
    credentials: false,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Accept"],
  });

  // Set a JSON content-type for responses by default, EXCEPT for static
  // assets served by @fastify/static (which set their own content-type).
  app.addHook("onSend", async (req, reply) => {
    if (reply.getHeader("content-type")) return;
    if (req.url.startsWith("/ui")) return;
    reply.header("content-type", "application/json; charset=utf-8");
  });

  // ---- PRIMARY path: remotecfg + pipelines ---------------------------------
  await app.register(registerHealthRoutes);
  await app.register(registerPipelineRoutes(config, db), { prefix: "" });
  await app.register(registerAuditRoutes(config, db), { prefix: "" });
  await app.register(registerCatalogRoutes(config), { prefix: "" });
  await app.register(
    registerRemotecfgRoutes({ db, agentBearerToken: config.AGENT_BEARER_TOKEN }),
    { prefix: "" },
  );

  // ---- LEGACY path: REST agent model (preserved, not the primary mode) -----
  // Kept per project rule: "no rewriting code without checking if you don't
  // cancel old logic." Operators can still use the Node.js fleet-agent in
  // apps/fleet-agent against these endpoints. Documented in docs/legacy-agent.md.
  await app.register(registerCollectorRoutes(config, db), { prefix: "/legacy" });
  await app.register(registerConfigRoutes(config, db), { prefix: "/legacy" });
  await app.register(registerAssignmentRoutes(config, db), { prefix: "/legacy" });
  await app.register(registerHeartbeatRoutes(db), { prefix: "/legacy" });
  await app.register(registerRolloutRoutes(db), { prefix: "/legacy" });
  await app.register(registerAgentConfigRoutes(db), { prefix: "/legacy" });

  // ---- Static UI -----------------------------------------------------------
  // We look for a built UI bundle at one of:
  //   1. process.env.FLEET_UI_DIR (operator override)
  //   2. apps/fleet-ui/dist (relative to the repo when running from source)
  //   3. /app/apps/fleet-ui/dist (layout inside the fleet-manager Docker image)
  // When nothing is found we skip mounting — developers running the manager
  // without building the UI still get a working API.
  const uiDir = resolveUiDir();
  if (uiDir) {
    await app.register(fastifyStatic, {
      root: uiDir,
      prefix: "/ui/",
      wildcard: false,
    });

    // SPA fallback: any /ui/* path that didn't resolve to a real file gets
    // index.html so React Router can handle deep links like
    // /ui/pipelines/<uuid>. We read the html once at boot and cache it.
    const indexHtml = readFileSync(resolve(uiDir, "index.html"));
    app.get("/ui", (_req, reply) => reply.redirect("/ui/"));
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && req.url.startsWith("/ui/")) {
        return reply.type("text/html").send(indexHtml);
      }
      return reply.code(404).send({ error: "not_found" });
    });
    app.log.info({ uiDir }, "fleet-ui mounted at /ui/");
  } else {
    app.log.info("fleet-ui not built (no dist dir found); UI disabled");
  }

  return app;
}

function resolveUiDir(): string | null {
  const candidates: string[] = [];
  if (process.env.FLEET_UI_DIR) candidates.push(process.env.FLEET_UI_DIR);

  // server.ts sits at apps/fleet-manager/src/server.ts. From the compiled
  // location (apps/fleet-manager/dist/server.js) we walk up to the repo
  // root, then into apps/fleet-ui/dist.
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(resolve(here, "../../fleet-ui/dist"));
  candidates.push(resolve(here, "../../../fleet-ui/dist"));
  candidates.push("/app/apps/fleet-ui/dist");

  for (const c of candidates) {
    if (existsSync(resolve(c, "index.html"))) return c;
  }
  return null;
}
