import assert from 'node:assert/strict'
import test from 'node:test'
import { __testables } from '../src/client.mjs'

test('normalizeStreamChatOptions supports legacy callback arguments', () => {
  const onData = () => {}
  const onEnd = () => {}
  const onError = () => {}

  const normalized = __testables.normalizeStreamChatOptions(onData, onEnd, onError)

  assert.equal(normalized.onData, onData)
  assert.equal(normalized.onEnd, onEnd)
  assert.equal(normalized.onError, onError)
  assert.equal(normalized.toolChoice, 'auto')
})

test('normalizeStreamChatOptions supports object options shape', () => {
  const onData = () => {}
  const normalized = __testables.normalizeStreamChatOptions({
    tools: [{ type: 'function', function: { name: 'sum' } }],
    tool_choice: 'required',
    onData,
    onEnd: () => {},
    onError: () => {},
  })

  assert.equal(normalized.tools.length, 1)
  assert.equal(normalized.toolChoice, 'required')
  assert.equal(normalized.onData, onData)
})
