import { createServer } from 'node:http'
import { xApiNodeHandler } from './plugin.ts'

const secret = process.env.X_MIGRATE_PROXY_SECRET
if (!secret || secret.length < 32) {
  throw new Error('请设置至少 32 字符的 X_MIGRATE_PROXY_SECRET。')
}

const host = process.env.X_MIGRATE_API_HOST || '127.0.0.1'
const port = Number(process.env.X_MIGRATE_API_PORT || '5198')
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('X_MIGRATE_API_PORT 必须是有效端口。')
}

createServer(xApiNodeHandler).listen(port, host, () => {
  process.stdout.write(`X 迁移 API 已监听 http://${host}:${port}\n`)
})
