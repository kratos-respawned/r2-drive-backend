import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import files from "./routes/files";
import { HonoEnv } from "./types";
const app = new Hono<HonoEnv>();

app.use(
  "/api/auth/*", // or replace with "*" to enable cors for all routes
  cors({
    origin: env.ORIGIN_URL, // replace with your origin
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["POST", "GET", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/**", (c) => auth.handler(c.req.raw));
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

export default app;
