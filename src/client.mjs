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
// Streaming protobuf chat
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
  try {
    assertAllowedHost(AGENT_BASE)
  } catch (err) {
    onError(err)
    return
  }

  const token = getToken()

  const lastUserMsg = messages.filter(m => m.role === 'user').pop()
  const prompt = extractContentText(lastUserMsg?.content)
  const context = messages.map(m => `${m.role}: ${extractContentText(m.content)}`).join('\n')

  const { payload } = buildProtobufRequest(prompt, model, context)
  const frame = createFrame(payload)

  const client = http2.connect(`https://${AGENT_BASE}`)

  const chunks = []
  let totalResponseSize = 0
  let lastDataTime = Date.now()
  let settled = false

  const getResponseData = () => Buffer.concat(chunks)

  const settle = (text) => {
    if (settled) return
    settled = true
    clearInterval(idleCheck)
    clearTimeout(hardTimer)
    if (text) onData(text)
    onEnd()
    client.close()
  }

  const settleWithError = (err) => {
    if (settled) return
    settled = true
    clearInterval(idleCheck)
    clearTimeout(hardTimer)
    onError(err)
    client.close()
  }

  client.on('error', (err) => {
    process.stderr.write(`  HTTP/2 client error: ${err.message}\n`)
    settleWithError(err)
  })

  const stream = client.request({
    ':method': 'POST',
    ':path': '/agent.v1.AgentService/Run',
    ...buildHeaders(token),
  })

  // Idle detection — response is considered complete after no data for IDLE_TIMEOUT_MS
  const idleCheck = setInterval(() => {
    if (Date.now() - lastDataTime > IDLE_TIMEOUT_MS && chunks.length > 0) {
      const text = extractTextFromResponse(getResponseData(), prompt)
      settle(text)
    }
  }, IDLE_CHECK_INTERVAL_MS)

  stream.on('response', (headers) => {
    const status = headers[':status']
    if (status !== 200) {
      settleWithError(new Error(`Cursor API returned HTTP ${status}`))
    }
  })

  stream.on('data', (chunk) => {
    lastDataTime = Date.now()
    totalResponseSize += chunk.length
    if (totalResponseSize > MAX_RESPONSE_SIZE_BYTES) {
      settleWithError(new Error('Upstream response exceeded maximum size'))
      return
    }
    chunks.push(chunk)
  })

  stream.on('end', () => {
    const text = extractTextFromResponse(getResponseData(), prompt)
    settle(text)
  })

  stream.on('error', (err) => {
    settleWithError(err)
  })

  stream.write(frame)
  stream.end()

  // Hard timeout — guarantee the request eventually completes
  const hardTimer = setTimeout(() => {
    const text = chunks.length > 0
      ? extractTextFromResponse(getResponseData(), prompt)
      : ''
    settle(text)
  }, HARD_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// JSON Connect-RPC request (for metadata endpoints)
// ---------------------------------------------------------------------------

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
      cleanup()
      reject(err)
    })

    const req = client.request({
      ':method': 'POST',
      ':path': `/${service}/${method}`,
      ...buildHeaders(token, 'application/json'),
      'accept': 'application/json',
    })

    let data = ''
    req.on('data', (chunk) => { data += chunk })

    req.on('end', () => {
      cleanup()
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('Failed to parse Cursor API response'))
      }
    })

    req.on('error', (err) => {
      cleanup()
      reject(err)
    })

    req.write(postData)
    req.end()
  })
}
