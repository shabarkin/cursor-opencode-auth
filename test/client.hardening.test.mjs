import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { __testables } from '../src/client.mjs'

const {
  MAX_RESPONSE_SIZE_BYTES,
  createStreamSettler,
  wireStreamEvents,
  attachConnectRequestHandlers,
} = __testables

class FakeStream extends EventEmitter {
  constructor() {
    super()
    this.destroyCalls = 0
  }

  destroy() {
    this.destroyCalls += 1
  }
}

class FakeRequest extends EventEmitter {
  constructor() {
    super()
    this.destroyCalls = 0
  }

  destroy() {
    this.destroyCalls += 1
  }
}

test('wireStreamEvents destroys oversized stream and settles once', () => {
  const h2Stream = new FakeStream()

  let onDataCalls = 0
  let onEndCalls = 0
  let onErrorCalls = 0
  let closeCalls = 0
  let lastError = null

  const settler = createStreamSettler({
    onData: () => { onDataCalls += 1 },
    onEnd: () => { onEndCalls += 1 },
    onError: (error) => {
      onErrorCalls += 1
      lastError = error
    },
    client: { close: () => { closeCalls += 1 } },
  })

  wireStreamEvents(h2Stream, settler, 'prompt')

  h2Stream.emit('response', { ':status': 200 })
  h2Stream.emit('data', Buffer.alloc(MAX_RESPONSE_SIZE_BYTES + 1))
  h2Stream.emit('error', new Error('late error'))
  h2Stream.emit('end')

  assert.equal(h2Stream.destroyCalls, 1)
  assert.equal(onErrorCalls, 1)
  assert.equal(onEndCalls, 0)
  assert.equal(onDataCalls, 0)
  assert.equal(closeCalls, 1)
  assert.match(lastError.message, /maximum size/)
})

test('wireStreamEvents handles response and stream error race once', () => {
  const h2Stream = new FakeStream()

  let onEndCalls = 0
  let onErrorCalls = 0
  let closeCalls = 0

  const settler = createStreamSettler({
    onData: () => {},
    onEnd: () => { onEndCalls += 1 },
    onError: () => { onErrorCalls += 1 },
    client: { close: () => { closeCalls += 1 } },
  })

  wireStreamEvents(h2Stream, settler, 'prompt')

  h2Stream.emit('response', { ':status': 500 })
  h2Stream.emit('error', new Error('late error'))
  h2Stream.emit('end')

  assert.equal(onErrorCalls, 1)
  assert.equal(onEndCalls, 0)
  assert.equal(closeCalls, 1)
})

test('attachConnectRequestHandlers rejects once on oversized response', () => {
  const req = new FakeRequest()

  let settled = false
  let cleanupCalls = 0
  let resolveCalls = 0
  let rejectCalls = 0
  let lastError = null

  const cleanup = () => {
    if (settled) return
    settled = true
    cleanupCalls += 1
  }

  attachConnectRequestHandlers(req, {
    cleanup,
    resolve: () => { resolveCalls += 1 },
    reject: (error) => {
      rejectCalls += 1
      lastError = error
    },
    isSettled: () => settled,
    maxResponseSize: 8,
  })

  req.emit('data', Buffer.from('1234'))
  req.emit('data', Buffer.from('56789'))
  req.emit('error', new Error('late error'))
  req.emit('end')

  assert.equal(req.destroyCalls, 1)
  assert.equal(cleanupCalls, 1)
  assert.equal(resolveCalls, 0)
  assert.equal(rejectCalls, 1)
  assert.match(lastError.message, /maximum size of 8 bytes/)
})

test('attachConnectRequestHandlers resolves once and ignores late error', () => {
  const req = new FakeRequest()

  let settled = false
  let cleanupCalls = 0
  let resolveCalls = 0
  let rejectCalls = 0
  let resolvedValue = null

  const cleanup = () => {
    if (settled) return
    settled = true
    cleanupCalls += 1
  }

  attachConnectRequestHandlers(req, {
    cleanup,
    resolve: (value) => {
      resolveCalls += 1
      resolvedValue = value
    },
    reject: () => { rejectCalls += 1 },
    isSettled: () => settled,
    maxResponseSize: 128,
  })

  req.emit('data', Buffer.from('{"ok":true}'))
  req.emit('end')
  req.emit('error', new Error('late error'))

  assert.equal(cleanupCalls, 1)
  assert.equal(resolveCalls, 1)
  assert.equal(rejectCalls, 0)
  assert.deepEqual(resolvedValue, { ok: true })
})
