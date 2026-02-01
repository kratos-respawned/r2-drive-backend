import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { customSession } from "better-auth/plugins";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { user } from "./db/auth-schema";
import { sendEmail } from "./lib/mail";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "sqlite" }),
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.ORIGIN_URL],
  secret: env.BETTER_AUTH_SECRET,

  secondaryStorage: {
    get: async (key: string) => {
      return await env.kv_r2_drive.get(key);
    },
    set: async (key: string, value: string) => {
      await env.kv_r2_drive.put(key, value);
    },
    delete: async (key: string) => {
      await env.kv_r2_drive.delete(key);
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your password",
        text: `Click the link to reset your password: ${url}`,
      });
    },
    onPasswordReset: async ({ user }) => {
      await sendEmail({
        to: user.email,
        subject: "Password reset successful",
        text: "Your password has been reset successfully",
      });
    },
  },
  socialProviders: {
    github: {
      clientId: env.ACCOUNT_ID,
      clientSecret: env.ACCOUNT_ID,
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url, token }) => {
      console.log(user, url, token);
      await sendEmail({
        to: user.email,
        subject: "Verify your email address",
        text: `Click the link to verify your email: ${url}`,
      });
    },
    autoSignInAfterVerification: true,
  },
  plugins: [
    customSession(async (sessionObj) => {
      const [userData] = await db.select().from(user).where(eq(user.id, sessionObj.session.userId));
      return {
        user: {
          ...sessionObj.user,
          storageAllocated: userData.storageAllocated,
          storageUsed: userData.storageUsed,
        },
        session: sessionObj.session,
      };
    }),
  ]
});
