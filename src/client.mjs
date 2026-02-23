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
import { InteractionEventStreamParser } from './interaction-events.mjs'
import { bridgeNativeToolCallToXml } from './native-tool-bridge.mjs'
import { buildToolSystemPrompt, buildToolResultContext } from './tools.mjs'
import { extractImageParts, buildImageContexts } from './image.mjs'
import { withRetry, parseRetryAfterHeader } from './retry.mjs'
import { CONTEXT_FILE_PATH, persistContextFile } from './context-file.mjs'

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

function getPromptText(messages) {
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()
  if (lastUserMsg) {
    return extractContentText(lastUserMsg.content)
  }

  const lastMessage = messages[messages.length - 1]
  return extractContentText(lastMessage?.content)
}

function normalizeStreamChatOptions(optionsOrOnData, onEnd, onError) {
  if (typeof optionsOrOnData === 'function') {
    return {
      tools: undefined,
      toolChoice: 'auto',
      onData: optionsOrOnData,
      onEnd,
      onError,
    }
  }

  const options = optionsOrOnData || {}
  return {
    tools: options.tools,
    toolChoice: options.toolChoice ?? options.tool_choice ?? 'auto',
    onData: options.onData,
    onEnd: options.onEnd,
    onError: options.onError,
  }
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
 * @param {object} options - optional tool-call request options
 * @returns {{ frame: Buffer, prompt: string }}
 */
function buildChatPayload(model, messages, options = {}) {
  const { tools, toolChoice = 'auto' } = options
  const prompt = getPromptText(messages)
  const baseContext = messages.map(m => `${m.role}: ${extractContentText(m.content)}`).join('\n')
  const imageParts = messages.flatMap(message => extractImageParts(message.content))
  const imageContexts = buildImageContexts(imageParts)

  const toolContext = buildToolResultContext(messages)
  const toolPrompt = buildToolSystemPrompt(tools, toolChoice)

  const contextParts = [baseContext]
  if (toolContext.length > 0) {
    contextParts.push(`Tool history:\n${toolContext}`)
  }
  if (toolPrompt.length > 0) {
    contextParts.push(toolPrompt)
  }

  const context = contextParts.join('\n\n')
  persistContextFile(context)

  const { payload } = buildProtobufRequest(prompt, model, context, imageContexts, CONTEXT_FILE_PATH)
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
 * @returns {{ settle: Function, settleWithError: Function, setTimers: Function, emitData: Function }}
 */
function createStreamSettler({ onData, onEnd, onError, client }) {
  let settled = false
  let idleCheckRef = null
  let hardTimerRef = null

  const emitData = (text) => {
    if (settled || !text) return
    onData(text)
  }

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

  return { settle, settleWithError, setTimers, emitData }
}

/**
 * Wire up HTTP/2 stream events: response status check, data accumulation
 * with size limit, idle detection, hard timeout, and end/error handling.
 */
function wireStreamEvents(h2Stream, { settle, settleWithError, setTimers, emitData }, prompt, tools) {
  const chunks = []
  const eventParser = new InteractionEventStreamParser()
  const partialArgsByCallId = new Map()
  let totalResponseSize = 0
  let lastDataTime = Date.now()
  let receivedAnyData = false
  let emittedInteractionText = false
  let emittedNativeToolCall = false
  let sawTurnEnded = false

  const getResponseData = () => Buffer.concat(chunks)
  const getResponseText = () => extractTextFromResponse(getResponseData(), prompt)

  const emitInteractionEvents = (chunk) => {
    const events = eventParser.push(chunk)
    let shouldShortCircuit = false

    for (const event of events) {
      if (event.type === 'text_delta' && event.text.length > 0) {
        emittedInteractionText = true
        emitData(event.text)
        continue
      }

      if (event.type === 'partial_tool_call' && typeof event.callId === 'string') {
        const previous = partialArgsByCallId.get(event.callId) ?? ''
        partialArgsByCallId.set(event.callId, `${previous}${event.argsTextDelta || ''}`)
        continue
      }

      if (event.type === 'tool_call_started' || event.type === 'tool_call_completed') {
        const argsTextDelta = typeof event.callId === 'string'
          ? (partialArgsByCallId.get(event.callId) ?? '')
          : ''

        const bridgedToolCall = bridgeNativeToolCallToXml(event, tools, argsTextDelta)
        if (bridgedToolCall) {
          emittedNativeToolCall = true
          emitData(bridgedToolCall)
          shouldShortCircuit = true
        }
        continue
      }

      if (event.type === 'interaction_query') {
        const syntheticCallId = typeof event.callId === 'string' && event.callId.length > 0
          ? event.callId
          : `interaction_query_${event.queryId ?? 'unknown'}`

        const bridgedQueryCall = bridgeNativeToolCallToXml(
          { ...event, callId: syntheticCallId },
          tools,
        )

        if (bridgedQueryCall) {
          emittedNativeToolCall = true
          emitData(bridgedQueryCall)
          shouldShortCircuit = true
        }
        continue
      }

      if (event.type === 'turn_ended') {
        sawTurnEnded = true
      }
    }

    return shouldShortCircuit
  }

  const settleFromBufferedState = () => {
    if (emittedNativeToolCall || emittedInteractionText || sawTurnEnded) {
      settle('')
      return
    }

    const text = chunks.length > 0 ? getResponseText() : ''
    settle(text)
  }

  h2Stream.on('response', (headers) => {
    const status = headers[':status']
    if (status !== 200) {
      settleWithError(new Error(`Cursor API returned HTTP ${status}`))
    }
  })

  h2Stream.on('data', (chunk) => {
    receivedAnyData = true
    lastDataTime = Date.now()
    totalResponseSize += chunk.length
    if (totalResponseSize > MAX_RESPONSE_SIZE_BYTES) {
      h2Stream.destroy()
      settleWithError(new Error('Upstream response exceeded maximum size'))
      return
    }

    chunks.push(chunk)
    const shouldShortCircuit = emitInteractionEvents(chunk)
    if (shouldShortCircuit) {
      settle('')
    }
  })

  h2Stream.on('end', () => {
    settleFromBufferedState()
  })

  h2Stream.on('error', (err) => {
    settleWithError(err)
  })

  // Idle detection — response is considered complete after no data for IDLE_TIMEOUT_MS
  const idleCheck = setInterval(() => {
    if (Date.now() - lastDataTime > IDLE_TIMEOUT_MS && receivedAnyData) {
      settleFromBufferedState()
    }
  }, IDLE_CHECK_INTERVAL_MS)

  // Hard timeout — guarantee the request eventually completes
  const hardTimer = setTimeout(() => {
    settleFromBufferedState()
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
export function streamChat(model, messages, optionsOrOnData, onEnd, onError) {
  const {
    tools,
    toolChoice,
    onData,
    onEnd: onStreamEnd,
    onError: onStreamError,
  } = normalizeStreamChatOptions(optionsOrOnData, onEnd, onError)

  if (typeof onData !== 'function' || typeof onStreamEnd !== 'function' || typeof onStreamError !== 'function') {
    throw new Error('streamChat requires onData, onEnd, and onError callbacks')
  }

  let token
  try {
    assertAllowedHost(AGENT_BASE)
    token = getToken()
  } catch (err) {
    onStreamError(err)
    return
  }

  const { frame, prompt } = buildChatPayload(model, messages, { tools, toolChoice })
  const client = http2.connect(`https://${AGENT_BASE}`)

  const settler = createStreamSettler({
    onData,
    onEnd: onStreamEnd,
    onError: onStreamError,
    client,
  })

  client.on('error', (err) => {
    process.stderr.write(`  HTTP/2 client error: ${err.message}\n`)
    settler.settleWithError(err)
  })

  const h2Stream = client.request({
    ':method': 'POST',
    ':path': '/agent.v1.AgentService/Run',
    ...buildHeaders(token),
  })

  wireStreamEvents(h2Stream, settler, prompt, tools)

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
  getResponseStatus = () => 200,
  getRetryAfterMs = () => null,
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

    const statusCode = getResponseStatus()
    if (statusCode >= 400) {
      const error = new Error(`Cursor API returned HTTP ${statusCode}`)
      error.statusCode = statusCode

      const retryAfterMs = getRetryAfterMs()
      if (Number.isFinite(retryAfterMs)) {
        error.retryAfterMs = retryAfterMs
      }

      reject(error)
      return
    }

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

  return withRetry(() => new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`)
    let settled = false
    let responseStatus = 200
    let retryAfterMs = null
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

    req.on('response', (headers) => {
      responseStatus = Number(headers[':status'] || 200)
      const retryAfterHeader = headers['retry-after']
      const retryAfterValue = Array.isArray(retryAfterHeader)
        ? retryAfterHeader[0]
        : retryAfterHeader
      retryAfterMs = parseRetryAfterHeader(
        typeof retryAfterValue === 'number' ? String(retryAfterValue) : retryAfterValue
      )
    })

    attachConnectRequestHandlers(req, {
      cleanup,
      resolve,
      reject,
      isSettled,
      maxResponseSize: MAX_RESPONSE_SIZE_BYTES,
      getResponseStatus: () => responseStatus,
      getRetryAfterMs: () => retryAfterMs,
    })

    req.write(postData)
    req.end()
  }))
}

export const __testables = Object.freeze({
  MAX_RESPONSE_SIZE_BYTES,
  normalizeStreamChatOptions,
  buildChatPayload,
  createStreamSettler,
  wireStreamEvents,
  attachConnectRequestHandlers,
})
