import { extractTextFromResponse } from './response-parser.mjs'

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk
  return Buffer.from(chunk)
}

function appendBuffers(buffers, chunk) {
  return [...buffers, chunk]
}

function computeTextDelta(previousText, nextText) {
  if (nextText.length === 0) return ''
  if (nextText === previousText) return ''

  if (nextText.startsWith(previousText)) {
    return nextText.slice(previousText.length)
  }

  if (previousText.startsWith(nextText)) {
    return ''
  }

  return nextText
}

export class FrameAccumulator {
  constructor() {
    this.pendingBuffer = Buffer.alloc(0)
  }

  push(chunk) {
    const chunkBuffer = toBuffer(chunk)
    this.pendingBuffer = this.pendingBuffer.length > 0
      ? Buffer.concat([this.pendingBuffer, chunkBuffer])
      : chunkBuffer

    const frames = []
    let offset = 0

    while (this.pendingBuffer.length - offset >= 5) {
      const frameLength = this.pendingBuffer.readUInt32BE(offset + 1)
      const frameSize = 5 + frameLength

      if (this.pendingBuffer.length - offset < frameSize) {
        break
      }

      frames.push(this.pendingBuffer.subarray(offset, offset + frameSize))
      offset += frameSize
    }

    this.pendingBuffer = offset > 0
      ? this.pendingBuffer.subarray(offset)
      : this.pendingBuffer

    return frames
  }

  flush() {
    this.pendingBuffer = Buffer.alloc(0)
  }
}

export class StreamTextExtractor {
  constructor(userPrompt = '') {
    this.userPrompt = userPrompt
    this.frameAccumulator = new FrameAccumulator()
    this.frameBuffers = []
    this.latestText = ''
  }

  push(chunk) {
    const frames = this.frameAccumulator.push(chunk)
    if (frames.length === 0) {
      return ''
    }

    this.frameBuffers = [...this.frameBuffers, ...frames]
    const allData = Buffer.concat(this.frameBuffers)
    const nextText = extractTextFromResponse(allData, this.userPrompt)
    const delta = computeTextDelta(this.latestText, nextText)
    this.latestText = nextText
    return delta
  }

  flush() {
    this.frameAccumulator.flush()
    return ''
  }
}

export const __testables = Object.freeze({
  appendBuffers,
  computeTextDelta,
})
