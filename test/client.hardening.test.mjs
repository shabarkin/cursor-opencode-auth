import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { __testables } from '../src/client.mjs'
import { ProtoWriter, createFrame } from '../src/proto.mjs'
import { parseToolCalls } from '../src/tools.mjs'

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

function createInteractionTextFrame(text) {
  const textDelta = new ProtoWriter()
  textDelta.writeString(1, text)

  const interaction = new ProtoWriter()
  interaction.writeMessage(1, textDelta)

  const serverMessage = new ProtoWriter()
  serverMessage.writeMessage(1, interaction)

  return createFrame(serverMessage.toBuffer())
}

function createStartedShellToolFrame({ callId, command, timeout = 120000 }) {
  const shellArgs = new ProtoWriter()
  shellArgs.writeString(1, command)
  shellArgs.writeString(2, '/Users/shabarkin/tools/cursor-opencode-auth')
  shellArgs.writeInt32(3, timeout)

  const shellToolCall = new ProtoWriter()
  shellToolCall.writeMessage(1, shellArgs)

  const toolCall = new ProtoWriter()
  toolCall.writeMessage(1, shellToolCall)

  const started = new ProtoWriter()
  started.writeString(1, callId)
  started.writeMessage(2, toolCall)
  started.writeString(3, 'model-call-1')

  const interaction = new ProtoWriter()
  interaction.writeMessage(2, started)

  const serverMessage = new ProtoWriter()
  serverMessage.writeMessage(1, interaction)

  return createFrame(serverMessage.toBuffer())
}

function createInteractionQueryWebFetchFrame({ queryId, url }) {
  const webFetchArgs = new ProtoWriter()
  webFetchArgs.writeString(1, url)

  const webFetchRequestQuery = new ProtoWriter()
  webFetchRequestQuery.writeMessage(1, webFetchArgs)

  const interactionQuery = new ProtoWriter()
  interactionQuery.writeInt32(1, queryId)
  interactionQuery.writeMessage(9, webFetchRequestQuery)

  const serverMessage = new ProtoWriter()
  serverMessage.writeMessage(7, interactionQuery)

  return createFrame(serverMessage.toBuffer())
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

test('wireStreamEvents forwards native interaction text deltas without duplication', () => {
  const h2Stream = new FakeStream()

  let responseText = ''
  let onEndCalls = 0

  const settler = createStreamSettler({
    onData: (text) => {
      responseText += text
    },
    onEnd: () => {
      onEndCalls += 1
    },
    onError: (error) => {
      throw error
    },
    client: { close: () => {} },
  })

  wireStreamEvents(h2Stream, settler, 'prompt')

  h2Stream.emit('response', { ':status': 200 })
  h2Stream.emit('data', createInteractionTextFrame('Hello '))
  h2Stream.emit('data', createInteractionTextFrame('world.'))
  h2Stream.emit('end')

  assert.equal(onEndCalls, 1)
  assert.equal(responseText, 'Hello world.')
})

test('wireStreamEvents bridges native tool calls to XML and settles early', () => {
  const h2Stream = new FakeStream()

  let responseText = ''
  let onEndCalls = 0

  const settler = createStreamSettler({
    onData: (text) => {
      responseText += text
    },
    onEnd: () => {
      onEndCalls += 1
    },
    onError: (error) => {
      throw error
    },
    client: { close: () => {} },
  })

  const tools = [
    {
      type: 'function',
      function: {
        name: 'bash',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            description: { type: 'string' },
            workdir: { type: 'string' },
            timeout: { type: 'number' },
          },
          required: ['command', 'description'],
          additionalProperties: false,
        },
      },
    },
  ]

  wireStreamEvents(h2Stream, settler, 'prompt', tools)

  h2Stream.emit('response', { ':status': 200 })
  h2Stream.emit('data', createStartedShellToolFrame({
    callId: 'tool_native_1',
    command: 'which ast-grep',
    timeout: 300000,
  }))

  assert.equal(onEndCalls, 1)

  const parsed = parseToolCalls(responseText)
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'bash')

  const args = JSON.parse(parsed.toolCalls[0].function.arguments)
  assert.equal(args.command, 'which ast-grep')
  assert.equal(args.timeout, 300000)
  assert.match(args.description, /Run shell command/)
})

test('wireStreamEvents bridges interaction_query events to tool calls', () => {
  const h2Stream = new FakeStream()

  let responseText = ''
  let onEndCalls = 0

  const settler = createStreamSettler({
    onData: (text) => {
      responseText += text
    },
    onEnd: () => {
      onEndCalls += 1
    },
    onError: (error) => {
      throw error
    },
    client: { close: () => {} },
  })

  const tools = [
    {
      type: 'function',
      function: {
        name: 'webfetch',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            format: { type: 'string' },
          },
          required: ['url', 'format'],
          additionalProperties: false,
        },
      },
    },
  ]

  wireStreamEvents(h2Stream, settler, 'prompt', tools)

  h2Stream.emit('response', { ':status': 200 })
  h2Stream.emit('data', createInteractionQueryWebFetchFrame({
    queryId: 7,
    url: 'https://example.com',
  }))

  assert.equal(onEndCalls, 1)

  const parsed = parseToolCalls(responseText)
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'webfetch')

  const args = JSON.parse(parsed.toolCalls[0].function.arguments)
  assert.equal(args.url, 'https://example.com')
  assert.equal(args.format, 'markdown')
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
