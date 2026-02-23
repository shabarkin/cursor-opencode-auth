import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RequestError,
  validateChatRequest,
  validateContentPart,
  validateToolChoice,
  validateTools,
} from '../src/validation.mjs'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

test('validateChatRequest accepts tools + required tool choice and sanitizes message fields', () => {
  const parsed = validateChatRequest({
    model: 'composer-1',
    stream: true,
    tools: [{
      type: 'function',
      function: {
        name: 'lookup_weather',
        description: 'Look up weather by city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    }],
    tool_choice: 'required',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Show forecast' },
        { type: 'image_url', image_url: { url: PNG_DATA_URL, detail: 'low' }, ignored: true },
      ],
      extra: 'ignored',
    }],
  })

  assert.equal(parsed.model, 'composer-1')
  assert.equal(parsed.stream, true)
  assert.equal(parsed.toolChoice, 'required')
  assert.equal(parsed.tools.length, 1)
  assert.deepEqual(parsed.messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'Show forecast' },
      { type: 'image_url', image_url: { url: PNG_DATA_URL, detail: 'low' } },
    ],
  })
})

test('validateChatRequest rejects required tool choice without tools', () => {
  assert.throws(
    () => validateChatRequest({
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: 'required',
    }),
    (error) => {
      assert.equal(error instanceof RequestError, true)
      assert.equal(error.statusCode, 400)
      assert.match(error.message, /tool_choice "required" requires at least one tool/)
      return true
    }
  )
})

test('validateChatRequest rejects tool role without tool_call_id', () => {
  assert.throws(
    () => validateChatRequest({
      messages: [{ role: 'tool', content: 'result payload' }],
    }),
    /tool_call_id is required/
  )
})

test('validateContentPart enforces data URL images', () => {
  const errors = validateContentPart(
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    'messages[0].content[0]'
  )

  assert.equal(errors.length, 1)
  assert.match(errors[0], /base64 data:image URL/)
})

test('validateTools and validateToolChoice reject malformed definitions', () => {
  const toolErrors = validateTools([
    { type: 'function', function: { name: 'bad name with spaces' } },
  ])
  assert.equal(toolErrors.length > 0, true)

  const toolChoiceErrors = validateToolChoice({
    type: 'function',
    function: { name: 'bad name with spaces' },
  })
  assert.equal(toolChoiceErrors.length > 0, true)
})
