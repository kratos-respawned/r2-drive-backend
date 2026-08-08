import { env, SELF } from "cloudflare:test";

export const BASE_URL = "http://localhost:8787";
export const PASSWORD = "Sup3r-secret-password!";

/**
 * Stub all outbound traffic. R2 uses the local simulated binding, so the only
 * expected outbound requests are resend emails. The main worker runs in the
 * same isolate as the tests, so patching the global fetch covers it too.
 */
export const setupOutboundMocks = () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "api.resend.com") {
      return Response.json({ id: "test-email" });
    }
    throw new Error(`Unexpected outbound fetch in tests: ${request.method} ${request.url}`);
  }) as typeof fetch;
};

/** Remove everything from the simulated R2 bucket. */
export const clearBucket = async () => {
  let cursor: string | undefined;
  do {
    const page = await env.r2_drive.list({ cursor });
    await env.r2_drive.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
};

export const bucketKeys = async () => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.r2_drive.list({ cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
};

/**
 * Sign up through the real better-auth routes, mark the email verified
 * directly in D1 (the verification email only hits the resend mock), then
 * sign in and return the session cookie.
 */
export const createTestUser = async (storageAllocatedKB = 1000) => {
  const email = `user-${crypto.randomUUID()}@example.com`;
  const signUp = await SELF.fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ name: "Test User", email, password: PASSWORD }),
  });
  if (!signUp.ok) {
    throw new Error(`sign-up failed: ${signUp.status} ${await signUp.text()}`);
  }
  await env.db_r2_drive
    .prepare("UPDATE user SET email_verified = 1, storage_allocated = ? WHERE email = ?")
    .bind(storageAllocatedKB, email)
    .run();
  const signIn = await SELF.fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!signIn.ok) {
    throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  }
  const cookie = signIn.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  const body = (await signIn.json()) as { user: { id: string } };
  return { email, cookie, userId: body.user.id };
};

export const filesApi = (cookie: string) => {
  const request = (method: string, path: string, body?: unknown) =>
    SELF.fetch(`${BASE_URL}/api/files${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: BASE_URL,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return {
    // hono's strict mode: the root routes match "/api/files", not "/api/files/"
    list: (path?: string, opts?: { includeHidden?: boolean }) => {
      const params = new URLSearchParams();
      if (path !== undefined) params.set("path", path);
      if (opts?.includeHidden) params.set("includeHidden", "1");
      const query = params.toString();
      return request("GET", query ? `?${query}` : "");
    },
    createFolder: (name: string, parentPath = "") => request("POST", "/folder", { name, parentPath }),
    uploadUrl: (body: unknown) => request("POST", "/upload-url", body),
    uploadUrls: (items: unknown[]) => request("POST", "/upload-urls", { items }),
    cancelUpload: (key: string) => request("DELETE", `/upload-url/${encodeURIComponent(key)}`),
    confirm: (body: unknown) => request("POST", "", body),
    confirmBatch: (items: unknown[]) => request("POST", "/batch", { items }),
    update: (id: number, body: unknown) => request("PUT", `/${id}`, body),
    remove: (id: number) => request("DELETE", `/${id}`),
    fileUrl: (id: number) => request("GET", `/${id}`),
  };
};

interface SeedObject {
  ownerId: string;
  name: string;
  path: string;
  parentPath?: string;
  key?: string | null;
  thumbnail?: string | null;
  contentType?: string;
  size?: number;
}

export const insertObject = async (row: SeedObject) => {
  const result = await env.db_r2_drive
    .prepare(
      "INSERT INTO objects (owner_id, name, path, parent_path, key, thumbnail, content_type, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      row.ownerId,
      row.name,
      row.path,
      row.parentPath ?? "",
      row.key ?? null,
      row.thumbnail ?? null,
      row.contentType ?? "text/plain",
      row.size ?? 0,
    )
    .run();
  return result.meta.last_row_id as number;
};

export const insertUploadRequest = async (row: {
  ownerId: string;
  key: string;
  status?: string;
  size?: number;
  createdAt?: number;
}) => {
  await env.db_r2_drive
    .prepare(
      "INSERT INTO upload_requests (owner_id, key, file_name, content_type, size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(row.ownerId, row.key, row.key, "text/plain", row.size ?? 1, row.status ?? "pending", row.createdAt ?? Date.now())
    .run();
};

export const getObjectPaths = async (ownerId: string) => {
  const { results } = await env.db_r2_drive
    .prepare("SELECT path FROM objects WHERE owner_id = ? ORDER BY path")
    .bind(ownerId)
    .all<{ path: string }>();
  return results.map((row) => row.path);
};

export const getStorageUsed = async (userId: string) => {
  const row = await env.db_r2_drive
    .prepare("SELECT storage_used FROM user WHERE id = ?")
    .bind(userId)
    .first<{ storage_used: number }>();
  return row?.storage_used ?? -1;
};

export const getUploadRequestStatus = async (key: string) => {
  const row = await env.db_r2_drive
    .prepare("SELECT status FROM upload_requests WHERE key = ?")
    .bind(key)
    .first<{ status: string }>();
  return row?.status ?? null;
};
