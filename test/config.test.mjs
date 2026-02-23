import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PORT,
  resolvePort,
  isAllowedOrigin,
  isAllowedUpstreamHost,
} from '../src/config.mjs'

function withArgv(extraArg, fn) {
  const previous = [...process.argv]
  process.argv = [previous[0], previous[1], extraArg]

  try {
    fn()
  } finally {
    process.argv = previous
  }
}

test('resolvePort returns CLI port when valid', () => {
  withArgv('5555', () => {
    assert.equal(resolvePort(), 5555)
  })
})

test('resolvePort falls back to default for invalid port', () => {
  withArgv('not-a-number', () => {
    assert.equal(resolvePort(), DEFAULT_PORT)
  })

  withArgv('70000', () => {
    assert.equal(resolvePort(), DEFAULT_PORT)
  })
})

test('isAllowedOrigin allows localhost variants only', () => {
  assert.equal(isAllowedOrigin('http://localhost:3000'), true)
  assert.equal(isAllowedOrigin('https://127.0.0.1:8080'), true)
  assert.equal(isAllowedOrigin('http://[::1]:5173'), true)
  assert.equal(isAllowedOrigin('https://evil.example'), false)
})

test('isAllowedUpstreamHost uses strict allowlist', () => {
  assert.equal(isAllowedUpstreamHost('agentn.api5.cursor.sh'), true)
  assert.equal(isAllowedUpstreamHost('api2.cursor.sh'), true)
  assert.equal(isAllowedUpstreamHost('example.com'), false)
})
