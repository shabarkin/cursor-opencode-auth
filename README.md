# Cursor OpenCode Auth

An OpenAI-compatible proxy server that lets you use Cursor's AI models (composer-1, claude-4.5-sonnet, gpt-5.2-codex, etc.) in OpenCode or any OpenAI-compatible client.

<img width="888" height="792" alt="image" src="https://github.com/user-attachments/assets/1f426176-096c-45e7-90cd-750bf8c581f1" />

## Requirements

- **Node.js 18+**
- **Cursor CLI** installed and logged in - [Install here](https://cursor.com/cli) (the proxy uses your Cursor auth token)
- **macOS, Linux, or Windows** (token providers are platform-aware)

## Quick Start

**Step 1: Start the proxy server** (run in a separate terminal)

```bash
# Install globally and run
npm install -g cursor-opencode-auth
cursor-proxy

# Or run directly with npx
npx cursor-opencode-auth

# Or clone and run
git clone https://github.com/shabarkin/cursor-opencode-auth
cd cursor-opencode-auth
node proxy-server.mjs
```

**Step 2: Keep the proxy running** while you use OpenCode

The server runs on `http://localhost:4141` by default.

## Usage with OpenCode

Add this to your `opencode.json`:

```json
{
	"provider": {
		"cursor": {
			"name": "Cursor (Proxy)",
			"api": "http://localhost:4141/v1",
			"models": {
				"composer-1": {
					"name": "Composer 1",
					"limit": { "context": 200000, "output": 32000 }
				},
				"claude-4.5-sonnet": {
					"name": "Claude 4.5 Sonnet",
					"limit": { "context": 200000, "output": 16000 }
				},
				"gpt-5.2-codex": {
					"name": "GPT 5.2 Codex",
					"limit": { "context": 128000, "output": 16000 }
				}
			}
		}
	}
}
```

Then select `cursor/composer-1` (or other model) in OpenCode.

## Usage with curl

```bash
# List available models
curl http://localhost:4141/v1/models

# Chat completion
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-1",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-1",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Available Models

The proxy exposes all models available in your Cursor subscription:

- `composer-1` - Cursor's flagship model
- `gpt-5.2-codex` - GPT 5.2 optimized for code
- `claude-4.5-sonnet` - Claude 4.5 Sonnet
- `claude-4-opus` - Claude 4 Opus
- `gemini-2.5-pro` - Gemini 2.5 Pro
- `grok-3` - Grok 3
- `o4` - O4 reasoning model
- And more...

## Feature Status

- ✅ OpenAI-compatible chat completions
- ✅ Tool calling (`tools`, `tool_choice`, streamed `delta.tool_calls`)
- ✅ Image input parts (`type: "image_url"`) via base64 `data:image/...` URLs
- ✅ True incremental streaming (progressive deltas)
- ✅ Cross-platform token loading (env, platform store, file fallback)
- ✅ Retry logic for transient upstream API failures

## How It Works

1. The proxy loads your Cursor auth token from `CURSOR_AUTH_TOKEN`, platform credential store, or token file fallback
2. Incoming OpenAI-format requests are translated to Cursor's Connect-RPC/protobuf format
3. Requests are sent to Cursor's API (`agentn.api5.cursor.sh`)
4. Protobuf responses are parsed and converted back to OpenAI format

## Configuration

```bash
# Custom port
node proxy-server.mjs 8080

# Enable debug logging
DEBUG=1 node proxy-server.mjs
```

## Troubleshooting

### "Failed to load Cursor auth token"

Make sure you have the [Cursor CLI](https://cursor.com/cli) installed and are logged in. The token is stored at:

```bash
security find-generic-password -s "cursor-access-token" -w
```

Linux token check:

```bash
secret-tool lookup service cursor-access-token
```

Windows token check (PowerShell):

```powershell
Get-StoredCredential -Target "cursor-access-token"
```

You can always bypass platform stores by setting:

```bash
export CURSOR_AUTH_TOKEN="<your-token>"
```

### Image support notes

`image_url` inputs currently accept **only** base64 `data:image/...` URLs. Remote `http(s)` image URLs are rejected in v1 for safety.

### Empty responses

Check the proxy logs for errors. The proxy includes debug output showing:

- Request details (model, message count)
- Cursor API status
- Response size and extracted text

## License

MIT
