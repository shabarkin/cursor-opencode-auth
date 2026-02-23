import assert from 'node:assert/strict'
import test from 'node:test'
import { __testables } from '../src/server.mjs'

class FakeResponse {
  constructor() {
    this.statusCode = 200
    this.headers = {}
    this.headersSent = false
    this.writes = []
    this.body = ''
    this.ended = false
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode
    this.headers = headers
    this.headersSent = true
  }

  write(chunk) {
    const text = String(chunk)
    this.writes.push(text)
    this.body += text
  }

  end(chunk = '') {
    if (chunk) {
      this.write(chunk)
    }
    this.ended = true
  }
}

function parseSseDataBlocks(body) {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((block) => block.replace(/^data:\s*/, ''))
}

test('handleChatNonStream returns OpenAI tool_calls response shape', async () => {
  const res = new FakeResponse()

  await __testables.handleChatNonStream(
    res,
    'composer-1',
    [{ role: 'user', content: 'add numbers' }],
    [{ type: 'function', function: { name: 'sum' } }],
    'required',
    (model, messages, options) => {
      options.onData('<tool_call>{"name":"sum","arguments":{"a":1,"b":2}}</tool_call>')
      options.onEnd()
    }
  )

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.object, 'chat.completion')
  assert.equal(payload.choices[0].finish_reason, 'tool_calls')
  assert.equal(payload.choices[0].message.tool_calls.length, 1)
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'sum')
})

test('handleChatNonStream enforces required tool choice', async () => {
  const res = new FakeResponse()

  await assert.rejects(
    async () => __testables.handleChatNonStream(
      res,
      'composer-1',
      [{ role: 'user', content: 'plain text only' }],
      [{ type: 'function', function: { name: 'sum' } }],
      'required',
      (model, messages, options) => {
        options.onData('no tools returned')
        options.onEnd()
      }
    ),
    /required/
  )
})

test('handleChatStream emits tool call chunks and finish_reason tool_calls', () => {
  const res = new FakeResponse()

  __testables.handleChatStream(
    res,
    'composer-1',
    [{ role: 'user', content: 'add numbers' }],
    [{ type: 'function', function: { name: 'sum' } }],
    'required',
    (model, messages, options) => {
      options.onData('before <tool_call>{"name":"sum","arguments":{"a":1,"b":2}}</tool_call> after')
      options.onEnd()
    }
  )

  const blocks = parseSseDataBlocks(res.body)
  const jsonPayloads = blocks
    .filter(block => block !== '[DONE]')
    .map(block => JSON.parse(block))

  const first = jsonPayloads[0]
  assert.equal(first.choices[0].delta.tool_calls[0].function.name, 'sum')

  const final = jsonPayloads[jsonPayloads.length - 1]
  assert.equal(final.choices[0].finish_reason, 'tool_calls')
  assert.equal(blocks.includes('[DONE]'), true)
})

test('handleChatStream sends error event when required tool call is missing', () => {
  const res = new FakeResponse()

  __testables.handleChatStream(
    res,
    'composer-1',
    [{ role: 'user', content: 'hello' }],
    [{ type: 'function', function: { name: 'sum' } }],
    'required',
    (model, messages, options) => {
      options.onData('plain response only')
      options.onEnd()
    }
  )

  const blocks = parseSseDataBlocks(res.body)
  const first = JSON.parse(blocks[0])
  assert.match(first.error.message, /required/)
})

test('handleChatStream emits fallback content for internal progress-only text', () => {
  const res = new FakeResponse()

  __testables.handleChatStream(
    res,
    'composer-1',
    [{ role: 'user', content: 'test' }],
    undefined,
    'auto',
    (model, messages, options) => {
      options.onData('Checking the workspace for context.')
      options.onEnd()
    }
  )

  const blocks = parseSseDataBlocks(res.body)
  const jsonPayloads = blocks
    .filter(block => block !== '[DONE]')
    .map(block => JSON.parse(block))

  const contentChunk = jsonPayloads.find(payload => payload.choices[0].delta.content)
  assert.equal(Boolean(contentChunk), true)
  assert.match(contentChunk.choices[0].delta.content, /internal tool workflow/)
})
