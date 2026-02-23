import { randomUUID } from 'crypto'
import { TOOL_NAME_RE } from './validation.mjs'

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'
const ARGUMENT_CHUNK_SIZE = 20

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function extractMessageText(content) {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isObject(part)) return ''
        if (part.type === 'text' && typeof part.text === 'string') {
          return part.text
        }
        if (part.type === 'image_url') {
          return '[image]'
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }

  return String(content ?? '')
}

function createToolCallId() {
  const compact = randomUUID().replace(/-/g, '')
  return `call_${compact.slice(0, 24)}`
}

function toArgumentsString(value) {
  if (typeof value === 'string') return value

  if (value === undefined) {
    return '{}'
  }

  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

function normalizeSingleToolCall(candidate) {
  if (!isObject(candidate)) return null

  const functionSource = isObject(candidate.function)
    ? candidate.function
    : isObject(candidate.tool)
      ? candidate.tool
      : candidate

  const name = typeof functionSource.name === 'string'
    ? functionSource.name
    : typeof candidate.name === 'string'
      ? candidate.name
      : ''

  if (!TOOL_NAME_RE.test(name)) return null

  const argsValue = functionSource.arguments
    ?? candidate.arguments
    ?? functionSource.args
    ?? candidate.args
    ?? functionSource.parameters
    ?? candidate.parameters

  const id = typeof candidate.id === 'string' && candidate.id.length > 0
    ? candidate.id
    : typeof candidate.tool_call_id === 'string' && candidate.tool_call_id.length > 0
      ? candidate.tool_call_id
      : createToolCallId()

  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: toArgumentsString(argsValue),
    },
  }
}

function normalizeToolCallPayload(parsed) {
  if (Array.isArray(parsed)) {
    return parsed
      .map(normalizeSingleToolCall)
      .filter(Boolean)
  }

  if (!isObject(parsed)) {
    return []
  }

  if (Array.isArray(parsed.tool_calls)) {
    return parsed.tool_calls
      .map(normalizeSingleToolCall)
      .filter(Boolean)
  }

  const single = normalizeSingleToolCall(parsed)
  return single ? [single] : []
}

function parseToolCallPayload(payload) {
  if (typeof payload !== 'string') return []

  const trimmed = payload.trim()
  if (trimmed.length === 0) return []

  try {
    return normalizeToolCallPayload(JSON.parse(trimmed))
  } catch {
    return []
  }
}

function parseFromCodeBlocks(text) {
  const codeBlockRe = /```(?:json)?\s*([\s\S]*?)```/gi
  const toolCalls = []
  const contentParts = []
  let lastIndex = 0

  let match = codeBlockRe.exec(text)
  while (match !== null) {
    const parsed = parseToolCallPayload(match[1])
    if (parsed.length > 0) {
      contentParts.push(text.slice(lastIndex, match.index))
      toolCalls.push(...parsed)
      lastIndex = match.index + match[0].length
    }
    match = codeBlockRe.exec(text)
  }

  if (toolCalls.length === 0) {
    return null
  }

  contentParts.push(text.slice(lastIndex))

  return {
    content: contentParts.join('').trim(),
    toolCalls,
  }
}

function getToolChoiceInstruction(toolChoice) {
  if (toolChoice === 'none') {
    return 'Tool choice is "none". Do not emit any <tool_call> blocks.'
  }

  if (toolChoice === 'required') {
    return 'Tool choice is "required". You must emit at least one <tool_call> block.'
  }

  if (isObject(toolChoice) && toolChoice.type === 'function' && isObject(toolChoice.function)) {
    return `Tool choice is fixed. You must call only "${toolChoice.function.name}".`
  }

  return 'Tool choice is "auto". Emit a <tool_call> block only when a tool is needed.'
}

function formatToolDefinition(tool, index) {
  const fn = tool.function
  const description = typeof fn.description === 'string' && fn.description.length > 0
    ? fn.description
    : 'No description provided.'
  const parameters = fn.parameters ?? { type: 'object', properties: {}, additionalProperties: true }
  const paramsJson = JSON.stringify(parameters, null, 2)
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n')

  return [
    `${index + 1}. ${fn.name}`,
    `   Description: ${description}`,
    '   Parameters JSON Schema:',
    paramsJson,
  ].join('\n')
}

export function buildToolSystemPrompt(tools, toolChoice = 'auto') {
  if (!Array.isArray(tools) || tools.length === 0) {
    return ''
  }

  const definitions = tools.map(formatToolDefinition).join('\n\n')

  return [
    'Tool Calling Protocol:',
    getToolChoiceInstruction(toolChoice),
    'When calling a tool, emit XML blocks only in this exact format:',
    '<tool_call>{"name":"tool_name","arguments":{"key":"value"}}</tool_call>',
    'Do not wrap tool calls in markdown fences.',
    'Do not include extra keys beyond name/arguments in the JSON body.',
    'You may emit multiple <tool_call> blocks when needed.',
    '',
    'Available Tools:',
    definitions,
  ].join('\n')
}

export function buildToolResultContext(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return ''
  }

  const lines = []

  for (const message of messages) {
    if (!isObject(message)) continue

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (!isObject(toolCall) || !isObject(toolCall.function)) continue
        const name = typeof toolCall.function.name === 'string' ? toolCall.function.name : ''
        const id = typeof toolCall.id === 'string' ? toolCall.id : ''
        const args = typeof toolCall.function.arguments === 'string'
          ? toolCall.function.arguments
          : '{}'

        if (name) {
          lines.push(`assistant_tool_call id=${id || 'unknown'} name=${name} arguments=${args}`)
        }
      }
    }

    if (message.role === 'tool') {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : 'unknown'
      const result = extractMessageText(message.content)
      lines.push(`tool_result tool_call_id=${callId} content=${result}`)
    }
  }

  return lines.join('\n')
}

export function parseToolCalls(responseText) {
  const text = typeof responseText === 'string' ? responseText : String(responseText ?? '')
  const toolCalls = []
  const contentParts = []

  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let lastIndex = 0
  let match = tagRe.exec(text)

  while (match !== null) {
    contentParts.push(text.slice(lastIndex, match.index))

    const parsed = parseToolCallPayload(match[1])
    if (parsed.length > 0) {
      toolCalls.push(...parsed)
    } else {
      contentParts.push(match[0])
    }

    lastIndex = match.index + match[0].length
    match = tagRe.exec(text)
  }

  contentParts.push(text.slice(lastIndex))

  const danglingOpenTagIndex = text.lastIndexOf(OPEN_TAG)
  const danglingCloseTagIndex = text.lastIndexOf(CLOSE_TAG)
  const hasPendingToolCall = danglingOpenTagIndex > danglingCloseTagIndex

  let content = contentParts.join('')
  if (hasPendingToolCall && danglingOpenTagIndex >= 0) {
    content = text.slice(0, danglingOpenTagIndex)
  }

  if (toolCalls.length === 0 && !hasPendingToolCall) {
    const fromCodeBlock = parseFromCodeBlocks(text)
    if (fromCodeBlock) {
      return {
        content: fromCodeBlock.content,
        toolCalls: fromCodeBlock.toolCalls,
        pendingToolCall: false,
      }
    }

    const direct = parseToolCallPayload(text.trim())
    if (direct.length > 0) {
      return {
        content: '',
        toolCalls: direct,
        pendingToolCall: false,
      }
    }
  }

  return {
    content: content.trim(),
    toolCalls,
    pendingToolCall: hasPendingToolCall,
  }
}

export class ToolCallStreamBuffer {
  constructor({ onContentDelta, onToolCallStart, onToolCallArgumentsDelta } = {}, options = {}) {
    this.onContentDelta = typeof onContentDelta === 'function' ? onContentDelta : () => {}
    this.onToolCallStart = typeof onToolCallStart === 'function' ? onToolCallStart : () => {}
    this.onToolCallArgumentsDelta = typeof onToolCallArgumentsDelta === 'function'
      ? onToolCallArgumentsDelta
      : () => {}

    this.argumentsChunkSize = Number.isInteger(options.argumentsChunkSize) && options.argumentsChunkSize > 0
      ? options.argumentsChunkSize
      : ARGUMENT_CHUNK_SIZE

    this.pending = ''
    this.toolBuffer = ''
    this.mode = 'content'
    this.nextIndex = 0
  }

  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
    if (!text) return
    this.pending += text
    this.drain()
  }

  flush() {
    if (this.mode === 'tool') {
      const remaining = `${OPEN_TAG}${this.toolBuffer}${this.pending}`
      if (remaining.length > 0) {
        this.onContentDelta(remaining)
      }
    } else if (this.pending.length > 0) {
      this.onContentDelta(this.pending)
    }

    this.pending = ''
    this.toolBuffer = ''
    this.mode = 'content'
  }

  drain() {
    while (this.pending.length > 0) {
      if (this.mode === 'content') {
        const openIndex = this.pending.indexOf(OPEN_TAG)
        if (openIndex === -1) {
          const emitLength = this.getSafePrefixLength(this.pending, OPEN_TAG)
          if (emitLength > 0) {
            this.onContentDelta(this.pending.slice(0, emitLength))
            this.pending = this.pending.slice(emitLength)
          }
          break
        }

        if (openIndex > 0) {
          this.onContentDelta(this.pending.slice(0, openIndex))
        }

        this.pending = this.pending.slice(openIndex + OPEN_TAG.length)
        this.mode = 'tool'
        this.toolBuffer = ''
        continue
      }

      const closeIndex = this.pending.indexOf(CLOSE_TAG)
      if (closeIndex === -1) {
        this.toolBuffer += this.pending
        this.pending = ''
        break
      }

      this.toolBuffer += this.pending.slice(0, closeIndex)
      this.pending = this.pending.slice(closeIndex + CLOSE_TAG.length)
      this.emitToolCallOrFallback(this.toolBuffer)
      this.toolBuffer = ''
      this.mode = 'content'
    }
  }

  emitToolCallOrFallback(rawPayload) {
    const parsed = parseToolCallPayload(rawPayload)
    if (parsed.length === 0) {
      this.onContentDelta(`${OPEN_TAG}${rawPayload}${CLOSE_TAG}`)
      return
    }

    for (const toolCall of parsed) {
      const index = this.nextIndex
      this.nextIndex += 1
      this.onToolCallStart(index, toolCall.id, toolCall.function.name)
      this.emitArguments(index, toolCall.function.arguments)
    }
  }

  emitArguments(index, argumentsText) {
    if (argumentsText.length === 0) {
      return
    }

    for (let start = 0; start < argumentsText.length; start += this.argumentsChunkSize) {
      this.onToolCallArgumentsDelta(index, argumentsText.slice(start, start + this.argumentsChunkSize))
    }
  }

  getSafePrefixLength(buffer, tag) {
    const maxSuffixLength = Math.min(tag.length - 1, buffer.length)

    for (let suffixLength = maxSuffixLength; suffixLength > 0; suffixLength -= 1) {
      const suffix = buffer.slice(-suffixLength)
      if (tag.startsWith(suffix)) {
        return buffer.length - suffixLength
      }
    }

    return buffer.length
  }
}
