import assert from 'node:assert/strict'
import test from 'node:test'
import { ProtoWriter, createFrame } from '../src/proto.mjs'
import { FrameAccumulator, StreamTextExtractor, __testables } from '../src/stream-parser.mjs'

function textFrame(text) {
  const writer = new ProtoWriter()
  writer.writeString(1, text)
  return createFrame(writer.toBuffer())
}

test('FrameAccumulator buffers partial frame boundaries', () => {
  const frame = textFrame('hello')
  const accumulator = new FrameAccumulator()

  const first = accumulator.push(frame.subarray(0, 3))
  const second = accumulator.push(frame.subarray(3))

  assert.equal(first.length, 0)
  assert.equal(second.length, 1)
  assert.deepEqual(second[0], frame)
})

test('FrameAccumulator returns multiple frames from a single chunk', () => {
  const frameA = textFrame('A')
  const frameB = textFrame('B')
  const accumulator = new FrameAccumulator()

  const frames = accumulator.push(Buffer.concat([frameA, frameB]))
  assert.equal(frames.length, 2)
})

test('StreamTextExtractor emits progressive text deltas', () => {
  const extractor = new StreamTextExtractor('prompt')
  const deltaA = extractor.push(textFrame('Hello'))
  const deltaB = extractor.push(textFrame('Hello, world'))

  const combined = `${deltaA}${deltaB}`
  assert.match(combined, /Hello/)
  assert.match(combined, /world/)
})

test('computeTextDelta handles extension and regression safely', () => {
  assert.equal(__testables.computeTextDelta('hello', 'hello world'), ' world')
  assert.equal(__testables.computeTextDelta('hello world', 'hello'), '')
  assert.equal(__testables.computeTextDelta('hello', 'goodbye'), 'goodbye')
})
