import assert from 'node:assert/strict'
import test from 'node:test'
import { ProtoWriter, buildProtobufRequest, createFrame } from '../src/proto.mjs'

test('ProtoWriter writeBytes encodes length-delimited bytes fields', () => {
  const writer = new ProtoWriter()
  writer.writeBytes(1, Buffer.from([1, 2, 3]))
  const encoded = writer.toBuffer()

  assert.equal(Buffer.isBuffer(encoded), true)
  assert.equal(encoded.length > 0, true)
})

test('buildProtobufRequest accepts image contexts', () => {
  const { payload, messageId, conversationId } = buildProtobufRequest(
    'hello',
    'composer-1',
    'context text',
    [{ path: '/image-1.png', bytes: Buffer.from([1, 2, 3]) }]
  )

  assert.equal(Buffer.isBuffer(payload), true)
  assert.equal(payload.length > 0, true)
  assert.equal(typeof messageId, 'string')
  assert.equal(typeof conversationId, 'string')

  const frame = createFrame(payload)
  assert.equal(frame.length, payload.length + 5)
})
