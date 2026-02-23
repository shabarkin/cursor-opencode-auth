import assert from 'node:assert/strict'
import test from 'node:test'
import { bridgeNativeToolCallToXml } from '../src/native-tool-bridge.mjs'
import { parseToolCalls } from '../src/tools.mjs'

function parseSingleToolCall(xmlText) {
  const parsed = parseToolCalls(xmlText)
  assert.equal(parsed.toolCalls.length, 1)
  const call = parsed.toolCalls[0]
  const args = JSON.parse(call.function.arguments)
  return { call, args }
}

test('bridgeNativeToolCallToXml maps shell events to bash tool calls', () => {
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
        },
      },
    },
  ]

  const xml = bridgeNativeToolCallToXml(
    {
      callId: 'tool_test_1',
      toolName: 'shell',
      toolArguments: {
        command: 'which ast-grep',
        workdir: '/Users/shabarkin/tools/cursor-opencode-auth',
        timeout: 300000,
      },
    },
    tools,
  )

  assert.equal(typeof xml, 'string')
  const { call, args } = parseSingleToolCall(xml)

  assert.equal(call.function.name, 'bash')
  assert.equal(args.command, 'which ast-grep')
  assert.equal(args.workdir, '/Users/shabarkin/tools/cursor-opencode-auth')
  assert.equal(args.timeout, 300000)
  assert.match(args.description, /Run shell command/)
})

test('bridgeNativeToolCallToXml maps web search to google_search schema', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'google_search',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            thinking: { type: 'boolean' },
            urls: { type: 'array' },
          },
          required: ['query', 'thinking'],
        },
      },
    },
  ]

  const xml = bridgeNativeToolCallToXml(
    {
      callId: 'tool_test_2',
      toolName: 'web_search',
      toolArguments: { query: 'latest ast-grep release notes' },
    },
    tools,
  )

  assert.equal(typeof xml, 'string')
  const { call, args } = parseSingleToolCall(xml)

  assert.equal(call.function.name, 'google_search')
  assert.equal(args.query, 'latest ast-grep release notes')
  assert.equal(args.thinking, true)
})

test('bridgeNativeToolCallToXml maps update_todos to todowrite schema', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'todowrite',
        parameters: {
          type: 'object',
          properties: {
            todos: { type: 'array' },
          },
          required: ['todos'],
        },
      },
    },
  ]

  const xml = bridgeNativeToolCallToXml(
    {
      callId: 'tool_test_3',
      toolName: 'update_todos',
      toolArguments: {
        todos: [
          { content: 'Implement bridge', status: 'in_progress', priority: 'high' },
        ],
      },
    },
    tools,
  )

  assert.equal(typeof xml, 'string')
  const { call, args } = parseSingleToolCall(xml)

  assert.equal(call.function.name, 'todowrite')
  assert.equal(Array.isArray(args.todos), true)
  assert.equal(args.todos[0].content, 'Implement bridge')
  assert.equal(args.todos[0].status, 'in_progress')
  assert.equal(args.todos[0].priority, 'high')
})

test('bridgeNativeToolCallToXml returns null when no tool mapping exists', () => {
  const xml = bridgeNativeToolCallToXml(
    {
      callId: 'tool_test_4',
      toolName: 'shell',
      toolArguments: { command: 'pwd' },
    },
    [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } } }],
  )

  assert.equal(xml, null)
})
