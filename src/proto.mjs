/**
 * Protobuf encoding/decoding utilities for Cursor's Connect-RPC protocol.
 *
 * Implements manual protobuf wire-format handling without external
 * dependencies. Handles both writing (request encoding) and reading
 * (response string extraction).
 */

import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Writer — encodes protobuf wire format
// ---------------------------------------------------------------------------

export class ProtoWriter {
  constructor() {
    this.parts = []
  }

  writeVarint(v) {
    const bytes = []
    let value = v
    while (value > 127) {
      bytes.push((value & 0x7f) | 0x80)
      value >>>= 7
    }
    bytes.push(value & 0x7f)
    this.parts.push(Buffer.from(bytes))
  }

  writeString(field, value) {
    const buf = Buffer.from(value, 'utf8')
    this.writeVarint((field << 3) | 2)
    this.writeVarint(buf.length)
    this.parts.push(buf)
  }

  writeMessage(field, writer) {
    const buf = writer.toBuffer()
    this.writeVarint((field << 3) | 2)
    this.writeVarint(buf.length)
    this.parts.push(buf)
  }

  writeInt32(field, value) {
    this.writeVarint((field << 3) | 0)
    this.writeVarint(value)
  }

  toBuffer() {
    return Buffer.concat(this.parts)
  }
}

// ---------------------------------------------------------------------------
// Reader — decodes varint and extracts strings from protobuf messages
// ---------------------------------------------------------------------------

const MAX_VARINT_BYTES = 5 // 5 bytes covers up to 2^35, safe for 32-bit fields
const MAX_PROTO_DEPTH = 32

/**
 * Read a varint from buffer at the given position.
 * Uses multiplication instead of bitwise shift to avoid signed 32-bit overflow.
 *
 * @param {Buffer} buf
 * @param {number} pos
 * @returns {[number, number]} [value, newPosition]
 */
export function readVarint(buf, pos) {
  let result = 0
  let shift = 0
  let currentPos = pos
  let bytesRead = 0

  while (currentPos < buf.length) {
    const byte = buf[currentPos]
    currentPos += 1
    bytesRead += 1
    result += (byte & 0x7f) * (2 ** shift)
    if ((byte & 0x80) === 0) break
    shift += 7
    if (bytesRead >= MAX_VARINT_BYTES) break
  }

  return [result, currentPos]
}

/**
 * Recursively extract all printable strings from a protobuf message.
 *
 * @param {Buffer} buf
 * @param {string} fieldPath  - dot-separated field path for debugging
 * @param {number} depth      - current recursion depth
 * @returns {Array<{text: string, fieldPath: string, depth: number}>}
 */
export function extractStringsFromProtobuf(buf, fieldPath = '', depth = 0) {
  if (depth > MAX_PROTO_DEPTH) return []

  const strings = []
  let pos = 0

  while (pos < buf.length) {
    const [tag, newPos] = readVarint(buf, pos)
    if (newPos === pos) break
    pos = newPos

    const fieldNum = tag >> 3
    const wireType = tag & 0x07
    const currentPath = fieldPath ? `${fieldPath}.${fieldNum}` : `${fieldNum}`

    if (wireType === 0) {
      // Varint — skip
      const [, nextPos] = readVarint(buf, pos)
      pos = nextPos
    } else if (wireType === 1) {
      // 64-bit fixed — skip 8 bytes
      pos += 8
    } else if (wireType === 2) {
      // Length-delimited (string, bytes, or embedded message)
      const [len, dataStart] = readVarint(buf, pos)
      pos = dataStart + len

      if (len > 0 && dataStart + len <= buf.length) {
        const data = buf.subarray(dataStart, dataStart + len)

        // Try to parse as embedded message first
        const nested = extractStringsFromProtobuf(data, currentPath, depth + 1)
        if (nested.length > 0) {
          strings.push(...nested)
        }

        // Also check if it looks like a printable string
        const str = data.toString('utf8')
        if (str.length > 0 && /^[\x20-\x7e\n\r\t]+$/.test(str)) {
          strings.push({ text: str, fieldPath: currentPath, depth })
        }
      }
    } else if (wireType === 5) {
      // 32-bit fixed — skip 4 bytes
      pos += 4
    } else {
      // Unknown wire type — bail
      break
    }
  }

  return strings
}

// ---------------------------------------------------------------------------
// Request builder — constructs AgentService/Run protobuf payload
// ---------------------------------------------------------------------------

/**
 * Build a protobuf request payload for Cursor's AgentService/Run endpoint.
 *
 * @param {string} text    - user prompt
 * @param {string} model   - model identifier (e.g. 'composer-1')
 * @param {string} context - conversation context
 * @returns {{ payload: Buffer, messageId: string, conversationId: string }}
 */
export function buildProtobufRequest(text, model = 'composer-1', context = '') {
  const messageId = randomUUID()
  const conversationId = randomUUID()

  const userMsg = new ProtoWriter()
  userMsg.writeString(1, text)
  userMsg.writeString(2, messageId)
  userMsg.writeString(3, '')

  const fileCtx = new ProtoWriter()
  fileCtx.writeString(1, '/context.txt')
  fileCtx.writeString(2, context || 'OpenCode session')

  const explicitCtx = new ProtoWriter()
  explicitCtx.writeMessage(2, fileCtx)

  const userMsgAction = new ProtoWriter()
  userMsgAction.writeMessage(1, userMsg)
  userMsgAction.writeMessage(2, explicitCtx)

  const convAction = new ProtoWriter()
  convAction.writeMessage(1, userMsgAction)

  const displayName = model.charAt(0).toUpperCase() + model.slice(1).replace(/-/g, ' ')
  const modelDetails = new ProtoWriter()
  modelDetails.writeString(1, model)
  modelDetails.writeString(3, model)
  modelDetails.writeString(4, displayName)
  modelDetails.writeString(5, displayName)
  modelDetails.writeInt32(7, 0)

  const runReq = new ProtoWriter()
  runReq.writeString(1, '')
  runReq.writeMessage(2, convAction)
  runReq.writeMessage(3, modelDetails)
  runReq.writeString(4, '')
  runReq.writeString(5, conversationId)

  const clientMsg = new ProtoWriter()
  clientMsg.writeMessage(1, runReq)

  return { payload: clientMsg.toBuffer(), messageId, conversationId }
}

// ---------------------------------------------------------------------------
// Connect-RPC framing
// ---------------------------------------------------------------------------

/**
 * Wrap a protobuf payload in a Connect-RPC frame.
 *
 * Frame format: [1 byte compression flag] [4 bytes length BE] [payload]
 *
 * @param {Buffer} payload
 * @returns {Buffer}
 */
export function createFrame(payload) {
  const frame = Buffer.alloc(5 + payload.length)
  frame[0] = 0 // Not compressed
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  return frame
}
