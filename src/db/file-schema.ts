import { defineRelations, sql } from "drizzle-orm";
import {  sqliteTable,index} from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";


export const objects=sqliteTable('objects',(t)=> ({
    ownerId: t.text('owner_id').notNull(),
    id: t.integer().primaryKey(),
    name: t.text('name').notNull(),
    key: t.text('key').notNull(),
    thumbnail: t.text('thumbnail'),
    contentType: t.text('content_type').notNull(),
    size: t.integer('size').notNull(),
    createdAt: t.integer('created_at',{mode: 'timestamp_ms'}).default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`).notNull(),
    updatedAt: t.integer('updated_at',{mode: 'timestamp_ms'}).default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`).notNull(),
  }),(table)=>[index('objects_ownerId_idx').on(table.ownerId)]);

