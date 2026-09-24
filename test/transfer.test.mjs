import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeTransfer } from '../src/transfer.ts'

function progress(total) {
  return { processed: 0, total, copied: 0, alreadyThere: 0, removed: 0, failed: 0 }
}

test('rate limit during cleanup resumes at cleanup without repeating the target action', async () => {
  const plan = {
    entries: [{ kind: 'following', id: '301', phase: 'copy' }],
    index: 0,
    removeSource: { following: true, bookmarks: false },
  }
  const state = progress(1)
  const actions = []
  let cleanupCalls = 0
  const checkpoints = []
  const hooks = {
    action: async (role, kind, id, remove) => {
      actions.push([role, kind, id, remove])
      if (remove && ++cleanupCalls === 1) throw { status: 429 }
    },
    copied: () => {},
    checkpoint: () => checkpoints.push({ index: plan.index, phase: plan.entries[0].phase }),
    failed: () => assert.fail('No item should fail'),
    paused: () => {},
    cancelled: () => false,
    delay: async () => {},
    isRateLimit: (error) => error?.status === 429,
  }
  assert.equal(await executeTransfer(plan, state, hooks), 'paused')
  assert.deepEqual(state, {
    processed: 0,
    total: 1,
    copied: 1,
    alreadyThere: 0,
    removed: 0,
    failed: 0,
  })
  assert.deepEqual(checkpoints, [{ index: 0, phase: 'remove' }])
  assert.equal(await executeTransfer(plan, state, hooks), 'completed')
  assert.deepEqual(
    actions.map(([role, , , remove]) => [role, remove]),
    [
      ['target', false],
      ['source', true],
      ['source', true],
    ],
  )
  assert.equal(state.copied, 1)
  assert.equal(state.removed, 1)
  assert.equal(state.processed, 1)
})

test('failed copy never removes its source and the next item still transfers', async () => {
  const plan = {
    entries: [
      { kind: 'following', id: '301', phase: 'copy' },
      { kind: 'bookmarks', id: '401', phase: 'copy' },
    ],
    index: 0,
    removeSource: { following: true, bookmarks: true },
  }
  const state = progress(2)
  const actions = []
  const failures = []
  const result = await executeTransfer(plan, state, {
    action: async (role, kind, id, remove) => {
      actions.push([role, kind, id, remove])
      if (id === '301') throw new Error('Follow denied')
    },
    copied: () => {},
    checkpoint: () => {},
    failed: (entry, error) => failures.push([entry.id, error.message]),
    paused: () => assert.fail('No rate limit expected'),
    cancelled: () => false,
    delay: async () => {},
    isRateLimit: () => false,
  })
  assert.equal(result, 'completed')
  assert.deepEqual(failures, [['301', 'Follow denied']])
  assert.ok(!actions.some(([role, , id]) => role === 'source' && id === '301'))
  assert.ok(actions.some(([role, , id]) => role === 'source' && id === '401'))
  assert.deepEqual(state, {
    processed: 2,
    total: 2,
    copied: 1,
    alreadyThere: 0,
    removed: 1,
    failed: 1,
  })
})

test('cancellation stops before the next action', async () => {
  const plan = {
    entries: [{ kind: 'following', id: '301', phase: 'copy' }],
    index: 0,
    removeSource: { following: true, bookmarks: false },
  }
  let cancelled = false
  const actions = []
  const result = await executeTransfer(plan, progress(1), {
    action: async (role) => {
      actions.push(role)
      cancelled = true
    },
    copied: () => {},
    checkpoint: () => {},
    failed: () => {},
    paused: () => {},
    cancelled: () => cancelled,
    delay: async () => {},
    isRateLimit: () => false,
  })
  assert.equal(result, 'cancelled')
  assert.deepEqual(actions, ['target'])
  assert.equal(plan.entries[0].phase, 'remove')
})
