import { Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'

type Bindings = {
  ASSETS: { fetch(request: Request): Promise<Response> }
  API_ORIGIN?: string
  API_PROXY_SECRET?: string
  APP_USERNAME?: string
  APP_PASSWORD?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', async (context, next) => {
  const username = context.env.APP_USERNAME
  const password = context.env.APP_PASSWORD
  if (!username || !password || password.length < 16) {
    return context.json({ error: 'Worker 访问密码尚未配置。' }, 503)
  }
  return basicAuth({ username, password, realm: 'X Migrate' })(context, next)
})

app.all('/api/*', async (context) => {
  const configuredOrigin = context.env.API_ORIGIN
  const secret = context.env.API_PROXY_SECRET
  if (!configuredOrigin || !secret || secret.length < 32) {
    return context.json({ error: 'API 转发尚未配置。' }, 503)
  }

  let target: URL
  try {
    const origin = new URL(configuredOrigin)
    const localHttp = origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    if ((!localHttp && origin.protocol !== 'https:') || origin.pathname !== '/' ||
      origin.search || origin.hash || origin.username || origin.password) throw new Error('Invalid API origin')
    const incoming = new URL(context.req.url)
    target = new URL(incoming.pathname + incoming.search, origin)
  } catch {
    return context.json({ error: 'API_ORIGIN 必须是 HTTPS 站点根地址。' }, 503)
  }

  const headers = new Headers(context.req.raw.headers)
  headers.delete('host')
  headers.delete('authorization')
  headers.set('x-x-migrate-proxy-key', secret)
  const method = context.req.method
  const upstream = new Request(target, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : await context.req.raw.arrayBuffer(),
    redirect: 'manual',
  })
  try {
    return await fetch(upstream)
  } catch {
    return context.json({ error: 'Node API 暂不可用。' }, 502)
  }
})

app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw))

export default app
