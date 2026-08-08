import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, createTestUser, PASSWORD, setupOutboundMocks } from "./helpers";

// ORIGIN_URL in vitest.config.ts — the web frontend's origin
const WEB_ORIGIN = "http://localhost:5173";

let email: string;
let cookie: string;

beforeAll(async () => {
  setupOutboundMocks();
  ({ email, cookie } = await createTestUser());
});

const signIn = (origin?: string) =>
  SELF.fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ email, password: PASSWORD }),
  });

describe("origin policy", () => {
  it("accepts sign-in with the API's own origin (native client)", async () => {
    expect((await signIn(BASE_URL)).status).toBe(200);
  });

  it("accepts sign-in with the web origin", async () => {
    expect((await signIn(WEB_ORIGIN)).status).toBe(200);
  });

  it("accepts cookie-bearing auth requests with the API's own origin", async () => {
    // burner user: signing out invalidates the cookie, so don't use the shared one
    const burner = await createTestUser();
    const res = await SELF.fetch(`${BASE_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: burner.cookie, Origin: BASE_URL },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("rejects cookie-bearing auth requests from an untrusted origin", async () => {
    const res = await SELF.fetch(`${BASE_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "https://evil.example.com" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("returns the session with the API's own origin", async () => {
    const res = await SELF.fetch(`${BASE_URL}/api/auth/get-session`, {
      headers: { Cookie: cookie, Origin: BASE_URL },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { email: string } } | null;
    expect(body?.user?.email).toBe(email);
  });

  it("serves files routes with the API's own origin", async () => {
    const res = await SELF.fetch(`${BASE_URL}/api/files`, {
      headers: { Cookie: cookie, Origin: BASE_URL },
    });
    expect(res.status).toBe(200);
  });

  it("serves files routes with the web origin", async () => {
    const res = await SELF.fetch(`${BASE_URL}/api/files`, {
      headers: { Cookie: cookie, Origin: WEB_ORIGIN },
    });
    expect(res.status).toBe(200);
  });

  it("never requires an Origin header on files routes", async () => {
    const res = await SELF.fetch(`${BASE_URL}/api/files`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });
});
