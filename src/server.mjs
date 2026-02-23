/**
 * HTTP server with routing, CORS enforcement, input validation,
 * and body size limits.
 *
 * Security hardening:
 *   - CORS restricted to localhost origins only
 *   - Request body capped at MAX_BODY_SIZE_BYTES (1 MB)
 *   - Input validation for chat completion requests
 *   - Model name strict format validation
 *   - Message content sanitization (only expected fields passed through)
 *   - Binds to 127.0.0.1 only (not exposed to LAN)
 *   - Malformed JSON returns 400 (not silently ignored)
 *   - Server request/headers timeouts
 *   - Log output sanitized
 */

import http from 'http'
import { randomUUID } from 'crypto'
import {
  AGENT_BASE,
  MAX_BODY_SIZE_BYTES,
  isAllowedOrigin,
} from './config.mjs'
import { streamChat, connectRequest } from './client.mjs'
import { RequestError, validateChatRequest } from './validation.mjs'
import { parseToolCalls, ToolCallStreamBuffer } from './tools.mjs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_REQUEST_TIMEOUT_MS = 120_000
const SERVER_HEADERS_TIMEOUT_MS = 30_000
const UNSUPPORTED_CHAT_PARAMS = Object.freeze(['temperature', 'max_tokens', 'top_p'])
const AUTH_ERROR_RE = /(cursor auth token|CURSOR_AUTH_TOKEN|keychain|secret-tool|get-storedcredential|credentialmanager)/i
const INTERNAL_PROGRESS_RE = /^(checking|exploring|inspecting|reviewing|looking)\b/i
const INTERNAL_PROGRESS_FALLBACK = 'I could not complete the request because the upstream model entered an internal tool workflow without a final user response.'

// ---------------------------------------------------------------------------
// CORS — restricted to localhost origins only
// ---------------------------------------------------------------------------

function setCorsHeaders(req, res) {
  res.setHeader('Vary', 'Origin')

  const origin = getRequestOrigin(req)

  if (origin !== null && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  }
}

function getRequestOrigin(req) {
  const { origin } = req.headers
  return typeof origin === 'string' ? origin : null
}

function assertAllowedOrigin(req) {
  const origin = getRequestOrigin(req)
  if (origin !== null && !isAllowedOrigin(origin)) {
    throw new RequestError(403, 'Origin not allowed')
  }
  return origin
}

function isJsonContentType(contentTypeHeader) {
  if (typeof contentTypeHeader !== 'string') return false
  return contentTypeHeader.toLowerCase().startsWith('application/json')
}

// ---------------------------------------------------------------------------
// Body reading with size limit
// ---------------------------------------------------------------------------

async function readBody(req) {
  const chunks = []
  let totalSize = 0

  for await (const chunk of req) {
    totalSize += chunk.length
    if (totalSize > MAX_BODY_SIZE_BYTES) {
      throw new RequestError(
        413,
        `Request body exceeds maximum size of ${MAX_BODY_SIZE_BYTES} bytes`
      )
    }
    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf8')
}

// ---------------------------------------------------------------------------
// JSON response helpers
// ---------------------------------------------------------------------------

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function errorResponse(res, statusCode, message) {
  jsonResponse(res, statusCode, {
    error: { message, type: 'proxy_error', code: statusCode },
  })
}

// ---------------------------------------------------------------------------
// Log sanitization
// ---------------------------------------------------------------------------

function sanitizeLogString(str) {
  return str.replace(/[^\x20-\x7e]/g, '')
}

function logUnsupportedParams(payload) {
  for (const parameter of UNSUPPORTED_CHAT_PARAMS) {
    if (payload[parameter] !== undefined) {
      process.stdout.write(`[WARN] Unsupported chat parameter ignored: ${sanitizeLogString(parameter)}\n`)
    }
  }
}

function isAuthTokenError(error) {
  return Boolean(error && typeof error.message === 'string' && AUTH_ERROR_RE.test(error.message))
}

function normalizeAssistantContent(text) {
  const content = typeof text === 'string'
    ? text.trim().replace(/\s{2,}/g, ' ')
    : ''

  if (!content) {
    return null
  }

  if (INTERNAL_PROGRESS_RE.test(content) && content.length <= 160) {
    return null
  }

  return content
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleModels(res) {
  const result = await connectRequest(
    AGENT_BASE,
    'agent.v1.AgentService',
    'GetUsableModels'
  )

  const models = (result.models || [])
    .filter(m => m && typeof m.modelId === 'string')
    .map(m => ({
      id: m.modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'cursor',
    }))

  jsonResponse(res, 200, { object: 'list', data: models })
}

function buildSseChunk(responseId, model, delta, finishReason = null) {
  return {
    id: responseId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  }
}

function getToolChoiceViolation(toolChoice, toolCallNames) {
  if (toolChoice === 'required' && toolCallNames.length === 0) {
    return 'tool_choice is set to "required" but model returned no tool calls'
  }

  if (toolChoice === 'none' && toolCallNames.length > 0) {
    return 'tool_choice is set to "none" but model returned tool calls'
  }

  if (
    toolChoice &&
    typeof toolChoice === 'object' &&
    toolChoice.type === 'function' &&
    toolChoice.function &&
    typeof toolChoice.function.name === 'string'
  ) {
    if (toolCallNames.length === 0) {
      return `tool_choice requires function "${toolChoice.function.name}" but model returned no tool calls`
    }

    const invalid = toolCallNames.find(name => name !== toolChoice.function.name)
    if (invalid) {
      return `tool_choice requires function "${toolChoice.function.name}" but model returned "${invalid}"`
    }
  }

  return null
}

function handleChatStream(res, model, messages, tools, toolChoice, streamChatFn = streamChat) {
  const responseId = `chatcmpl-${randomUUID()}`
  const toolCallNames = []
  let hasToolCalls = false
  let emittedContent = false

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  const writeChunk = (delta, finishReason = null) => {
    const eventData = buildSseChunk(responseId, model, delta, finishReason)
    res.write(`data: ${JSON.stringify(eventData)}\n\n`)
  }

  const streamBuffer = new ToolCallStreamBuffer({
    onContentDelta: (text) => {
      if (!text) return
      if (hasToolCalls) return
      if (toolChoice === 'required') return

      const normalized = normalizeAssistantContent(text)
      if (!normalized) return

      emittedContent = true
      writeChunk({ content: normalized })
    },
    onToolCallStart: (index, id, name) => {
      hasToolCalls = true
      toolCallNames.push(name)
      writeChunk({
        tool_calls: [{
          index,
          id,
          type: 'function',
          function: {
            name,
            arguments: '',
          },
        }],
      })
    },
    onToolCallArgumentsDelta: (index, argumentsDelta) => {
      writeChunk({
        tool_calls: [{
          index,
          function: {
            arguments: argumentsDelta,
          },
        }],
      })
    },
  })

  streamChatFn(
    model,
    messages,
    {
      tools,
      toolChoice,
      onData: (text) => {
        streamBuffer.push(text)
      },
      onEnd: () => {
        streamBuffer.flush()

        const violation = getToolChoiceViolation(toolChoice, toolCallNames)
        if (violation) {
          res.write(`data: ${JSON.stringify({
            error: {
              message: violation,
              type: 'proxy_error',
              code: 502,
            },
          })}\n\n`)
          res.end()
          return
        }

        if (!hasToolCalls && !emittedContent && toolChoice !== 'required') {
          emittedContent = true
          writeChunk({ content: INTERNAL_PROGRESS_FALLBACK })
        }

        writeChunk({}, hasToolCalls ? 'tool_calls' : 'stop')
        res.write('data: [DONE]\n\n')
        res.end()
      },
      onError: (err) => {
        process.stderr.write(`Stream error: ${err.message}\n`)
        const authFailure = isAuthTokenError(err)
        res.write(`data: ${JSON.stringify({
          error: {
            message: authFailure ? err.message : 'Internal proxy error',
            type: 'proxy_error',
            code: authFailure ? 401 : 500,
          },
        })}\n\n`)
        res.end()
      },
    },
  )
}

async function handleChatNonStream(res, model, messages, tools, toolChoice, streamChatFn = streamChat) {
  const chunks = []

  await new Promise((resolve, reject) => {
    streamChatFn(
      model,
      messages,
      {
        tools,
        toolChoice,
        onData: (text) => { chunks.push(text) },
        onEnd: resolve,
        onError: reject,
      },
    )
  })

  const fullResponse = chunks.join('')
  const parsed = parseToolCalls(fullResponse)
  const toolCallNames = parsed.toolCalls.map(call => call.function.name)
  const violation = getToolChoiceViolation(toolChoice, toolCallNames)

  if (parsed.pendingToolCall) {
    throw new RequestError(502, 'Upstream response ended with an incomplete tool_call block')
  }

  if (violation) {
    throw new RequestError(502, violation)
  }

  const message = parsed.toolCalls.length > 0
    ? {
      role: 'assistant',
      content: parsed.content.length > 0 ? parsed.content : null,
      tool_calls: parsed.toolCalls,
    }
    : {
      role: 'assistant',
      content: normalizeAssistantContent(parsed.content) || INTERNAL_PROGRESS_FALLBACK,
    }

  jsonResponse(res, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: parsed.toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

export async function handleRequest(req, res) {
  try {
    setCorsHeaders(req, res)
    const origin = assertAllowedOrigin(req)

    if (req.method === 'OPTIONS') {
      if (origin === null) throw new RequestError(403, 'Origin not allowed')
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname

    const safeMethod = sanitizeLogString(req.method)
    const safePath = sanitizeLogString(path)
    process.stdout.write(`[${new Date().toISOString()}] ${safeMethod} ${safePath}\n`)

    if (path === '/v1/models' && req.method === 'GET') {
      return await handleModels(res)
    }

    if (path === '/v1/chat/completions' && req.method === 'POST') {
      if (!isJsonContentType(req.headers['content-type'])) {
        throw new RequestError(415, 'Content-Type must be application/json')
      }

      const body = await readBody(req)

      let json = {}
      if (body) {
        try {
          json = JSON.parse(body)
        } catch {
          throw new RequestError(400, 'Malformed JSON in request body')
        }
      }

      logUnsupportedParams(json)

      const { model, messages, stream, tools, toolChoice } = validateChatRequest(json)

      const requestedTools = Array.isArray(tools) ? tools.length : 0
      process.stdout.write(
        `  Model: ${sanitizeLogString(model)}, Messages: ${messages.length}, ` +
        `Stream: ${stream}, Tools: ${requestedTools}, ToolChoice: ${sanitizeLogString(String(toolChoice))}\n`
      )

      if (stream) {
        return handleChatStream(res, model, messages, tools, toolChoice)
      }

      return await handleChatNonStream(res, model, messages, tools, toolChoice)
    }

    throw new RequestError(404, `Unknown endpoint: ${safePath}`)
  } catch (error) {
    const authFailure = isAuthTokenError(error)
    const statusCode = error.statusCode || (authFailure ? 401 : 500)
    const message = error.statusCode
      ? error.message
      : authFailure
        ? error.message
        : 'Internal server error'

    if (!error.statusCode) {
      process.stderr.write(`[ERROR] ${error.stack || error.message}\n`)
    }

    if (!res.headersSent) {
      errorResponse(res, statusCode, message)
    }
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function printBanner(port) {
  process.stdout.write(`
  Cursor API Proxy Server (Protobuf)
  -----------------------------------
  Listening:  http://127.0.0.1:${port}
  Endpoints:  /v1/models, /v1/chat/completions
  Token:      Loaded from platform store (cached 5 min)
  CORS:       Restricted to localhost origins
  Bound to:   127.0.0.1 only (not exposed to LAN)

  Configure OpenCode:
    "provider": {
      "cursor": {
        "api": "http://localhost:${port}/v1"
      }
    }
\n`)
}

export function createServer(port) {
  const server = http.createServer(handleRequest)

  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS

  server.listen(port, '127.0.0.1', () => {
    printBanner(port)
  })

  return server
}

export const __testables = Object.freeze({
  buildSseChunk,
  getToolChoiceViolation,
  handleChatStream,
  handleChatNonStream,
})
