import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildToolSystemPrompt,
  buildToolResultContext,
  parseToolCalls,
  ToolCallStreamBuffer,
} from '../src/tools.mjs'

test('buildToolSystemPrompt includes tool definitions and required instruction', () => {
  const prompt = buildToolSystemPrompt([
    {
      type: 'function',
      function: {
        name: 'lookup_weather',
        description: 'Get weather by city',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  ], 'required')

  assert.match(prompt, /Tool choice is "required"/)
  assert.match(prompt, /lookup_weather/)
  assert.match(prompt, /<tool_call>/)
})

test('buildToolResultContext formats assistant tool calls and tool messages', () => {
  const context = buildToolResultContext([
    {
      role: 'assistant',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup_weather', arguments: '{"city":"SF"}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '72F and sunny',
    },
  ])

  assert.match(context, /assistant_tool_call id=call_1/)
  assert.match(context, /tool_result tool_call_id=call_1 content=72F and sunny/)
})

test('parseToolCalls extracts XML tool calls and preserves surrounding content', () => {
  const parsed = parseToolCalls(
    'Before <tool_call>{"name":"sum","arguments":{"a":1,"b":2}}</tool_call> After'
  )

  assert.equal(parsed.pendingToolCall, false)
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'sum')
  assert.equal(parsed.toolCalls[0].function.arguments, '{"a":1,"b":2}')
  assert.match(parsed.content, /Before/)
  assert.match(parsed.content, /After/)
})

test('parseToolCalls falls back to JSON code blocks', () => {
  const parsed = parseToolCalls('```json\n{"name":"search_docs","arguments":{"query":"auth"}}\n```')

  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'search_docs')
  assert.equal(parsed.content, '')
})

test('parseToolCalls flags dangling tool call tags', () => {
  const parsed = parseToolCalls('Thinking... <tool_call>{"name":"broken"}')
  assert.equal(parsed.pendingToolCall, true)
  assert.equal(parsed.toolCalls.length, 0)
})

test('ToolCallStreamBuffer handles split tags and emits OpenAI-style deltas', () => {
  const contentDeltas = []
  const starts = []
  const argDeltas = []

  const buffer = new ToolCallStreamBuffer({
    onContentDelta: (text) => contentDeltas.push(text),
    onToolCallStart: (index, id, name) => starts.push({ index, id, name }),
    onToolCallArgumentsDelta: (index, delta) => argDeltas.push({ index, delta }),
  }, { argumentsChunkSize: 5 })

  buffer.push('Intro <tool')
  buffer.push('_call>{"name":"sum","arguments":{"a":1,"b":2}}</tool_call> done')
  buffer.flush()

  assert.deepEqual(contentDeltas, ['Intro ', ' done'])
  assert.equal(starts.length, 1)
  assert.equal(starts[0].index, 0)
  assert.equal(starts[0].name, 'sum')
  assert.equal(argDeltas.length > 1, true)
  assert.equal(argDeltas.map(item => item.delta).join(''), '{"a":1,"b":2}')
})

test('ToolCallStreamBuffer flush emits incomplete tool blocks as plain content', () => {
  const contentDeltas = []

  const buffer = new ToolCallStreamBuffer({
    onContentDelta: (text) => contentDeltas.push(text),
  })

  buffer.push('abc <tool_call>{"name":"missing_close"')
  buffer.flush()

  assert.equal(contentDeltas.length, 2)
  assert.equal(contentDeltas[0], 'abc ')
  assert.match(contentDeltas[1], /<tool_call>/)
})
