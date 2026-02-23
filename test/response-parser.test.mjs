import assert from 'node:assert/strict'
import test from 'node:test'
import zlib from 'zlib'
import {
  extractTextFromResponse,
  parseFrameStrings,
  isFilteredOut,
  scoreCandidate,
} from '../src/response-parser.mjs'
import { ProtoWriter, createFrame } from '../src/proto.mjs'

function createTextPayload(text) {
  const writer = new ProtoWriter()
  writer.writeString(1, text)
  return writer.toBuffer()
}

function createCompressedFrame(payload) {
  const compressed = zlib.gzipSync(payload)
  const frame = Buffer.alloc(5 + compressed.length)
  frame[0] = 1
  frame.writeUInt32BE(compressed.length, 1)
  compressed.copy(frame, 5)
  return frame
}

test('parseFrameStrings parses uncompressed and gzip frames', () => {
  const frameA = createFrame(createTextPayload('alpha message'))
  const frameB = createCompressedFrame(createTextPayload('beta message'))
  const parsed = parseFrameStrings(Buffer.concat([frameA, frameB]))

  const texts = parsed.map(item => item.text)
  assert.equal(texts.includes('alpha message'), true)
  assert.equal(texts.includes('beta message'), true)
})

test('parseFrameStrings ignores trailing incomplete frame bytes', () => {
  const frame = createFrame(createTextPayload('complete frame'))
  const truncated = frame.subarray(0, frame.length - 2)
  const parsed = parseFrameStrings(truncated)
  assert.equal(parsed.length, 0)
})

test('isFilteredOut removes IDs and user prompt echoes', () => {
  assert.equal(isFilteredOut('123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174000', ''), true)
  assert.equal(isFilteredOut('show me weather', 'show me weather', 'show me weather'), true)
  assert.equal(isFilteredOut('A useful answer.', 'a useful answer.', ''), false)
})

test('scoreCandidate prefers later and longer sentence-like outputs', () => {
  const low = scoreCandidate('short', 'short', 0, 0, [], '', '')
  const high = scoreCandidate('This is a fuller answer.', 'this is a fuller answer.', 3, 1, [], '', '')
  assert.equal(high > low, true)
})

test('extractTextFromResponse returns assistant text over user echo', () => {
  const userFrame = createFrame(createTextPayload('Explain APIs'))
  const assistantFrame = createFrame(createTextPayload('APIs define how software components communicate.'))

  const output = extractTextFromResponse(Buffer.concat([userFrame, assistantFrame]), 'Explain APIs')
  assert.equal(output, 'APIs define how software components communicate.')
})
