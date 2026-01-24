import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { posts } from './db/schema'

const app = new Hono<{ Bindings: CloudflareBindings }>()


app.get('/', async(c) => {
  const db=drizzle(c.env.r2_drive)
  const result=await db.select().from(posts);
  return c.json(result)
})

export default app
