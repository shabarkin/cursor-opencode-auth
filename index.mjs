#!/usr/bin/env node

import { createServer } from './src/server.mjs'
import { resolvePort } from './src/config.mjs'

const port = resolvePort()
createServer(port)
