import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetryableError, parseRetryAfterHeader, withRetry } from '../src/retry.mjs'

test('parseRetryAfterHeader parses seconds and HTTP date values', () => {
  assert.equal(parseRetryAfterHeader('3'), 3000)
  assert.equal(parseRetryAfterHeader('invalid-value'), null)

  const nextSecond = new Date(Date.now() + 1000).toUTCString()
  const parsedDateDelay = parseRetryAfterHeader(nextSecond)
  assert.equal(typeof parsedDateDelay, 'number')
  assert.equal(parsedDateDelay >= 0, true)
})

test('isRetryableError matches retryable status codes', () => {
  assert.equal(isRetryableError({ statusCode: 503 }), true)
  assert.equal(isRetryableError({ message: 'Cursor API returned HTTP 429' }), true)
  assert.equal(isRetryableError({ statusCode: 400 }), false)
})

test('withRetry retries transient failures and eventually resolves', async () => {
  let attempts = 0

  const result = await withRetry(() => {
    attempts += 1
    if (attempts < 3) {
      const error = new Error('temporary outage')
      error.statusCode = 503
      throw error
    }

    return 'ok'
  }, {
    retries: 4,
    baseDelayMs: 1,
    maxDelayMs: 1,
  })

  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
})

test('withRetry stops immediately for non-retryable errors', async () => {
  let attempts = 0

  await assert.rejects(
    () => withRetry(() => {
      attempts += 1
      const error = new Error('bad request')
      error.statusCode = 400
      throw error
    }, {
      retries: 5,
      baseDelayMs: 1,
      maxDelayMs: 1,
    }),
    /bad request/
  )

  assert.equal(attempts, 1)
})
