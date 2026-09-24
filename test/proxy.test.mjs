import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveProxyUrl } from '../server/proxy.ts'

test('Node proxy setting overrides generic proxy variables and supports direct mode', async () => {
  const before = process.env.X_MIGRATE_PROXY
  try {
    process.env.X_MIGRATE_PROXY = 'direct'
    assert.equal(await resolveProxyUrl(), null)
    process.env.X_MIGRATE_PROXY = '127.0.0.1:7890'
    assert.equal(await resolveProxyUrl(), 'http://127.0.0.1:7890')
    process.env.X_MIGRATE_PROXY = 'socks5://127.0.0.1:1080'
    await assert.rejects(resolveProxyUrl(), /HTTP\(S\)/)
  } finally {
    if (before === undefined) delete process.env.X_MIGRATE_PROXY
    else process.env.X_MIGRATE_PROXY = before
  }
})
