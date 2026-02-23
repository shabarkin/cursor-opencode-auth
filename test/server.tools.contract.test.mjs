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

test('handleChatStream short-circuits repeated identical tool loop', () => {
  const res = new FakeResponse()

  const messages = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '{"command":"which ast-grep"}',
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '/opt/homebrew/bin/ast-grep',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_2',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '{"command":"which ast-grep"}',
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_2',
      content: '/opt/homebrew/bin/ast-grep',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_3',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '{"command":"which ast-grep"}',
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_3',
      content: '/opt/homebrew/bin/ast-grep',
    },
  ]

  __testables.handleChatStream(
    res,
    'composer-1',
    messages,
    undefined,
    'auto',
    () => {
      throw new Error('streamChat should not be called for looped tool history')
    },
  )

  const blocks = parseSseDataBlocks(res.body)
    .filter(block => block !== '[DONE]')
    .map(block => JSON.parse(block))

  const contentChunk = blocks.find(payload => payload.choices[0].delta.content)
  assert.equal(Boolean(contentChunk), true)
  assert.match(contentChunk.choices[0].delta.content, /ast-grep is available/i)
})

test('handleChatNonStream short-circuits repeated identical tool loop', async () => {
  const res = new FakeResponse()

  const messages = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '{"command":"which ast-grep"}',
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '/opt/homebrew/bin/ast-grep',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_2',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '{"command":"which ast-grep"}',
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_2',
      content: '/opt/homebrew/bin/ast-grep',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_3',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '{"command":"which ast-grep"}',
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_3',
      content: '/opt/homebrew/bin/ast-grep',
    },
  ]

  await __testables.handleChatNonStream(
    res,
    'composer-1',
    messages,
    undefined,
    'auto',
    () => {
      throw new Error('streamChat should not be called for looped tool history')
    },
  )

  const payload = JSON.parse(res.body)
  assert.equal(payload.choices[0].finish_reason, 'stop')
  assert.match(payload.choices[0].message.content, /ast-grep is available/i)
})

test('deriveToolHandling disables tools for short meta prompts', () => {
  const derived = __testables.deriveToolHandling(
    [{ role: 'user', content: '"do you have access to ast-grep ?"\n' }],
    [{ type: 'function', function: { name: 'bash' } }],
    'auto',
  )

  assert.equal(derived.toolChoice, 'none')
  assert.equal(derived.tools, undefined)
  assert.equal(derived.disabledForMetaPrompt, true)
})

test('deriveToolHandling preserves tools for explicit action requests', () => {
  const tools = [{ type: 'function', function: { name: 'bash' } }]
  const derived = __testables.deriveToolHandling(
    [{ role: 'user', content: 'can you run ast-grep on src files?' }],
    tools,
    'auto',
  )

  assert.equal(derived.toolChoice, 'auto')
  assert.equal(derived.tools, tools)
  assert.equal(derived.disabledForMetaPrompt, false)
})

test('buildMetaPromptReply returns stable response for ast-grep access prompt', () => {
  const reply = __testables.buildMetaPromptReply([
    { role: 'user', content: '"do you have access to ast-grep ?"\n' },
  ])

  assert.equal(typeof reply, 'string')
  assert.match(reply, /ast-grep/i)
  assert.match(reply, /bash/i)
})

test('buildMetaPromptReply explains short why prompts', () => {
  const reply = __testables.buildMetaPromptReply([
    { role: 'user', content: '"why ?"\n' },
  ])

  assert.equal(typeof reply, 'string')
  assert.match(reply, /upstream model can get stuck/i)
})
