#!/usr/bin/env node

import { createServer } from './src/server.mjs'
import { resolvePort } from './src/config.mjs'

const port = resolvePort()
const server = createServer(port)

const FORCE_EXIT_TIMEOUT_MS = 5_000
let shuttingDown = false

function shutdown(signal) {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  process.stdout.write(`\nReceived ${signal}. Shutting down...\n`)

  const forceExitTimer = setTimeout(() => {
    process.stderr.write('Forced shutdown after timeout.\n')
    process.exit(1)
  }, FORCE_EXIT_TIMEOUT_MS)

  server.close((error) => {
    clearTimeout(forceExitTimer)

    if (error) {
      process.stderr.write(`Failed to close server cleanly: ${error.message}\n`)
      process.exit(1)
      return
    }

    process.stdout.write('Server closed.\n')
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
