import assert from 'node:assert/strict'
import test from 'node:test'
import { TOKEN_CACHE_TTL_MS } from '../src/config.mjs'
import { getToken, clearTokenCache } from '../src/token.mjs'

test.beforeEach(() => {
  clearTokenCache()
})

test('getToken prefers CURSOR_AUTH_TOKEN environment variable', () => {
  let execCalls = 0
  const token = getToken({
    platform: 'darwin',
    env: { CURSOR_AUTH_TOKEN: 'env-token' },
    execFn: () => {
      execCalls += 1
      return 'should-not-run'
    },
    now: 1_000,
  })

  assert.equal(token, 'env-token')
  assert.equal(execCalls, 0)
})

test('getToken caches token until TTL expiration', () => {
  let execCalls = 0
  const execFn = () => {
    execCalls += 1
    return 'cache-token\n'
  }

  const first = getToken({ platform: 'darwin', env: {}, execFn, now: 10 })
  const second = getToken({ platform: 'darwin', env: {}, execFn, now: 10 + TOKEN_CACHE_TTL_MS - 1 })

  assert.equal(first, 'cache-token')
  assert.equal(second, 'cache-token')
  assert.equal(execCalls, 1)
})

test('getToken refreshes token after TTL expiration', () => {
  const values = ['token-a\n', 'token-b\n']
  let index = 0

  const execFn = () => {
    const value = values[Math.min(index, values.length - 1)]
    index += 1
    return value
  }

  const first = getToken({ platform: 'darwin', env: {}, execFn, now: 100 })
  const second = getToken({
    platform: 'darwin',
    env: {},
    execFn,
    now: 100 + TOKEN_CACHE_TTL_MS + 1,
  })

  assert.equal(first, 'token-a')
  assert.equal(second, 'token-b')
})

test('getToken falls back to token file when platform provider fails', () => {
  const fsModule = {
    existsSync(filePath) {
      return filePath === '/tmp/cursor-token'
    },
    readFileSync(filePath) {
      assert.equal(filePath, '/tmp/cursor-token')
      return 'file-token\n'
    },
  }

  const token = getToken({
    platform: 'linux',
    env: {},
    execFn: () => {
      throw new Error('secret-tool missing')
    },
    fsModule,
    tokenPaths: ['/tmp/cursor-token'],
    now: 2_000,
  })

  assert.equal(token, 'file-token')
})

test('getToken throws with platform troubleshooting hint when all providers fail', () => {
  const fsModule = {
    existsSync() {
      return false
    },
    readFileSync() {
      throw new Error('not found')
    },
  }

  assert.throws(
    () => getToken({
      platform: 'linux',
      env: {},
      execFn: () => {
        throw new Error('secret-tool missing')
      },
      fsModule,
      tokenPaths: ['/tmp/missing'],
      now: 3_000,
    }),
    /Failed to load Cursor auth token on platform "linux"/
  )
})
