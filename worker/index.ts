import { Hono } from 'hono'
import { createApi } from '../shared/api.ts'

type Bindings = {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

const app = new Hono<{ Bindings: Bindings }>()
app.route('/', createApi())
app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw))

export default app
