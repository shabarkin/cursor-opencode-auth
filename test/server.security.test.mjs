import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createServer } from '../src/server.mjs'

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function startServer() {
  const server = createServer(0)
  await once(server, 'listening')
  const { port } = server.address()
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  }
}

test('rejects POST from disallowed origin', async () => {
  const { server, baseUrl } = await startServer()

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.com',
        'Content-Type': 'text/plain',
      },
      body: '{}',
    })

    assert.equal(response.status, 403)

    const payload = await response.json()
    assert.equal(payload.error.code, 403)
    assert.equal(payload.error.message, 'Origin not allowed')
  } finally {
    await closeServer(server)
  }
})

test('requires application/json for chat completions', async () => {
  const { server, baseUrl } = await startServer()

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({
        model: 'composer-1',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    })

    assert.equal(response.status, 415)

    const payload = await response.json()
    assert.equal(payload.error.code, 415)
    assert.equal(payload.error.message, 'Content-Type must be application/json')
  } finally {
    await closeServer(server)
  }
})

test('returns 400 for malformed content parts', async () => {
  const { server, baseUrl } = await startServer()

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'composer-1',
        messages: [{ role: 'user', content: [null] }],
        stream: false,
      }),
    })

    assert.equal(response.status, 400)

    const payload = await response.json()
    assert.equal(payload.error.code, 400)
    assert.match(payload.error.message, /messages\[0\]\.content\[0\] must be an object/)
  } finally {
    await closeServer(server)
  }
})
