import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle/migrations',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials:{
    url:".wrangler/state/v3/d1/miniflare-D1DatabaseObject/f4363c33ad327e333a16fee0488b11927377a63896668b2b8e62f9f12dd17494.sqlite"
  }
});