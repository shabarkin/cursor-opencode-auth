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

const SUBAGENT_TYPE_FIELD_TO_NAME = Object.freeze({
  1: 'general',
  2: 'general',
  3: 'general',
  4: 'explore',
  5: 'general',
  6: 'general',
  7: 'general',
  8: 'general',
  9: 'general',
  10: 'general',
})

const TODO_STATUS_FIELD_TO_NAME = Object.freeze({
  1: 'pending',
  2: 'in_progress',
  3: 'completed',
  4: 'cancelled',
})

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

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
      const [value, nextPosition] = readVarint(message, position)
      if (nextPosition <= position) break
      onField(fieldNumber, wireType, value)
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

function getFirstField(message, targetFieldNumber, targetWireType) {
  let result = null

  forEachProtoField(message, (fieldNumber, wireType, value) => {
    if (result !== null) return
    if (fieldNumber !== targetFieldNumber || wireType !== targetWireType) return
    result = value
  })

  return result
}

function getAllFields(message, targetFieldNumber, targetWireType) {
  const values = []

  forEachProtoField(message, (fieldNumber, wireType, value) => {
    if (fieldNumber !== targetFieldNumber || wireType !== targetWireType) return
    values.push(value)
  })

  return values
}

function getStringField(message, fieldNumber) {
  const value = getFirstField(message, fieldNumber, 2)
  return Buffer.isBuffer(value) ? value.toString('utf8') : ''
}

function getMessageField(message, fieldNumber) {
  const value = getFirstField(message, fieldNumber, 2)
  return Buffer.isBuffer(value) ? value : null
}

function getIntField(message, fieldNumber) {
  const value = getFirstField(message, fieldNumber, 0)
  return typeof value === 'number' ? value : null
}

function getBoolField(message, fieldNumber) {
  const value = getFirstField(message, fieldNumber, 0)
  return typeof value === 'number' ? value === 1 : null
}

function getRepeatedStrings(message, fieldNumber) {
  return getAllFields(message, fieldNumber, 2)
    .map(value => value.toString('utf8'))
}

function getRepeatedMessages(message, fieldNumber) {
  return getAllFields(message, fieldNumber, 2)
}

function parseFirstStringField(message, targetFieldNumber) {
  return getStringField(message, targetFieldNumber)
}

function parseGlobToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  if (!argsPayload) return {}

  const pattern = getStringField(argsPayload, 2)
  const path = getStringField(argsPayload, 1)

  const args = {}
  if (pattern.length > 0) args.pattern = pattern
  if (path.length > 0) args.path = path
  return args
}

function parseShellToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  if (!argsPayload) return {}

  const command = getStringField(argsPayload, 1)
  const workdir = getStringField(argsPayload, 2)
  const timeout = getIntField(argsPayload, 3)

  const args = {}
  if (command.length > 0) args.command = command
  if (workdir.length > 0) args.workdir = workdir
  if (Number.isFinite(timeout) && timeout > 0) args.timeout = timeout
  return args
}

function parseGrepToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  if (!argsPayload) return {}

  const pattern = getStringField(argsPayload, 1)
  const path = getStringField(argsPayload, 2)
  const include = getStringField(argsPayload, 3)

  const args = {}
  if (pattern.length > 0) args.pattern = pattern
  if (path.length > 0) args.path = path
  if (include.length > 0) args.include = include
  return args
}

function parseReadToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  if (!argsPayload) return {}

  const filePath = getStringField(argsPayload, 1)
  const offset = getIntField(argsPayload, 2)
  const limit = getIntField(argsPayload, 3)

  const args = {}
  if (filePath.length > 0) args.filePath = filePath
  if (Number.isFinite(offset) && offset > 0) args.offset = offset
  if (Number.isFinite(limit) && limit > 0) args.limit = limit
  return args
}

function parseTodoItem(todoPayload) {
  const content = getStringField(todoPayload, 2)
  if (content.length === 0) return null

  const statusValue = getIntField(todoPayload, 3)
  const status = TODO_STATUS_FIELD_TO_NAME[statusValue] ?? 'pending'

  return {
    content,
    status,
    priority: 'medium',
  }
}

function parseUpdateTodosToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  if (!argsPayload) return {}

  const todos = getRepeatedMessages(argsPayload, 1)
    .map(parseTodoItem)
    .filter(Boolean)

  return todos.length > 0 ? { todos } : {}
}

function parseReadTodosToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  if (!argsPayload) return {}

  const idFilter = getRepeatedStrings(argsPayload, 2)
  return idFilter.length > 0
    ? { todos: idFilter.map(id => ({ content: `todo:${id}`, status: 'pending', priority: 'medium' })) }
    : {}
}

function parseEditToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  if (!argsPayload) return {}

  const filePath = getStringField(argsPayload, 1)
  const content = getStringField(argsPayload, 6)

  const args = {}
  if (filePath.length > 0) args.filePath = filePath
  if (content.length > 0) args.content = content
  return args
}

function parseLsToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  if (!argsPayload) return {}

  const path = getStringField(argsPayload, 1)
  return path.length > 0 ? { path } : {}
}

function parseSubagentType(subagentPayload) {
  let subagentType = 'general'

  forEachProtoField(subagentPayload, (fieldNumber, wireType) => {
    if (wireType !== 2) return
    subagentType = SUBAGENT_TYPE_FIELD_TO_NAME[fieldNumber] ?? 'general'
  })

  return subagentType
}

function parseTaskToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  if (!argsPayload) return {}

  const description = getStringField(argsPayload, 1)
  const prompt = getStringField(argsPayload, 2)
  const subagentPayload = getMessageField(argsPayload, 3)
  const model = getStringField(argsPayload, 4)

  const args = {}
  if (description.length > 0) args.description = description
  if (prompt.length > 0) args.prompt = prompt
  if (subagentPayload) args.subagent_type = parseSubagentType(subagentPayload)
  if (model.length > 0) args.model = model
  return args
}

function parseAskQuestionOptions(questionPayload) {
  const options = getRepeatedMessages(questionPayload, 3)
    .map((optionPayload) => {
      const label = getStringField(optionPayload, 2) || getStringField(optionPayload, 1)
      if (label.length === 0) return null

      return {
        label,
        description: getStringField(optionPayload, 1) || label,
      }
    })
    .filter(Boolean)

  return options.length > 0
    ? options
    : [
      { label: 'Yes', description: 'Confirm yes' },
      { label: 'No', description: 'Confirm no' },
    ]
}

function parseAskQuestionArgsPayload(argsPayload) {
  if (!argsPayload) return {}

  const title = getStringField(argsPayload, 1)
  const questions = getRepeatedMessages(argsPayload, 2)
    .map((questionPayload) => {
      const prompt = getStringField(questionPayload, 2)
      const header = (getStringField(questionPayload, 1) || title || 'Question').slice(0, 30)
      if (prompt.length === 0) return null

      const multiple = getBoolField(questionPayload, 4)
      const mapped = {
        question: prompt,
        header,
        options: parseAskQuestionOptions(questionPayload),
      }

      if (multiple === true) {
        mapped.multiple = true
      }

      return mapped
    })
    .filter(Boolean)

  return questions.length > 0 ? { questions } : {}
}

function parseAskQuestionToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  return parseAskQuestionArgsPayload(argsPayload)
}

function parseWebSearchArgsPayload(argsPayload) {
  if (!argsPayload) return {}

  const query = getStringField(argsPayload, 1)
  return query.length > 0
    ? { query, thinking: true }
    : {}
}

function parseWebSearchToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  return parseWebSearchArgsPayload(argsPayload)
}

function parseFetchArgsPayload(argsPayload) {
  if (!argsPayload) return {}

  const url = getStringField(argsPayload, 1)
  return url.length > 0
    ? { url, format: 'markdown' }
    : {}
}

function parseFetchLikeToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  return parseFetchArgsPayload(argsPayload)
}

function parseSwitchModeArgsPayload(argsPayload) {
  if (!argsPayload) return {}

  const targetModeId = getStringField(argsPayload, 1)
  const explanation = getStringField(argsPayload, 2)

  const description = `Switch mode to ${targetModeId || 'requested mode'}`
  const prompt = explanation.length > 0
    ? `${description}. ${explanation}`
    : description

  return {
    description,
    prompt,
    subagent_type: 'general',
  }
}

function parseCreatePlanArgsPayload(argsPayload) {
  if (!argsPayload) return {}

  const description = getStringField(argsPayload, 4) || 'Create implementation plan'
  const prompt = getStringField(argsPayload, 1) || description

  return {
    description,
    prompt,
    subagent_type: 'general',
  }
}

function parseCreatePlanToolCall(toolPayload) {
  const argsPayload = getMessageField(toolPayload, 1)
  return parseCreatePlanArgsPayload(argsPayload)
}

const TOOL_CALL_ARG_PARSERS = Object.freeze({
  1: parseShellToolCall,
  3: () => ({}),
  4: parseGlobToolCall,
  5: parseGrepToolCall,
  8: parseReadToolCall,
  9: parseUpdateTodosToolCall,
  10: parseReadTodosToolCall,
  12: parseEditToolCall,
  13: parseLsToolCall,
  17: parseCreatePlanToolCall,
  18: parseWebSearchToolCall,
  19: parseTaskToolCall,
  23: parseAskQuestionToolCall,
  24: parseFetchLikeToolCall,
  37: parseFetchLikeToolCall,
})

function parseToolCall(toolCallPayload) {
  let toolName = null
  let toolArguments = {}

  forEachProtoField(toolCallPayload, (fieldNumber, wireType, value) => {
    if (toolName !== null) return
    if (wireType !== 2) return

    toolName = TOOL_CALL_FIELD_TO_NAME[fieldNumber] ?? null
    if (toolName === null) return

    const parser = TOOL_CALL_ARG_PARSERS[fieldNumber]
    toolArguments = typeof parser === 'function' ? parser(value) : {}
  })

  return { toolName, toolArguments: isObject(toolArguments) ? toolArguments : {} }
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
  let toolArguments = {}

  forEachProtoField(payload, (fieldNumber, wireType, value) => {
    if (wireType !== 2) return

    if (fieldNumber === 1) {
      callId = value.toString('utf8')
      return
    }

    if (fieldNumber === 2) {
      const parsed = parseToolCall(value)
      toolName = parsed.toolName
      toolArguments = parsed.toolArguments
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
    toolArguments,
    modelCallId,
  }
}

function parsePartialToolCallUpdate(payload) {
  let callId = ''
  let modelCallId = ''
  let toolName = null
  let toolArguments = {}
  let argsTextDelta = ''

  forEachProtoField(payload, (fieldNumber, wireType, value) => {
    if (wireType !== 2) return

    if (fieldNumber === 1) {
      callId = value.toString('utf8')
      return
    }

    if (fieldNumber === 2) {
      const parsed = parseToolCall(value)
      toolName = parsed.toolName
      toolArguments = parsed.toolArguments
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
    toolArguments,
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

function buildInteractionQueryEvent(queryId, callId, toolName, toolArguments) {
  return {
    type: 'interaction_query',
    queryId,
    callId,
    toolName,
    toolArguments,
  }
}

function parseInteractionQuery(payload) {
  const queryId = getIntField(payload, 1)
  let queryEvent = null

  forEachProtoField(payload, (fieldNumber, wireType, value) => {
    if (queryEvent !== null) return
    if (wireType !== 2) return

    if (fieldNumber === 2) {
      const argsPayload = getMessageField(value, 1)
      queryEvent = buildInteractionQueryEvent(queryId, '', 'web_search', parseWebSearchArgsPayload(argsPayload))
      return
    }

    if (fieldNumber === 3) {
      const argsPayload = getMessageField(value, 1)
      const callId = getStringField(value, 2)
      queryEvent = buildInteractionQueryEvent(queryId, callId, 'ask_question', parseAskQuestionArgsPayload(argsPayload))
      return
    }

    if (fieldNumber === 4) {
      const argsPayload = getMessageField(value, 1)
      queryEvent = buildInteractionQueryEvent(queryId, '', 'switch_mode', parseSwitchModeArgsPayload(argsPayload))
      return
    }

    if (fieldNumber === 7) {
      const argsPayload = getMessageField(value, 1)
      const callId = getStringField(value, 2)
      queryEvent = buildInteractionQueryEvent(queryId, callId, 'create_plan', parseCreatePlanArgsPayload(argsPayload))
      return
    }

    if (fieldNumber === 9) {
      const argsPayload = getMessageField(value, 1)
      queryEvent = buildInteractionQueryEvent(queryId, '', 'web_fetch', parseFetchArgsPayload(argsPayload))
      return
    }
  })

  return queryEvent
}

function parseAgentServerMessage(payload) {
  const events = []

  forEachProtoField(payload, (fieldNumber, wireType, value) => {
    if (wireType !== 2) return

    if (fieldNumber === 1) {
      events.push(...parseInteractionUpdate(value))
      return
    }

    if (fieldNumber === 7) {
      const queryEvent = parseInteractionQuery(value)
      if (queryEvent) {
        events.push(queryEvent)
      }
    }
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
