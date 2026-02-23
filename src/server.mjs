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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_REQUEST_TIMEOUT_MS = 120_000
const SERVER_HEADERS_TIMEOUT_MS = 30_000
const MODEL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const VALID_ROLES = Object.freeze(['system', 'user', 'assistant', 'tool'])

// ---------------------------------------------------------------------------
// Custom error class for HTTP error responses
// ---------------------------------------------------------------------------

class RequestError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.statusCode = statusCode
  }
}

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
// Input validation + message sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a single content part (from OpenAI multi-modal format).
 * Extracts only `type` and `text` — strips any extra properties.
 */
function sanitizeContentPart(part) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return { type: '', text: '' }
  }

  return {
    type: typeof part.type === 'string' ? part.type : '',
    text: typeof part.text === 'string' ? part.text : '',
  }
}

/**
 * Sanitize message content — returns only expected fields,
 * preventing prototype pollution or unexpected property passthrough.
 */
function sanitizeContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(sanitizeContentPart)
  return String(content)
}

function validateChatRequest(json) {
  const errors = []

  if (json.model !== undefined) {
    if (typeof json.model !== 'string' || !MODEL_NAME_RE.test(json.model)) {
      errors.push('model must be an alphanumeric string (max 64 chars, e.g. "composer-1")')
    }
  }

  if (!Array.isArray(json.messages)) {
    errors.push('messages must be an array')
  } else if (json.messages.length === 0) {
    errors.push('messages must not be empty')
  } else {
    for (let i = 0; i < json.messages.length; i++) {
      const msg = json.messages[i]
      if (!msg || typeof msg !== 'object') {
        errors.push(`messages[${i}] must be an object`)
        continue
      }
      if (!VALID_ROLES.includes(msg.role)) {
        errors.push(`messages[${i}].role must be one of: ${VALID_ROLES.join(', ')}`)
      }
      if (msg.content === undefined || msg.content === null) {
        errors.push(`messages[${i}].content is required`)
      } else if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
        errors.push(`messages[${i}].content must be a string or array`)
      } else if (Array.isArray(msg.content)) {
        for (let j = 0; j < msg.content.length; j++) {
          const part = msg.content[j]
          if (!part || typeof part !== 'object' || Array.isArray(part)) {
            errors.push(`messages[${i}].content[${j}] must be an object`)
            continue
          }

          if (typeof part.type !== 'string' || part.type.length === 0) {
            errors.push(`messages[${i}].content[${j}].type must be a non-empty string`)
          }

          if (part.type === 'text' && typeof part.text !== 'string') {
            errors.push(`messages[${i}].content[${j}].text must be a string when type is "text"`)
          } else if (part.text !== undefined && typeof part.text !== 'string') {
            errors.push(`messages[${i}].content[${j}].text must be a string when provided`)
          }
        }
      }
    }
  }

  if (json.stream !== undefined && typeof json.stream !== 'boolean') {
    errors.push('stream must be a boolean')
  }

  if (errors.length > 0) {
    throw new RequestError(400, `Invalid request: ${errors.join('; ')}`)
  }

  // Return sanitized object — only expected fields, no raw passthrough
  return {
    model: typeof json.model === 'string' ? json.model : 'composer-1',
    messages: json.messages.map(msg => ({
      role: msg.role,
      content: sanitizeContent(msg.content),
    })),
    stream: json.stream === true,
  }
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

function handleChatStream(res, model, messages) {
  const responseId = `chatcmpl-${randomUUID()}`

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  streamChat(
    model,
    messages,
    (text) => {
      if (text) {
        const eventData = {
          id: responseId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { content: text },
            finish_reason: null,
          }],
        }
        res.write(`data: ${JSON.stringify(eventData)}\n\n`)
      }
    },
    () => {
      const doneData = {
        id: responseId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      res.write(`data: ${JSON.stringify(doneData)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    },
    (err) => {
      process.stderr.write(`Stream error: ${err.message}\n`)
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
      res.end()
    }
  )
}

async function handleChatNonStream(res, model, messages) {
  let fullResponse = ''

  await new Promise((resolve, reject) => {
    streamChat(
      model,
      messages,
      (text) => { fullResponse += text },
      resolve,
      reject
    )
  })

  jsonResponse(res, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: fullResponse || 'No response received' },
      finish_reason: 'stop',
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

      const { model, messages, stream } = validateChatRequest(json)

      process.stdout.write(`  Model: ${sanitizeLogString(model)}, Messages: ${messages.length}, Stream: ${stream}\n`)

      if (stream) {
        return handleChatStream(res, model, messages)
      }

      return await handleChatNonStream(res, model, messages)
    }

    throw new RequestError(404, `Unknown endpoint: ${safePath}`)
  } catch (error) {
    const statusCode = error.statusCode || 500
    const message = error.statusCode ? error.message : 'Internal server error'

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
  Token:      Loaded from macOS Keychain (cached 5 min)
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
