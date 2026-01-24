import { sql } from "drizzle-orm";
import { sqliteTable } from "drizzle-orm/sqlite-core";

export const test = sqliteTable('test',(t)=> ({
    id: t.integer('id').primaryKey(),
    title: t.text('title').notNull(),
    content: t.text('content').notNull(),
    createdAt: t.integer('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  }));