import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { createApi } from '../shared/api.ts'
import { createNodeClient } from './client.ts'

const host = process.env.X_MIGRATE_HOST || '127.0.0.1'
const port = Number(process.env.X_MIGRATE_PORT || '5198')
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('X_MIGRATE_PORT 必须是有效端口。')
}

const app = new Hono()
const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url))
app.route('/', createApi(createNodeClient, process.env.X_MIGRATE_ORIGIN))
app.use('/*', serveStatic({ root: distDirectory }))
app.get('*', serveStatic({ root: distDirectory, path: 'index.html' }))

serve({ fetch: app.fetch, hostname: host, port }, () => {
  process.stdout.write(`X 迁移服务已监听 http://${host}:${port}\n`)
})
