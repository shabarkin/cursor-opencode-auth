import assert from 'node:assert/strict'
import test from 'node:test'
import { ProtoWriter, createFrame } from '../src/proto.mjs'
import {
  InteractionEventStreamParser,
  parseInteractionEventsFromResponse,
  extractTextFromInteractionEvents,
} from '../src/interaction-events.mjs'

function createInteractionFrame(interactionFieldNumber, interactionMessageWriter) {
  const interactionUpdate = new ProtoWriter()
  interactionUpdate.writeMessage(interactionFieldNumber, interactionMessageWriter)

  const serverMessage = new ProtoWriter()
  serverMessage.writeMessage(1, interactionUpdate)

  return createFrame(serverMessage.toBuffer())
}

function textDeltaFrame(text) {
  const textDelta = new ProtoWriter()
  textDelta.writeString(1, text)
  return createInteractionFrame(1, textDelta)
}

function turnEndedFrame() {
  return createInteractionFrame(14, new ProtoWriter())
}

function interactionQueryWebFetchFrame({ queryId, url }) {
  const webFetchArgs = new ProtoWriter()
  webFetchArgs.writeString(1, url)

  const webFetchRequestQuery = new ProtoWriter()
  webFetchRequestQuery.writeMessage(1, webFetchArgs)

  const interactionQuery = new ProtoWriter()
  interactionQuery.writeInt32(1, queryId)
  interactionQuery.writeMessage(9, webFetchRequestQuery)

  const serverMessage = new ProtoWriter()
  serverMessage.writeMessage(7, interactionQuery)

  return createFrame(serverMessage.toBuffer())
}

function shellToolCallPayload(command, workdir = '', timeout = 120000) {
  const shellArgs = new ProtoWriter()
  shellArgs.writeString(1, command)
  shellArgs.writeString(2, workdir)
  shellArgs.writeInt32(3, timeout)

  const shellToolCall = new ProtoWriter()
  shellToolCall.writeMessage(1, shellArgs)

  const toolCall = new ProtoWriter()
  toolCall.writeMessage(1, shellToolCall)
  return toolCall
}

function readToolCallPayload(path) {
  const readArgs = new ProtoWriter()
  readArgs.writeString(1, path)

  const readToolCall = new ProtoWriter()
  readToolCall.writeMessage(1, readArgs)

  const toolCall = new ProtoWriter()
  toolCall.writeMessage(8, readToolCall)
  return toolCall
}

function startedToolCallFrame({ callId, modelCallId, toolCallWriter }) {
  const toolCall = toolCallWriter

  const started = new ProtoWriter()
  started.writeString(1, callId)
  started.writeMessage(2, toolCall)
  started.writeString(3, modelCallId)

  return createInteractionFrame(2, started)
}

function partialToolCallFrame({ callId, modelCallId, toolCallWriter, argsTextDelta }) {
  const toolCall = toolCallWriter

  const partial = new ProtoWriter()
  partial.writeString(1, callId)
  partial.writeMessage(2, toolCall)
  partial.writeString(3, argsTextDelta)
  partial.writeString(4, modelCallId)

  return createInteractionFrame(7, partial)
}

test('parseInteractionEventsFromResponse extracts text deltas and turn end', () => {
  const data = Buffer.concat([
    textDeltaFrame('Hello '),
    textDeltaFrame('world.'),
    turnEndedFrame(),
  ])

  const events = parseInteractionEventsFromResponse(data)
  assert.equal(events[0].type, 'text_delta')
  assert.equal(events[1].type, 'text_delta')
  assert.equal(events[2].type, 'turn_ended')
  assert.equal(extractTextFromInteractionEvents(events), 'Hello world.')
})

test('InteractionEventStreamParser buffers split frame boundaries', () => {
  const parser = new InteractionEventStreamParser()
  const frame = textDeltaFrame('chunked')

  const firstEvents = parser.push(frame.subarray(0, 4))
  const secondEvents = parser.push(frame.subarray(4))

  assert.equal(firstEvents.length, 0)
  assert.equal(secondEvents.length, 1)
  assert.equal(secondEvents[0].type, 'text_delta')
  assert.equal(secondEvents[0].text, 'chunked')
})

test('parseInteractionEventsFromResponse decodes tool lifecycle metadata', () => {
  const callId = 'tool_abc123'
  const modelCallId = 'model_xyz789'

  const started = startedToolCallFrame({
    callId,
    modelCallId,
    toolCallWriter: shellToolCallPayload('which ast-grep', '/tmp', 300000),
  })
  const partial = partialToolCallFrame({
    callId,
    modelCallId,
    toolCallWriter: readToolCallPayload('README.md'),
    argsTextDelta: '{"path":"README.md"}',
  })

  const events = parseInteractionEventsFromResponse(Buffer.concat([started, partial]))
  assert.equal(events[0].type, 'tool_call_started')
  assert.equal(events[0].toolName, 'shell')
  assert.equal(events[0].callId, callId)
  assert.equal(events[0].modelCallId, modelCallId)
  assert.equal(events[0].toolArguments.command, 'which ast-grep')
  assert.equal(events[0].toolArguments.workdir, '/tmp')
  assert.equal(events[0].toolArguments.timeout, 300000)

  assert.equal(events[1].type, 'partial_tool_call')
  assert.equal(events[1].toolName, 'read')
  assert.equal(events[1].toolArguments.filePath, 'README.md')
  assert.equal(events[1].argsTextDelta, '{"path":"README.md"}')
})

test('parseInteractionEventsFromResponse decodes interaction query events', () => {
  const data = interactionQueryWebFetchFrame({
    queryId: 42,
    url: 'https://example.com',
  })

  const events = parseInteractionEventsFromResponse(data)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'interaction_query')
  assert.equal(events[0].queryId, 42)
  assert.equal(events[0].toolName, 'web_fetch')
  assert.equal(events[0].toolArguments.url, 'https://example.com')
  assert.equal(events[0].toolArguments.format, 'markdown')
})
