/**
 * Configuration constants, allowlists, and validators.
 * Single source of truth for all tunable parameters.
 */

export const DEFAULT_PORT = 4141
export const AGENT_BASE = 'agentn.api5.cursor.sh'
export const CLIENT_VERSION = 'cli-2026.01.09-231024f'
export const MAX_BODY_SIZE_BYTES = 1_048_576 // 1 MB
export const TOKEN_CACHE_TTL_MS = 300_000 // 5 minutes
export const HARD_TIMEOUT_MS = 60_000
export const IDLE_TIMEOUT_MS = 3_000
export const IDLE_CHECK_INTERVAL_MS = 500

export const ALLOWED_UPSTREAM_HOSTS = Object.freeze([
  'agentn.api5.cursor.sh',
  'agent.api5.cursor.sh',
  'api2.cursor.sh',
])

const ALLOWED_CORS_PATTERNS = Object.freeze([
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,
])

export function resolvePort() {
  const parsed = parseInt(process.argv[2], 10)
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536
    ? parsed
    : DEFAULT_PORT
}

export function isAllowedUpstreamHost(host) {
  return ALLOWED_UPSTREAM_HOSTS.includes(host)
}

export function isAllowedOrigin(origin) {
  if (!origin) return false
  return ALLOWED_CORS_PATTERNS.some(pattern => pattern.test(origin))
}
