
import { env } from "cloudflare:workers";
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { betterAuth } from 'better-auth';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from "./db/schema"; // Ensure the schema is imported



export const auth = betterAuth({
  database: drizzleAdapter(drizzle(env.db_r2_drive), { provider: 'sqlite' }),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  secondaryStorage:{
    get: async (key: string) => {
      return await env.kv_r2_drive.get(key);
    },
    set: async (key: string, value: string) => {
      await env.kv_r2_drive.put(key, value);
    },
    delete: async (key: string) => {
      await env.kv_r2_drive.delete(key);
    }
  },
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    github: {
      clientId: env.MY_SECRET ,
      clientSecret: env.MY_SECRET ,
    }
  }
});

