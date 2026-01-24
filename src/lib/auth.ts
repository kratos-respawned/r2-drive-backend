

import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { betterAuth } from 'better-auth';
// import { betterAuthOptions } from './options';

import * as schema from "../db/schema"; // Ensure the schema is imported
import { drizzle } from 'drizzle-orm/d1';

/**
 * Better Auth Instance
 */
export const auth = (env: CloudflareBindings): ReturnType<typeof betterAuth> => {
//   const sql = neon(env.DATABASE_URL);
  const db = drizzle(env.r2_drive);

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,

    // Additional options that depend on env ...
  });
};