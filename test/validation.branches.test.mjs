import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RequestError,
  validateChatRequest,
  validateContentPart,
  validateMessage,
  validateToolChoice,
  validateTools,
} from '../src/validation.mjs'

test('validateChatRequest requires request body to be an object', () => {
  assert.throws(
    () => validateChatRequest(null),
    (error) => {
      assert.equal(error instanceof RequestError, true)
      assert.match(error.message, /request body must be a JSON object/)
      return true
    }
  )
})

test('validateChatRequest enforces named tool existence and assistant tool_calls shape', () => {
  assert.throws(
    () => validateChatRequest({
      messages: [{
        role: 'assistant',
        content: 'x',
        tool_calls: [{
          id: '',
          type: 'bad',
          function: { name: 'bad name', arguments: 123 },
        }],
      }],
      tools: [{ type: 'function', function: { name: 'lookup_weather' } }],
      tool_choice: { type: 'function', function: { name: 'missing_tool' } },
    }),
    /tool_choice\.function\.name "missing_tool" was not found in tools/
  )
})

test('validateChatRequest allows assistant tool_calls with null content', () => {
  const parsed = validateChatRequest({
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup_weather', arguments: '{}' },
      }],
    }],
    tools: [{ type: 'function', function: { name: 'lookup_weather' } }],
    tool_choice: 'auto',
  })

  assert.equal(parsed.messages[0].content, '')
})

test('validateMessage enforces tool_call_id and tool_calls role constraints', () => {
  const nonToolErrors = validateMessage({ role: 'user', content: 'x', tool_call_id: 'abc' }, 0)
  assert.match(nonToolErrors.join('; '), /tool_call_id is only allowed when role is "tool"/)

  const nonAssistantErrors = validateMessage({ role: 'tool', content: 'x', tool_calls: [] }, 0)
  assert.match(nonAssistantErrors.join('; '), /tool_calls are only allowed when role is "assistant"/)
})

test('validateContentPart rejects unknown type and invalid image detail', () => {
  const unknownType = validateContentPart({ type: 'audio', text: 'x' }, 'm[0]')
  assert.match(unknownType.join('; '), /must be one of: text, image_url/)

  const invalidDetail = validateContentPart(
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'ultra' } },
    'm[1]'
  )
  assert.match(invalidDetail.join('; '), /detail must be one of: auto, low, high/)
})

test('validateTools and validateToolChoice handle non-array and non-object values', () => {
  assert.match(validateTools('bad').join('; '), /tools must be an array/)
  assert.match(validateToolChoice('invalid').join('; '), /tool_choice must be one of/)
  assert.match(validateToolChoice(42).join('; '), /tool_choice must be a string or object/)
})
