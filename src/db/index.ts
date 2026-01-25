import {env} from "cloudflare:workers"
import { drizzle } from "drizzle-orm/d1"
import { relations } from "./relations"
import * as schema from "./schema"
export const db = drizzle(env.db_r2_drive,{schema,relations})