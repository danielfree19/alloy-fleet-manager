import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import { createHash } from "node:crypto";
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
import { registerAuthRoutes } from "./routes/auth.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { registerRemotecfgRoutes } from "./remotecfg/routes.js";
import { registerSsoRoutes } from "./routes/sso.js";
import { registerSsoAdminRoutes } from "./routes/sso-admin.js";
import { reportValidatorCapability } from "./services/validator.js";
import { loadCatalog } from "./catalog/loader.js";
import { bootstrapFirstAdmin } from "./auth/bootstrap.js";
import { purgeExpiredSessions } from "./auth/sessions.js";
import { assertSsoYamlIsSafe, loadSsoYaml } from "./auth/sso/config.js";
import { buildProviderRegistry } from "./auth/sso/registry.js";

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
      // Defense-in-depth: even though no current handler logs request
      // bodies or auth headers explicitly, Fastify's default request
      // serializer already touches `req.headers` and a future contributor
      // might add `req.log.info({ body })` to a payload route. Redact
      // anything that would leak a secret on the wire.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'req.headers["set-cookie"]',
          "res.headers.authorization",
          'res.headers["set-cookie"]',
          "req.body.password",
          "req.body.current_password",
          "req.body.new_password",
          "req.body.client_secret",
          "req.body.token",
          "*.password_hash",
          "*.token_hash",
        ],
        remove: true,
      },
    },
    disableRequestLogging: false,
    trustProxy: true,
  });

  await app.register(sensible);

  // Security headers. Same-origin static UI lives at /ui/, so a CSP
  // tied to 'self' is correct for both the React bundle and the API
  // responses. `frame-ancestors 'none'` blocks clickjacking against
  // the admin UI; HSTS is gated by the response actually going over
  // TLS (handled by helmet via the request scheme — `trustProxy: true`
  // above ensures the original scheme is honored when the manager is
  // behind a reverse proxy).
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Vite's prod build emits hashed JS modules; no inline scripts.
        scriptSrc: ["'self'"],
        // Tailwind compiles to a single stylesheet; no runtime style
        // injection. Allow 'unsafe-inline' here would soften CSP
        // meaningfully — keep it strict and revisit only if a real
        // runtime style is added.
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // 1 year HSTS with includeSubDomains. The `preload` flag is left
    // off because shipping with preload requires operator opt-in.
    strictTransportSecurity: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: false,
    },
    // Helmet defaults are mostly fine; the explicit ones below pin
    // expected behavior so a future helmet upgrade doesn't quietly
    // change them.
    referrerPolicy: { policy: "no-referrer" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    // The X-XSS-Protection header is deprecated and can introduce
    // bugs in some browsers — turn it off explicitly.
    xXssProtection: false,
  });

  // Rate limiter. Registered as a *global* plugin so individual routes
  // can opt in via { config: { rateLimit: {...} } } on the route
  // options. We deliberately do NOT set a global rate limit — Alloy's
  // remotecfg poll is high-frequency by design and would trip a
  // naive global cap. Per-route opt-in is applied to /auth/login and
  // /auth/sso/start/:id; everything else is unlimited (the auth layer
  // is the gate that matters here).
  await app.register(rateLimit, {
    global: false,
    // @fastify/rate-limit honors `req.ip` which respects `trustProxy`
    // already set above, so the limit is per real client IP behind
    // a reverse proxy.
    keyGenerator: (req) => req.ip,
  });

  // Cookie plugin: required by /auth/login, /auth/logout, and the
  // session-cookie path in the auth middleware. The signing secret is
  // the configured SESSION_COOKIE_SECRET, or — to keep zero-config
  // deployments working — a stable derivation from ADMIN_TOKEN. Any
  // operator who rotates ADMIN_TOKEN gets all sessions invalidated,
  // which is the conservative default.
  // `||` not `??`: any falsy value (empty string from compose's `:-`
  // fallback, an explicit `""`, etc.) must fall through to the derived
  // secret. With `??` we'd register the cookie plugin with `secret: ""`,
  // which silently disables signing and 500s the first /auth/login.
  // The schema also coerces empty -> undefined as belt-and-suspenders.
  const cookieSecret =
    config.SESSION_COOKIE_SECRET ||
    createHash("sha256").update(`session:${config.ADMIN_TOKEN}`).digest("hex");
  await app.register(fastifyCookie, { secret: cookieSecret });

  // Bootstrap a first admin user when the users table is empty. No-op
  // on every subsequent boot. Runs BEFORE we mount routes so the API
  // is never reachable in a "no users + no env token" state.
  await bootstrapFirstAdmin(
    db,
    app.log,
    config.BOOTSTRAP_ADMIN_EMAIL,
    config.BOOTSTRAP_ADMIN_PASSWORD,
  );

  // Hourly cleanup of expired sessions. Cheap and best-effort; we
  // explicitly don't await this anywhere on the request path.
  const sessionGc = setInterval(
    () => {
      void purgeExpiredSessions(db).catch((err) => {
        app.log.warn({ err }, "session GC failed");
      });
    },
    60 * 60 * 1000,
  );
  app.addHook("onClose", async () => clearInterval(sessionGc));

  // -------------------------------------------------------------------
  // Phase 2: SSO
  // -------------------------------------------------------------------
  // Load the YAML config (if any) and build the provider registry.
  // The registry seeds DB rows for YAML-defined providers on first
  // boot; subsequent UI edits flip them to source='ui' and shadow
  // the YAML defaults. When neither YAML nor DB has any providers
  // the registry is empty and `/auth/providers` returns `[]` —
  // the existing email+password / token paste flows are unaffected.
  let ssoYaml: Awaited<ReturnType<typeof loadSsoYaml>> = null;
  try {
    ssoYaml = loadSsoYaml(config.SSO_CONFIG_FILE);
    if (ssoYaml) {
      // SSRF guard at config load: any issuer that resolves into a
      // private/loopback range fails the boot. The runtime `lookup`
      // hook in `auth/sso/oidc.ts` is the second line of defense for
      // DNS-rebind / redirect cases that slip past pre-flight.
      await assertSsoYamlIsSafe(ssoYaml);
      app.log.info(
        { path: config.SSO_CONFIG_FILE, providers: ssoYaml.providers.length },
        "SSO YAML loaded",
      );
    }
  } catch (err) {
    // A bad SSO YAML must NOT take down the manager — operators
    // would lose every other auth path with it. Log loudly, skip.
    app.log.error({ err }, "failed to load SSO YAML; SSO will be disabled this boot");
    ssoYaml = null;
  }
  const ssoRegistry = await buildProviderRegistry(db, ssoYaml);

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
    // credentials: true is required so the Vite dev server (5173) can
    // include the session cookie when calling the manager (9090).
    // In production the UI is same-origin (served from /ui under the
    // manager) so CORS isn't even consulted.
    credentials: true,
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
  // Identity routes go first; they don't depend on permissions.
  await app.register(registerAuthRoutes(config, db), { prefix: "" });
  // SSO public surface is always registered (returns [] when no
  // providers are configured) so the UI's `/auth/providers` fetch
  // is uniform whether SSO is on or off.
  await app.register(
    registerSsoRoutes({ config, db, registry: ssoRegistry }),
    { prefix: "" },
  );
  await app.register(
    registerSsoAdminRoutes({ config, db, registry: ssoRegistry }),
    { prefix: "" },
  );
  await app.register(registerUserRoutes(config, db), { prefix: "" });
  await app.register(registerTokenRoutes(config, db), { prefix: "" });
  await app.register(registerPipelineRoutes(config, db), { prefix: "" });
  await app.register(registerAuditRoutes(config, db), { prefix: "" });
  await app.register(registerCatalogRoutes(config, db), { prefix: "" });
  await app.register(
    registerRemotecfgRoutes({
      db,
      agentBearerToken: config.AGENT_BEARER_TOKEN,
      adminToken: config.ADMIN_TOKEN,
    }),
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
