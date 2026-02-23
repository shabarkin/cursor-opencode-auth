import zlib from 'zlib'
import { readVarint } from './proto.mjs'

const TOOL_CALL_FIELD_TO_NAME = Object.freeze({
  1: 'shell',
  3: 'delete',
  4: 'glob',
  5: 'grep',
  8: 'read',
  9: 'update_todos',
  10: 'read_todos',
  12: 'edit',
  13: 'ls',
  14: 'read_lints',
  15: 'mcp',
  16: 'sem_search',
  17: 'create_plan',
  18: 'web_search',
  19: 'task',
  20: 'list_mcp_resources',
  21: 'read_mcp_resource',
  22: 'apply_agent_diff',
  23: 'ask_question',
  24: 'fetch',
  25: 'switch_mode',
  28: 'generate_image',
  29: 'record_screen',
  30: 'computer_use',
  31: 'write_shell_stdin',
  32: 'reflect',
  33: 'setup_vm_environment',
  34: 'truncated',
  35: 'start_grind_execution',
  36: 'start_grind_planning',
  37: 'web_fetch',
  38: 'pr_management',
  39: 'mcp_auth',
})

const TOOL_CALL_DELTA_FIELD_TO_NAME = Object.freeze({
  1: 'shell',
  2: 'task',
  3: 'edit',
})

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk
  return Buffer.from(chunk)
}

function forEachProtoField(message, onField) {
  let position = 0

  while (position < message.length) {
    const [tag, afterTag] = readVarint(message, position)
    if (afterTag <= position) break

    const fieldNumber = tag >> 3
    const wireType = tag & 0x07
    position = afterTag

    if (wireType === 0) {
      const [, nextPosition] = readVarint(message, position)
      if (nextPosition <= position) break
      position = nextPosition
      continue
    }

    if (wireType === 1) {
      if (position + 8 > message.length) break
      position += 8
      continue
    }

    if (wireType === 2) {
      const [length, dataStart] = readVarint(message, position)
      if (dataStart <= position) break
      if (length < 0) break

      const dataEnd = dataStart + length
      if (dataEnd > message.length) break

      onField(fieldNumber, wireType, message.subarray(dataStart, dataEnd))
      position = dataEnd
      continue
    }

    if (wireType === 5) {
      if (position + 4 > message.length) break
      position += 4
      continue
    }

    break
  }
}

function parseFirstStringField(message, targetFieldNumber) {
  let result = ''

  forEachProtoField(message, (fieldNumber, wireType, value) => {
    if (result.length > 0) return
    if (fieldNumber !== targetFieldNumber || wireType !== 2) return
    result = value.toString('utf8')
  })

  return result
}

function parseToolCallName(toolCallPayload) {
  let toolName = null

  forEachProtoField(toolCallPayload, (fieldNumber, wireType) => {
    if (toolName !== null) return
    if (wireType !== 2) return
    toolName = TOOL_CALL_FIELD_TO_NAME[fieldNumber] ?? null
  })

  return toolName
}

function parseToolCallDeltaKind(toolCallDeltaPayload) {
  let deltaKind = null

  forEachProtoField(toolCallDeltaPayload, (fieldNumber, wireType) => {
    if (deltaKind !== null) return
    if (wireType !== 2) return
    deltaKind = TOOL_CALL_DELTA_FIELD_TO_NAME[fieldNumber] ?? null
  })

  return deltaKind
}

function parseTextDeltaUpdate(payload) {
  return parseFirstStringField(payload, 1)
}

function parseToolCallStateUpdate(payload, type) {
  let callId = ''
  let modelCallId = ''
  let toolName = null

  forEachProtoField(payload, (fieldNumber, wireType, value) => {
    if (wireType !== 2) return

    if (fieldNumber === 1) {
      callId = value.toString('utf8')
      return
    }

    if (fieldNumber === 2) {
      toolName = parseToolCallName(value)
      return
    }

    if (fieldNumber === 3) {
      modelCallId = value.toString('utf8')
    }
  })

  return {
    type,
    callId,
    toolName,
    modelCallId,
  }
}

function parsePartialToolCallUpdate(payload) {
  let callId = ''
  let modelCallId = ''
  let toolName = null
  let argsTextDelta = ''

  forEachProtoField(payload, (fieldNumber, wireType, value) => {
    if (wireType !== 2) return

    if (fieldNumber === 1) {
      callId = value.toString('utf8')
      return
    }

    if (fieldNumber === 2) {
      toolName = parseToolCallName(value)
      return
    }

    if (fieldNumber === 3) {
      argsTextDelta = value.toString('utf8')
      return
    }

    if (fieldNumber === 4) {
      modelCallId = value.toString('utf8')
    }
  })

  return {
    type: 'partial_tool_call',
    callId,
    toolName,
    argsTextDelta,
    modelCallId,
  }
}

function parseToolCallDeltaUpdate(payload) {
  let callId = ''
  let modelCallId = ''
  let deltaKind = null

  forEachProtoField(payload, (fieldNumber, wireType, value) => {
    if (wireType !== 2) return

    if (fieldNumber === 1) {
      callId = value.toString('utf8')
      return
    }

    if (fieldNumber === 2) {
      deltaKind = parseToolCallDeltaKind(value)
      return
    }

    if (fieldNumber === 3) {
      modelCallId = value.toString('utf8')
    }
  })

  return {
    type: 'tool_call_delta',
    callId,
    deltaKind,
    modelCallId,
  }
}

function parseInteractionUpdate(payload) {
  const events = []

  forEachProtoField(payload, (fieldNumber, wireType, value) => {
    if (wireType !== 2) return

    if (fieldNumber === 1) {
      const text = parseTextDeltaUpdate(value)
      if (text.length > 0) {
        events.push({ type: 'text_delta', text })
      }
      return
    }

    if (fieldNumber === 2) {
      events.push(parseToolCallStateUpdate(value, 'tool_call_started'))
      return
    }

    if (fieldNumber === 3) {
      events.push(parseToolCallStateUpdate(value, 'tool_call_completed'))
      return
    }

    if (fieldNumber === 7) {
      events.push(parsePartialToolCallUpdate(value))
      return
    }

    if (fieldNumber === 14) {
      events.push({ type: 'turn_ended' })
      return
    }

    if (fieldNumber === 15) {
      events.push(parseToolCallDeltaUpdate(value))
    }
  })

  return events
}

function parseAgentServerMessage(payload) {
  const events = []

  forEachProtoField(payload, (fieldNumber, wireType, value) => {
    if (fieldNumber !== 1 || wireType !== 2) return
    events.push(...parseInteractionUpdate(value))
  })

  return events
}

function parseConnectFrame(frame) {
  if (frame.length < 5) return null

  const compressed = frame[0]
  const payloadLength = frame.readUInt32BE(1)
  if (frame.length !== payloadLength + 5) return null

  let payload = frame.subarray(5)
  if (compressed === 1) {
    try {
      payload = zlib.gunzipSync(payload)
    } catch {
      return null
    }
  }

  return payload
}

export class InteractionEventStreamParser {
  constructor() {
    this.pendingBuffer = Buffer.alloc(0)
  }

  push(chunk) {
    const chunkBuffer = toBuffer(chunk)
    this.pendingBuffer = this.pendingBuffer.length > 0
      ? Buffer.concat([this.pendingBuffer, chunkBuffer])
      : chunkBuffer

    const events = []
    let offset = 0

    while (this.pendingBuffer.length - offset >= 5) {
      const payloadLength = this.pendingBuffer.readUInt32BE(offset + 1)
      const frameLength = payloadLength + 5

      if (this.pendingBuffer.length - offset < frameLength) {
        break
      }

      const frame = this.pendingBuffer.subarray(offset, offset + frameLength)
      const payload = parseConnectFrame(frame)
      if (payload) {
        events.push(...parseAgentServerMessage(payload))
      }

      offset += frameLength
    }

    this.pendingBuffer = offset > 0
      ? this.pendingBuffer.subarray(offset)
      : this.pendingBuffer

    return events
  }

  flush() {
    this.pendingBuffer = Buffer.alloc(0)
  }
}

export function parseInteractionEventsFromResponse(data) {
  const parser = new InteractionEventStreamParser()
  const events = parser.push(data)
  parser.flush()
  return events
}

export function extractTextFromInteractionEvents(events) {
  return events
    .filter(event => event.type === 'text_delta' && typeof event.text === 'string')
    .map(event => event.text)
    .join('')
}
