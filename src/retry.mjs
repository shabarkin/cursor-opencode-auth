const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504])

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function parseRetryAfterHeader(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null
  }

  const asSeconds = Number.parseInt(value, 10)
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000
  }

  const asDate = Date.parse(value)
  if (Number.isFinite(asDate)) {
    const delay = asDate - Date.now()
    return delay > 0 ? delay : 0
  }

  return null
}

export function isRetryableError(error) {
  const statusCode = error?.statusCode ?? error?.status
  if (RETRYABLE_STATUS_CODES.has(statusCode)) {
    return true
  }

  if (typeof error?.message === 'string') {
    return /HTTP (429|502|503|504)/.test(error.message)
  }

  return false
}

function defaultDelayMs(attempt, baseDelayMs, maxDelayMs, retryAfterMs) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, maxDelayMs)
  }

  const exponential = baseDelayMs * (2 ** attempt)
  return Math.min(exponential, maxDelayMs)
}

export async function withRetry(fn, {
  retries = 2,
  baseDelayMs = 250,
  maxDelayMs = 5_000,
  shouldRetry = isRetryableError,
} = {}) {
  let attempt = 0

  while (true) {
    try {
      return await fn(attempt)
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) {
        throw error
      }

      const delayMs = defaultDelayMs(
        attempt,
        baseDelayMs,
        maxDelayMs,
        error?.retryAfterMs,
      )

      await sleep(delayMs)
      attempt += 1
    }
  }
}
