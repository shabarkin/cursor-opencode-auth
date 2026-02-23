const MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/
const VALID_ROLES_LIST = Object.freeze(['system', 'user', 'assistant', 'tool'])
const VALID_TOOL_CHOICES = Object.freeze(['auto', 'none', 'required'])
const VALID_IMAGE_DETAIL_VALUES = Object.freeze(['auto', 'low', 'high'])

export const MODEL_NAME_RE = MODEL_NAME_PATTERN
export const TOOL_NAME_RE = TOOL_NAME_PATTERN
export const VALID_ROLES = VALID_ROLES_LIST

export class RequestError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'RequestError'
    this.statusCode = statusCode
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isValidDataImageUrl(url) {
  if (typeof url !== 'string') return false
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(url)
}

function sanitizeImagePart(part) {
  const imageUrl = isObject(part.image_url) ? part.image_url : {}
  const sanitizedImageUrl = {
    url: typeof imageUrl.url === 'string' ? imageUrl.url : '',
  }

  if (typeof imageUrl.detail === 'string') {
    sanitizedImageUrl.detail = imageUrl.detail
  }

  return {
    type: 'image_url',
    image_url: sanitizedImageUrl,
  }
}

export function sanitizeContentPart(part) {
  if (!isObject(part)) {
    return { type: '', text: '' }
  }

  if (part.type === 'image_url') {
    return sanitizeImagePart(part)
  }

  return {
    type: typeof part.type === 'string' ? part.type : '',
    text: typeof part.text === 'string' ? part.text : '',
  }
}

export function sanitizeContent(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(sanitizeContentPart)
  return String(content)
}

function sanitizeAssistantToolCall(toolCall) {
  const fn = isObject(toolCall.function) ? toolCall.function : {}

  return {
    id: typeof toolCall.id === 'string' ? toolCall.id : '',
    type: 'function',
    function: {
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
    },
  }
}

function sanitizeMessage(message) {
  const sanitized = {
    role: message.role,
    content: sanitizeContent(message.content),
  }

  if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
    sanitized.tool_call_id = message.tool_call_id
  }

  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    sanitized.tool_calls = message.tool_calls.map(sanitizeAssistantToolCall)
  }

  return sanitized
}

function sanitizeToolDefinition(tool) {
  const fn = isObject(tool.function) ? tool.function : {}
  const sanitizedFunction = {
    name: typeof fn.name === 'string' ? fn.name : '',
  }

  if (typeof fn.description === 'string') {
    sanitizedFunction.description = fn.description
  }

  if (isObject(fn.parameters)) {
    sanitizedFunction.parameters = fn.parameters
  }

  return {
    type: 'function',
    function: sanitizedFunction,
  }
}

function sanitizeToolChoice(toolChoice) {
  if (toolChoice === undefined) return 'auto'
  if (typeof toolChoice === 'string') return toolChoice

  if (isObject(toolChoice)) {
    const fn = isObject(toolChoice.function) ? toolChoice.function : {}
    return {
      type: 'function',
      function: {
        name: typeof fn.name === 'string' ? fn.name : '',
      },
    }
  }

  return 'auto'
}

export function validateContentPart(part, prefix) {
  const errors = []

  if (!isObject(part)) {
    errors.push(`${prefix} must be an object`)
    return errors
  }

  if (!isNonEmptyString(part.type)) {
    errors.push(`${prefix}.type must be a non-empty string`)
    return errors
  }

  if (part.type === 'text') {
    if (typeof part.text !== 'string') {
      errors.push(`${prefix}.text must be a string when type is "text"`)
    }
    return errors
  }

  if (part.type === 'image_url') {
    if (!isObject(part.image_url)) {
      errors.push(`${prefix}.image_url must be an object when type is "image_url"`)
      return errors
    }

    if (!isNonEmptyString(part.image_url.url)) {
      errors.push(`${prefix}.image_url.url must be a non-empty string`)
    } else if (!isValidDataImageUrl(part.image_url.url)) {
      errors.push(`${prefix}.image_url.url must be a base64 data:image URL`)
    }

    if (
      part.image_url.detail !== undefined &&
      (typeof part.image_url.detail !== 'string' || !VALID_IMAGE_DETAIL_VALUES.includes(part.image_url.detail))
    ) {
      errors.push(`${prefix}.image_url.detail must be one of: ${VALID_IMAGE_DETAIL_VALUES.join(', ')}`)
    }

    return errors
  }

  errors.push(`${prefix}.type must be one of: text, image_url`)
  return errors
}

function validateAssistantToolCalls(toolCalls, prefix) {
  const errors = []

  if (!Array.isArray(toolCalls)) {
    errors.push(`${prefix}.tool_calls must be an array when provided`)
    return errors
  }

  for (let i = 0; i < toolCalls.length; i += 1) {
    const toolPrefix = `${prefix}.tool_calls[${i}]`
    const toolCall = toolCalls[i]

    if (!isObject(toolCall)) {
      errors.push(`${toolPrefix} must be an object`)
      continue
    }

    if (!isNonEmptyString(toolCall.id)) {
      errors.push(`${toolPrefix}.id must be a non-empty string`)
    }

    if (toolCall.type !== 'function') {
      errors.push(`${toolPrefix}.type must be "function"`)
    }

    if (!isObject(toolCall.function)) {
      errors.push(`${toolPrefix}.function must be an object`)
      continue
    }

    if (!isNonEmptyString(toolCall.function.name) || !TOOL_NAME_PATTERN.test(toolCall.function.name)) {
      errors.push(`${toolPrefix}.function.name must match ${TOOL_NAME_PATTERN}`)
    }

    if (
      toolCall.function.arguments !== undefined &&
      typeof toolCall.function.arguments !== 'string'
    ) {
      errors.push(`${toolPrefix}.function.arguments must be a string when provided`)
    }
  }

  return errors
}

export function validateMessage(message, index) {
  const prefix = `messages[${index}]`
  const errors = []

  if (!isObject(message)) {
    return [`${prefix} must be an object`]
  }

  if (!VALID_ROLES_LIST.includes(message.role)) {
    errors.push(`${prefix}.role must be one of: ${VALID_ROLES_LIST.join(', ')}`)
  }

  const assistantToolCallsOnly = message.role === 'assistant' && message.tool_calls !== undefined

  if (message.content === undefined || message.content === null) {
    if (!assistantToolCallsOnly) {
      errors.push(`${prefix}.content is required`)
    }
  } else if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
    errors.push(`${prefix}.content must be a string or array`)
  } else if (Array.isArray(message.content)) {
    for (let j = 0; j < message.content.length; j += 1) {
      errors.push(...validateContentPart(message.content[j], `${prefix}.content[${j}]`))
    }
  }

  if (message.role === 'tool') {
    if (!isNonEmptyString(message.tool_call_id)) {
      errors.push(`${prefix}.tool_call_id is required when role is "tool"`)
    }
  } else if (message.tool_call_id !== undefined) {
    errors.push(`${prefix}.tool_call_id is only allowed when role is "tool"`)
  }

  if (message.role === 'assistant') {
    if (message.tool_calls !== undefined) {
      errors.push(...validateAssistantToolCalls(message.tool_calls, prefix))
    }
  } else if (message.tool_calls !== undefined) {
    errors.push(`${prefix}.tool_calls are only allowed when role is "assistant"`)
  }

  return errors
}

export function validateTools(tools) {
  const errors = []

  if (tools === undefined) return errors

  if (!Array.isArray(tools)) {
    errors.push('tools must be an array when provided')
    return errors
  }

  for (let i = 0; i < tools.length; i += 1) {
    const prefix = `tools[${i}]`
    const tool = tools[i]

    if (!isObject(tool)) {
      errors.push(`${prefix} must be an object`)
      continue
    }

    if (tool.type !== 'function') {
      errors.push(`${prefix}.type must be "function"`)
    }

    if (!isObject(tool.function)) {
      errors.push(`${prefix}.function must be an object`)
      continue
    }

    if (!isNonEmptyString(tool.function.name) || !TOOL_NAME_PATTERN.test(tool.function.name)) {
      errors.push(`${prefix}.function.name must match ${TOOL_NAME_PATTERN}`)
    }

    if (tool.function.description !== undefined && typeof tool.function.description !== 'string') {
      errors.push(`${prefix}.function.description must be a string when provided`)
    }

    if (tool.function.parameters !== undefined && !isObject(tool.function.parameters)) {
      errors.push(`${prefix}.function.parameters must be an object when provided`)
    }
  }

  return errors
}

export function validateToolChoice(toolChoice) {
  const errors = []

  if (toolChoice === undefined) return errors

  if (typeof toolChoice === 'string') {
    if (!VALID_TOOL_CHOICES.includes(toolChoice)) {
      errors.push(`tool_choice must be one of: ${VALID_TOOL_CHOICES.join(', ')}`)
    }
    return errors
  }

  if (!isObject(toolChoice)) {
    errors.push('tool_choice must be a string or object')
    return errors
  }

  if (toolChoice.type !== 'function') {
    errors.push('tool_choice.type must be "function" when tool_choice is an object')
  }

  if (!isObject(toolChoice.function)) {
    errors.push('tool_choice.function must be an object when tool_choice is an object')
    return errors
  }

  if (
    !isNonEmptyString(toolChoice.function.name) ||
    !TOOL_NAME_PATTERN.test(toolChoice.function.name)
  ) {
    errors.push(`tool_choice.function.name must match ${TOOL_NAME_PATTERN}`)
  }

  return errors
}

function ensureNamedToolExists(toolChoice, tools) {
  if (!isObject(toolChoice) || toolChoice.type !== 'function') {
    return null
  }

  if (!Array.isArray(tools)) {
    return 'tool_choice references a function but no tools were provided'
  }

  const match = tools.some(tool => isObject(tool.function) && tool.function.name === toolChoice.function.name)
  if (!match) {
    return `tool_choice.function.name "${toolChoice.function.name}" was not found in tools`
  }

  return null
}

function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return undefined
  return tools.map(sanitizeToolDefinition)
}

export function validateChatRequest(json) {
  const errors = []

  if (!isObject(json)) {
    throw new RequestError(400, 'Invalid request: request body must be a JSON object')
  }

  if (json.model !== undefined) {
    if (typeof json.model !== 'string' || !MODEL_NAME_PATTERN.test(json.model)) {
      errors.push('model must be an alphanumeric string (max 64 chars, e.g. "composer-1")')
    }
  }

  if (!Array.isArray(json.messages)) {
    errors.push('messages must be an array')
  } else if (json.messages.length === 0) {
    errors.push('messages must not be empty')
  } else {
    for (let i = 0; i < json.messages.length; i += 1) {
      errors.push(...validateMessage(json.messages[i], i))
    }
  }

  if (json.stream !== undefined && typeof json.stream !== 'boolean') {
    errors.push('stream must be a boolean')
  }

  errors.push(...validateTools(json.tools))
  errors.push(...validateToolChoice(json.tool_choice))

  const namedToolError = ensureNamedToolExists(json.tool_choice, json.tools)
  if (namedToolError) {
    errors.push(namedToolError)
  }

  if (json.tool_choice === 'required' && (!Array.isArray(json.tools) || json.tools.length === 0)) {
    errors.push('tool_choice "required" requires at least one tool')
  }

  if (errors.length > 0) {
    throw new RequestError(400, `Invalid request: ${errors.join('; ')}`)
  }

  return {
    model: typeof json.model === 'string' ? json.model : 'composer-1',
    messages: json.messages.map(sanitizeMessage),
    stream: json.stream === true,
    tools: sanitizeTools(json.tools),
    toolChoice: sanitizeToolChoice(json.tool_choice),
  }
}
