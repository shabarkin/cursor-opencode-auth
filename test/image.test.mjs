import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractImageParts,
  parseDataUrl,
  buildImageContexts,
  fetchImageUrl,
} from '../src/image.mjs'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

test('extractImageParts selects image_url parts from content arrays', () => {
  const parts = extractImageParts([
    { type: 'text', text: 'hello' },
    { type: 'image_url', image_url: { url: PNG_DATA_URL } },
  ])

  assert.equal(parts.length, 1)
  assert.equal(parts[0].type, 'image_url')
})

test('parseDataUrl parses mime and binary data', () => {
  const parsed = parseDataUrl(PNG_DATA_URL)
  assert.equal(parsed.mimeType, 'image/png')
  assert.equal(Buffer.isBuffer(parsed.data), true)
  assert.equal(parsed.data.length > 0, true)
})

test('buildImageContexts maps images into explicit context entries', () => {
  const contexts = buildImageContexts([
    { type: 'image_url', image_url: { url: PNG_DATA_URL } },
  ])

  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].path, '/image-1.png')
  assert.equal(Buffer.isBuffer(contexts[0].bytes), true)
})

test('fetchImageUrl throws because only data URLs are supported in v1', () => {
  assert.throws(
    () => fetchImageUrl('https://example.com/image.png'),
    /Remote image URLs are not supported/
  )
})
