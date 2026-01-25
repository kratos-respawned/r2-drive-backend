import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'

const app = new Hono<{ Bindings: CloudflareBindings }>()


app.get('/', async(c) => {
  
  // const result=await db.select().from(posts);
  return c.json([])
})

export default app
