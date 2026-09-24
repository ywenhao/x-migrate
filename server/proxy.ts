/**
 * 代理解析：优先级依次为
 *   1. 前端 UI 里手动填写的代理
 *   2. 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *   3. Windows 系统代理（读注册表）
 *   4. 直连（不使用代理）
 *
 * 访问 x.com 在大陆网络环境下通常需要代理，这里做到「零配置尽量能用」。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ProxyAgent, Agent, type Dispatcher } from 'undici'

const execFileAsync = promisify(execFile)

let systemProxyCache: { value: string | null; at: number } | null = null
const SYSTEM_PROXY_TTL = 60_000

function normalizeProxyUrl(raw: string | undefined | null): string | null {
  if (!raw) return null
  let s = raw.trim()
  if (!s) return null
  // 允许用户只写 host:port
  if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s
  try {
    // 校验是否为合法 URL
    // eslint-disable-next-line no-new
    new URL(s)
    return s
  } catch {
    return null
  }
}

/** 读取 Windows 系统代理设置（HKCU\...\Internet Settings）。 */
async function readWindowsSystemProxy(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const now = Date.now()
  if (systemProxyCache && now - systemProxyCache.at < SYSTEM_PROXY_TTL) {
    return systemProxyCache.value
  }
  let value: string | null = null
  try {
    const key =
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const { stdout } = await execFileAsync('reg', ['query', key])
    const enableMatch = stdout.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i)
    const serverMatch = stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/i)
    const enabled = enableMatch ? parseInt(enableMatch[1], 16) === 1 : false
    if (enabled && serverMatch) {
      let server = serverMatch[1].trim()
      // ProxyServer 可能是 "host:port" 或 "http=host:port;https=host:port"
      if (server.includes('=')) {
        const parts = server.split(';').map((p) => p.trim())
        const https = parts.find((p) => p.startsWith('https='))
        const http = parts.find((p) => p.startsWith('http='))
        const pick = (https || http || '').split('=')[1]
        server = pick || ''
      }
      value = normalizeProxyUrl(server)
    }
  } catch {
    value = null
  }
  systemProxyCache = { value, at: now }
  return value
}

/**
 * 根据「用户手填代理」解析出最终要用的代理 URL。
 * @param userProxy 前端传入的代理字符串，可为空
 *   - 传 "direct" 或 "none" 表示强制直连
 */
export async function resolveProxyUrl(
  userProxy?: string | null,
): Promise<string | null> {
  const trimmed = (userProxy || '').trim().toLowerCase()
  if (trimmed === 'direct' || trimmed === 'none' || trimmed === '直连') {
    return null
  }
  const manual = normalizeProxyUrl(userProxy)
  if (manual) return manual

  const env =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  const envProxy = normalizeProxyUrl(env)
  if (envProxy) return envProxy

  return await readWindowsSystemProxy()
}

/** 拿到一个 undici dispatcher（有代理用 ProxyAgent，否则普通 Agent）。 */
export function makeDispatcher(proxyUrl: string | null): Dispatcher {
  if (proxyUrl) {
    return new ProxyAgent({
      uri: proxyUrl,
      // X 接口偶尔较慢，放宽超时
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    })
  }
  return new Agent({
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  })
}
