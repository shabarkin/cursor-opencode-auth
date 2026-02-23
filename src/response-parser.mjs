/**
 * Extract assistant text from Cursor's protobuf streaming responses.
 *
 * Cursor returns Connect-RPC frames containing protobuf messages with many
 * embedded strings (system prompts, user echoes, metadata, IDs, and the
 * actual assistant response). This module scores candidate strings and
 * returns the most likely assistant output.
 */

import zlib from 'zlib'
import { readVarint, extractStringsFromProtobuf } from './proto.mjs'

// Patterns used to filter out metadata strings
const METADATA_MARKERS = Object.freeze([
  'You are a powerful',
  '"role"',
  'providerOptions',
  'serverGenReqId',
  'user_query',
  'composer-1',
  'Composer 1',
  'OpenCode session',
  '/context.txt',
])

// Max length of a single protobuf string field to consider as a candidate.
// Individual fields > this limit are likely system prompts or serialized blobs.
const MAX_CANDIDATE_LENGTH = 2000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX16_RE = /^[0-9a-f]{16}$/i
const HEX32_RE = /^[0-9a-f]{32}$/i
const HEX_DASHES_RE = /^[0-9a-f-]{20,}$/i
const MODEL_NAME_RE = /^[A-Z][a-z]+ [A-Z0-9][a-z0-9.-]*$/i

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

/**
 * Parse Connect-RPC frames from a response buffer and extract all
 * candidate strings with frame metadata.
 *
 * @param {Buffer} data - raw response bytes
 * @returns {Array<{text: string, fieldPath: string, depth: number, frameIndex: number}>}
 */
export function parseFrameStrings(data) {
  const allStrings = []
  let offset = 0
  let frameIndex = 0

  while (offset < data.length) {
    if (data.length - offset < 5) break

    const compressed = data[offset]
    const length = data.readUInt32BE(offset + 1)

    if (data.length - offset < 5 + length) break

    let payload = data.subarray(offset + 5, offset + 5 + length)

    if (compressed === 1) {
      try {
        payload = zlib.gunzipSync(payload)
      } catch {
        // Decompression failed — skip this frame entirely rather
        // than parsing corrupt compressed data as protobuf
        offset += 5 + length
        frameIndex += 1
        continue
      }
    }

    const strings = extractStringsFromProtobuf(payload)

    for (const s of strings) {
      allStrings.push({ ...s, frameIndex })
    }

    offset += 5 + length
    frameIndex += 1
  }

  return allStrings
}

// ---------------------------------------------------------------------------
// Candidate filtering
// ---------------------------------------------------------------------------

/**
 * Returns true if the string should be excluded from candidates.
 */
export function isFilteredOut(text, textLower, userPromptLower) {
  if (text.length === 0 || text.length > MAX_CANDIDATE_LENGTH) return true

  // Exact user prompt echo
  if (textLower === userPromptLower) return true
  if (userPromptLower && textLower.includes(userPromptLower)) return true

  // Hex IDs
  if (HEX16_RE.test(text)) return true
  if (HEX32_RE.test(text)) return true
  if (HEX_DASHES_RE.test(text) && !text.includes(' ')) return true

  // UUIDs
  if (UUID_RE.test(text)) return true

  // Metadata
  if (METADATA_MARKERS.some(marker => text.includes(marker))) return true

  // Very short non-word strings
  if (text.length < 3 && !/\w/.test(text)) return true

  return false
}

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

/**
 * Score a candidate string based on how likely it is to be the
 * assistant's actual response text.
 */
export function scoreCandidate(text, textLower, frameIndex, depth, userPromptWords, userPromptLower, userPrompt) {
  let score = 0

  // Prefer longer, complete-looking responses
  if (text.length > 10) score += 20
  if (text.length > 30) score += 30
  if (text.length > 50) score += 50

  // Sentence-like patterns
  if (/[.!?]$/.test(text)) score += 40
  if (/^[A-Z]/.test(text)) score += 10
  if (text.includes(' ')) score += 20

  // Later frames are more likely assistant output
  score += frameIndex * 10
  if (frameIndex > 10) score += 50

  // Deeper nesting
  score += depth * 2

  // Penalize user input echoes
  if (userPromptWords.length > 0) {
    let matches = 0
    for (const word of userPromptWords) {
      if (textLower.includes(word)) matches += 1
    }
    const matchRatio = matches / userPromptWords.length
    if (matchRatio > 0.3) score -= 150
    if (matchRatio > 0.5) score -= 300
    if (matchRatio > 0.8) score -= 500
  }

  // Full containment checks
  if (text.length > 5 && userPromptLower.includes(textLower)) score -= 1000
  if (userPrompt.length > 5 && textLower.includes(userPromptLower)) score -= 1000

  // Penalize file paths and model display names
  if (text.includes('/') && text.length < 50) score -= 50
  if (MODEL_NAME_RE.test(text)) score -= 30

  return score
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the assistant's response text from a Cursor protobuf response.
 *
 * Strategy:
 *   1. Parse Connect-RPC frames
 *   2. Extract all strings from protobuf payloads
 *   3. Filter out metadata, IDs, and user echoes
 *   4. Score remaining candidates
 *   5. Return the highest-scored string
 *
 * @param {Buffer} data       - raw response buffer
 * @param {string} userPrompt - the original user prompt (for echo filtering)
 * @returns {string} extracted assistant text, or empty string
 */
export function extractTextFromResponse(data, userPrompt = '') {
  const allStrings = parseFrameStrings(data)

  const userPromptLower = userPrompt.toLowerCase().trim()
  const userPromptWords = userPromptLower.split(/\s+/).filter(w => w.length > 3)

  const candidates = allStrings
    .filter(s => {
      const text = s.text.trim()
      return !isFilteredOut(text, text.toLowerCase(), userPromptLower)
    })
    .map(s => {
      const text = s.text.trim()
      const textLower = text.toLowerCase()
      const score = scoreCandidate(
        text, textLower, s.frameIndex, s.depth,
        userPromptWords, userPromptLower, userPrompt
      )
      return { ...s, text, score }
    })
    .sort((a, b) => b.score - a.score)

  if (process.env.DEBUG) {
    const sanitize = (s) => s.replace(/[^\x20-\x7e]/g, '')
    process.stderr.write('Top 5 candidates:\n')
    candidates.slice(0, 5).forEach((c, i) => {
      const preview = sanitize(c.text.substring(0, 60))
      process.stderr.write(
        `  ${i + 1}. score=${c.score} frame=${c.frameIndex} depth=${c.depth}: "${preview}..."\n`
      )
    })
  }

  return candidates.length > 0 ? candidates[0].text : ''
}
