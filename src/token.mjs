/**
 * Cursor auth token loading with cross-platform providers and TTL caching.
 */

import { TOKEN_CACHE_TTL_MS } from './config.mjs'
import { createTtlCache } from './token-store/cache.mjs'
import { getTokenFromStore } from './token-store/index.mjs'

const tokenCache = createTtlCache(TOKEN_CACHE_TTL_MS)

/**
 * Returns the Cursor access token, reading from store providers only if
 * the cache is empty or has expired (default 5 minutes).
 *
 * @param {object} options - optional dependency injection for tests
 * @returns {string} Bearer token
 * @throws {Error} If the token cannot be read from any provider
 */
export function getToken(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const cachedToken = tokenCache.get(now)
  if (cachedToken) {
    return cachedToken
  }

  const token = getTokenFromStore(options)
  return tokenCache.set(token, now)
}

/**
 * Clears the cached token, forcing the next getToken() call
 * to re-read from store providers. Useful for testing or re-auth.
 */
export function clearTokenCache() {
  tokenCache.clear()
}

export const __testables = Object.freeze({
  tokenCache,
  getTokenFromStore,
})
