# Running a Free LLM API Proxy on Hugging Face Spaces (with Bun)

[models.dev](https://github.com/anomalyco/models.dev) tracks hundreds of free-tier LLM models. Supported platforms include **Google AI Studio, Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter, GitHub Models, Cohere, Cloudflare Workers AI, Zhipu AI**, and more. Some time ago I built a proxy that aggregates them all behind a single OpenAI-compatible endpoint.

The result is [bun-FreeLLMAPI](https://github.com/bun-fun/bun-freellmapi), a Bun-native fork based on [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) that you can deploy to Hugging Face Spaces in about five minutes.

## Why Bun?

The original FreeLLMAPI uses Node.js + Express. I rewrote it with Bun's built-in HTTP server (`Bun.serve`) for three reasons:

- **Single dependency** — Bun is both the runtime and the package manager. No Express, no body-parser, no cors middleware, no `better-sqlite3`.
- **Fast startup** — Cold start on HF Spaces drops from several seconds to under one second.
- **Self-contained bundle** — `bun build --target bun` produces a single `server.js` that includes all dependencies. Deploy it anywhere Bun runs.

Thanks to the original project, the API surface stayed the same — any OpenAI SDK works as a client.

## How it works

On first startup, the server:

1. Fetches free models from [models.dev](https://github.com/anomalyco/models.dev)
2. Filters for `pricing.prompt === "0" && pricing.completion === "0"`
3. Routes each model using the platform's base URL (Google, Groq, etc.) combined with your provided API key
4. Seeds a local SQLite database with the model catalog and fallback priorities
5. Creates an admin user and a unified API key

When a chat request arrives at `/v1/chat/completions`, the proxy picks the best available model from the platforms you've configured keys for. If a provider hits rate limits, it falls back to the next model automatically.

Provider API keys are encrypted at rest with AES-256-GCM.

## Deploying to Hugging Face Spaces

This is where it gets practical. A free HF Space gives you a public HTTPS endpoint with minimal setup.

**You'll need:**
- A Hugging Face account
- [Bun](https://bun.sh/) installed locally to build (or use the prebuilt artifacts from [bun-FreeLLMAPI](https://github.com/bun-fun/bun-freellmapi))

**Step 1 (optional): Build**

```bash
git clone https://github.com/bun-fun/bun-freellmapi.git
cd bun-freellmapi
bun install
bun run build
```

This produces `server/dist/server.js` (the bundled server) and `server/dist/web/` (the React admin dashboard).

**Step 2: Deploy to HF Space**

Since HF Space resets its filesystem on restart, the SQLite database (API keys and config) would be lost. The solution is to bind an HF Dataset for persistent storage:

1. Create a new **Dataset** on Hugging Face (set to **Private**)
2. Add `HF_TOKEN` (your User Access Token) in Space Settings → Repository Secrets
3. On first startup, the server will automatically sync `data/freeapi.db` to this Dataset

Create a new **Docker** Space on Hugging Face, then:

```bash
git clone https://huggingface.co/spaces/yourname/freellmapi
cd freellmapi

# Copy the built artifacts
cp /path/to/server/dist/server.js .
cp /path/to/server/dist/web/* .
cp /path/to/server/dist/Dockerfile .

git add . && git commit -m "Deploy" && git push
```

**Step 3: Configure secrets**

In Space Settings → Repository Secrets, set:

| Secret | Required | Description |
|--------|----------|-------------|
| `ENCRYPTION_KEY` | Yes | 64-char hex key for AES-256-GCM. Generate: `bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_PASSWORD` | No | Admin dashboard password (auto-generated if omitted) |
| `HF_TOKEN` | No* | Hugging Face token with write access to the backup dataset |
| `HF_DATASET_ID` | No* | Dataset repo ID, e.g. `yourname/freellmapi-backups` |
| `BACKUP_ENABLED` | No | Set to `true` to enable automatic backup/restore |
| `BACKUP_INTERVAL_MS` | No | Backup interval in ms (default: `86400000` = 24h) |

*Required when `BACKUP_ENABLED=true`.

After the Space builds (about 2 minutes), open the Space URL and log in with the admin password from the build logs.

**Typical config:**
```
ENCRYPTION_KEY=<64 hex chars>
ADMIN_PASSWORD=<your secure password>
HF_TOKEN=hf_your_token
HF_DATASET_ID=yourname/freellmapi-backups
BACKUP_ENABLED=true
```

## Staying in sync with models.dev

The model catalog is never hardcoded. Every fresh startup pulls the latest list from models.dev. If a new free model appears there, your proxy sees it automatically.

To refresh an existing database, just delete `data/freeapi.db` and restart.

## For users in mainland China

One reason I built this: many free providers (Google AI Studio, Groq, Cerebras, Mistral, etc.) are directly accessible from mainland China without VPNs. A self-hosted proxy on HF Spaces aggregates them into a single API endpoint that any application can use.

## Running standalone

The same `server.js` binary runs anywhere Bun is available — a VPS, a Raspberry Pi, or a Docker container:

```bash
ENCRYPTION_KEY=<key> ADMIN_PASSWORD=<pass> bun server.js
```

Default port is `3001`, overridable via the `PORT` environment variable (HF Spaces maps to `7860` internally).

No `node_modules`, no build step. Just one file.

## API Usage Example

Once deployed, any OpenAI SDK works as a client:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://yourname-freellmapi.hf.space/v1",
    api_key="freellmapi-your-unified-key",
)

resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

## Public Deployment Security Considerations

1. **Use HTTPS** — HF Spaces provides TLS automatically. For custom deployments, put a reverse proxy (Nginx, Caddy) with TLS termination in front.
2. **Set a strong password** — Do not rely on the auto-generated `ADMIN_PASSWORD`. Use a long, unique value.
3. **Protect `ENCRYPTION_KEY`** — Losing this key makes stored provider API keys unrecoverable.
4. **Unified API key** — The key printed at startup authenticates proxy requests (`/v1/chat/completions`). Rotate periodically, do not share it publicly.
5. **Set Space to Private** — While the admin dashboard has its own auth, Private visibility adds a network-level access barrier.
6. **Keep the Dataset private** — Backup datasets are world-readable by default. Remember to set yours to **Private**.

## Try it

The live demo is at [bun008-freellmapi.hf.space](https://bun008-freellmapi.hf.space). The [bun-FreeLLMAPI](https://github.com/bun-fun/bun-freellmapi) is MIT-licensed on GitHub.
