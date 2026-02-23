/**
 * HTTP/2 client for Cursor's Connect-RPC API.
 *
 * Provides two communication modes:
 *   - streamChat()     — protobuf streaming for chat completions
 *   - connectRequest() — JSON Connect-RPC for metadata endpoints (e.g. model list)
 *
 * Security:
 *   - Upstream host validated against allowlist before sending credentials
 *   - Response size capped at MAX_RESPONSE_SIZE_BYTES (10 MB)
 *   - Hard timeout on all upstream requests
 *   - Chunks collected in array (O(n) instead of O(n^2) Buffer.concat per chunk)
 */

import http2 from 'http2'
import { randomUUID } from 'crypto'
import { getToken } from './token.mjs'
import {
  AGENT_BASE,
  CLIENT_VERSION,
  HARD_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  IDLE_CHECK_INTERVAL_MS,
  isAllowedUpstreamHost,
} from './config.mjs'
import { buildProtobufRequest, createFrame } from './proto.mjs'
import { extractTextFromResponse } from './response-parser.mjs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RESPONSE_SIZE_BYTES = 10_485_760 // 10 MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from OpenAI-style content (string or array of parts).
 */
function extractContentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(p => p.type === 'text')
      .map(p => p.text)
      .join('\n')
  }
  return String(content || '')
}

/**
 * Build standard Cursor API headers.
 */
function buildHeaders(token, contentType = 'application/connect+proto') {
  return {
    'authorization': `Bearer ${token}`,
    'content-type': contentType,
    'connect-protocol-version': '1',
    'x-cursor-client-type': 'cli',
    'x-cursor-client-version': CLIENT_VERSION,
    'x-ghost-mode': 'false',
    'x-request-id': randomUUID(),
  }
}

/**
 * Validate that the target host is in the allowlist before sending credentials.
 */
function assertAllowedHost(host) {
  if (!isAllowedUpstreamHost(host)) {
    throw new Error(`Upstream host not in allowlist: ${host}`)
  }
}

// ---------------------------------------------------------------------------
// Streaming protobuf chat — helpers
// ---------------------------------------------------------------------------

/**
 * Build the protobuf frame for a chat request from OpenAI-format messages.
 *
 * @param {string} model    - model identifier
 * @param {Array}  messages - OpenAI-format message array
 * @returns {{ frame: Buffer, prompt: string }}
 */
function buildChatPayload(model, messages) {
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()
  const prompt = extractContentText(lastUserMsg?.content)
  const context = messages.map(m => `${m.role}: ${extractContentText(m.content)}`).join('\n')

  const { payload } = buildProtobufRequest(prompt, model, context)
  return { frame: createFrame(payload), prompt }
}

/**
 * Create settle/settleWithError closures that ensure single-fire semantics,
 * timer cleanup, and client teardown.
 *
 * @param {Object} opts
 * @param {Function} opts.onData   - called with extracted text on success
 * @param {Function} opts.onEnd    - called when stream completes
 * @param {Function} opts.onError  - called on any error
 * @param {Object}   opts.client   - HTTP/2 client session
 * @returns {{ settle: Function, settleWithError: Function, setTimers: Function }}
 */
function createStreamSettler({ onData, onEnd, onError, client }) {
  let settled = false
  let idleCheckRef = null
  let hardTimerRef = null

  const settle = (text) => {
    if (settled) return
    settled = true
    clearInterval(idleCheckRef)
    clearTimeout(hardTimerRef)
    if (text) onData(text)
    onEnd()
    client.close()
  }

  const settleWithError = (err) => {
    if (settled) return
    settled = true
    clearInterval(idleCheckRef)
    clearTimeout(hardTimerRef)
    onError(err)
    client.close()
  }

  const setTimers = (idleCheck, hardTimer) => {
    idleCheckRef = idleCheck
    hardTimerRef = hardTimer
  }

  return { settle, settleWithError, setTimers }
}

/**
 * Wire up HTTP/2 stream events: response status check, data accumulation
 * with size limit, idle detection, hard timeout, and end/error handling.
 */
function wireStreamEvents(h2Stream, { settle, settleWithError, setTimers }, prompt) {
  const chunks = []
  let totalResponseSize = 0
  let lastDataTime = Date.now()

  const getResponseData = () => Buffer.concat(chunks)

  h2Stream.on('response', (headers) => {
    const status = headers[':status']
    if (status !== 200) {
      settleWithError(new Error(`Cursor API returned HTTP ${status}`))
    }
  })

  h2Stream.on('data', (chunk) => {
    lastDataTime = Date.now()
    totalResponseSize += chunk.length
    if (totalResponseSize > MAX_RESPONSE_SIZE_BYTES) {
      h2Stream.destroy()
      settleWithError(new Error('Upstream response exceeded maximum size'))
      return
    }
    chunks.push(chunk)
  })

  h2Stream.on('end', () => {
    const text = extractTextFromResponse(getResponseData(), prompt)
    settle(text)
  })

  h2Stream.on('error', (err) => {
    settleWithError(err)
  })

  // Idle detection — response is considered complete after no data for IDLE_TIMEOUT_MS
  const idleCheck = setInterval(() => {
    if (Date.now() - lastDataTime > IDLE_TIMEOUT_MS && chunks.length > 0) {
      const text = extractTextFromResponse(getResponseData(), prompt)
      settle(text)
    }
  }, IDLE_CHECK_INTERVAL_MS)

  // Hard timeout — guarantee the request eventually completes
  const hardTimer = setTimeout(() => {
    const text = chunks.length > 0
      ? extractTextFromResponse(getResponseData(), prompt)
      : ''
    settle(text)
  }, HARD_TIMEOUT_MS)

  setTimers(idleCheck, hardTimer)
}

// ---------------------------------------------------------------------------
// Streaming protobuf chat — public API
// ---------------------------------------------------------------------------

/**
 * Stream a chat request to Cursor's AgentService/Run endpoint via HTTP/2.
 *
 * @param {string}   model    - model identifier
 * @param {Array}    messages - OpenAI-format message array
 * @param {Function} onData   - called with extracted text chunks
 * @param {Function} onEnd    - called when the stream completes
 * @param {Function} onError  - called on any error
 */
export function streamChat(model, messages, onData, onEnd, onError) {
  let token
  try {
    assertAllowedHost(AGENT_BASE)
    token = getToken()
  } catch (err) {
    onError(err)
    return
  }

  const { frame, prompt } = buildChatPayload(model, messages)
  const client = http2.connect(`https://${AGENT_BASE}`)

  const settler = createStreamSettler({ onData, onEnd, onError, client })

  client.on('error', (err) => {
    process.stderr.write(`  HTTP/2 client error: ${err.message}\n`)
    settler.settleWithError(err)
  })

  const h2Stream = client.request({
    ':method': 'POST',
    ':path': '/agent.v1.AgentService/Run',
    ...buildHeaders(token),
  })

  wireStreamEvents(h2Stream, settler, prompt)

  h2Stream.write(frame)
  h2Stream.end()
}

// ---------------------------------------------------------------------------
// JSON Connect-RPC request (for metadata endpoints)
// ---------------------------------------------------------------------------

/**
 * Attach response handlers for a Connect-RPC request with bounded buffering
 * and single-settle guard checks.
 */
function attachConnectRequestHandlers(req, {
  cleanup,
  resolve,
  reject,
  isSettled,
  maxResponseSize,
}) {
  const responseChunks = []
  let responseSize = 0

  req.on('data', (chunk) => {
    if (isSettled()) return
    responseSize += chunk.length
    if (responseSize > maxResponseSize) {
      req.destroy()
      cleanup()
      reject(new Error(`Response exceeded maximum size of ${maxResponseSize} bytes`))
      return
    }
    responseChunks.push(chunk)
  })

  req.on('end', () => {
    if (isSettled()) return
    cleanup()
    try {
      const data = Buffer.concat(responseChunks).toString('utf8')
      resolve(JSON.parse(data))
    } catch {
      reject(new Error('Failed to parse Cursor API response'))
    }
  })

  req.on('error', (err) => {
    if (isSettled()) return
    cleanup()
    reject(err)
  })
}

/**
 * Make a Connect-RPC JSON request to a Cursor API endpoint.
 *
 * @param {string} host    - API hostname
 * @param {string} service - service name (e.g. 'agent.v1.AgentService')
 * @param {string} method  - method name (e.g. 'GetUsableModels')
 * @param {object} body    - request body
 * @returns {Promise<object>} parsed JSON response
 */
export async function connectRequest(host, service, method, body = {}) {
  assertAllowedHost(host)

  const token = getToken()
  const postData = JSON.stringify(body)

  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`)
    let settled = false
    const isSettled = () => settled

    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      client.close()
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Request to ${service}/${method} timed out after ${HARD_TIMEOUT_MS}ms`))
    }, HARD_TIMEOUT_MS)

    client.on('error', (err) => {
      if (isSettled()) return
      cleanup()
      reject(err)
    })

    const req = client.request({
      ':method': 'POST',
      ':path': `/${service}/${method}`,
      ...buildHeaders(token, 'application/json'),
      'accept': 'application/json',
    })

    attachConnectRequestHandlers(req, {
      cleanup,
      resolve,
      reject,
      isSettled,
      maxResponseSize: MAX_RESPONSE_SIZE_BYTES,
    })

    req.write(postData)
    req.end()
  })
}

export const __testables = Object.freeze({
  MAX_RESPONSE_SIZE_BYTES,
  createStreamSettler,
  wireStreamEvents,
  attachConnectRequestHandlers,
})
