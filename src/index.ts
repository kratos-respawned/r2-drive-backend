import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { runStorageCleanup } from "./lib/cleanup";
import files from "./routes/files";
import { HonoEnv } from "./types";
const app = new Hono<HonoEnv>();

app.use(
  "*", // or replace with "*" to enable cors for all routes
  cors({
    // hono's cors crashes on every request if origin is undefined
    origin: env.ORIGIN_URL ?? "http://localhost:5173",
    allowHeaders: ["Content-Type", "Authorization", "X-Include-Hidden"],
    allowMethods: ["POST", "GET", "OPTIONS", "DELETE", "PUT", "PATCH"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  }),
);


// "/*" (not "/**"): "**" is undocumented and only happens to match nested paths
// under RegExpRouter; when route shapes force SmartRouter onto TrieRouter it
// silently stops matching and every auth endpoint 404s
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.get("/", async (c) => {
  return c.json({ message: "R2 Drive API" });
});
app.get("/session", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const user = session?.user;
  if (!user) return c.body(null, 401);
  return c.json({
    session,
    user,
  });
});
app.route("/api/files", files);

export default {
  fetch: app.fetch,
  scheduled: (_controller, _env, ctx) => {
    ctx.waitUntil(runStorageCleanup());
  },
} satisfies ExportedHandler<CloudflareBindings>;
