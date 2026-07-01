# FreeLLMAPI (Bun-native fork)

> **Live demo:** [bun008-freellmapi.hf.space](https://bun008-freellmapi.hf.space)

An OpenAI-compatible proxy aggregating **free-tier LLM models** from multiple providers behind a single endpoint. This is a **Bun-native** fork of the original [FreeLLMAPI](https://github.com/anomalyco/freellmapi) project.

## Relationship to the Original

The original FreeLLMAPI uses Node.js + Express. This fork is a complete rewrite that replaces Express with **Bun's built-in HTTP server** (`Bun.serve`), resulting in:

- Faster startup and lower memory footprint
- Fewer dependencies (no Express, no body-parser, no cors middleware)
- Bun SQLite driver instead of `better-sqlite3`
- Same API surface — fully compatible with existing clients

All routes, database schema, and the React frontend are preserved and adapted to Bun's native APIs.

## Model Data Source

This fork uses [models.dev](https://github.com/anomalyco/models.dev) instead of the original freellmapi.co API. On first startup, free models are fetched from models.dev, mapped to their respective platforms, and seeded into the local database.

Supported platforms: Google AI Studio, Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter, GitHub Models, Cohere, Cloudflare Workers AI, Zhipu AI.

**For users in mainland China:** Services like Google AI Studio, Groq, and other providers are often directly accessible, making this a viable self-hosted solution without relying on region-locked aggregators.

## Features

- **Dynamic model catalog** — Free models auto-fetched from models.dev on startup
- **OpenAI-compatible** — Drop-in replacement: use any OpenAI SDK with `base_url` pointing to your instance
- **Intelligent fallback** — Routes to the next available model when one hits rate limits
- **Encrypted key storage** — AES-256-GCM encryption for provider API keys
- **Admin dashboard** — React SPA for managing keys, fallback chain, and analytics
- **Automatic HF Dataset backup** — Periodic SQLite backups with 3-snapshot retention
- **Bun runtime** — Single runtime dependency, fast startup

## Quick Start (Local)

### Prerequisites

- [Bun](https://bun.sh/) 1.3+

### Install & Run

```bash
git clone https://github.com/stxh/freellmapi.git
cd freellmapi
cp .env.example .env
# Edit .env — at minimum set ENCRYPTION_KEY

bun install
bun run build   # Build client SPA
bun run dev     # Dev mode (file watching)
```

Server starts on `http://0.0.0.0:3001` (set `PORT` to change). The admin password is printed to the console on first startup.

## Hugging Face Spaces Deployment

### 1. Create a Backup Dataset (Optional)

Create a **Private Dataset** on Hugging Face (e.g. `yourname/freellmapi-backups`) to store automatic SQLite backups.

### 2. Create a Space

1. Go to [Hugging Face Spaces](https://huggingface.co/spaces) → **Create new Space**
2. SDK: **Docker**
3. Visibility: **Public** (if you are PRO user, you can keep it Private)

### 3. Deploy

```bash
git clone https://huggingface.co/spaces/yourname/freellmapi
cd freellmapi

# bun run build first
cp -r /path/to/bun-freellmapi/server/dist/web/* .       #web ui
cp /path/to/bun-freellmapi/server/dist/server.js .      #server
cp /path/to/bun-freellmapi/server/dist/Dockerfile .     #oven/bun:alpine
git add . && git commit -m "Deploy" && git push
```

### 4. Configure Secrets

In Space **Settings → Repository Secrets**, add:

| Secret | Description |
|--------|-------------|
| `ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM. Generate: `bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_PASSWORD` | Admin dashboard password (auto-generated if omitted) |
| `HF_TOKEN` | Hugging Face token with write access to the backup dataset |
| `HF_DATASET_ID` | Dataset repo ID, e.g. `yourname/freellmapi-backups` |
| `BACKUP_ENABLED` | Set to `true` to enable automatic backup/restore |
| `BACKUP_INTERVAL_MS` | Backup interval in ms (default: 86400000 = 24h) |

### 5. Access

Once built, open your Space URL. Find the auto-generated admin password in Space logs. Add provider API keys in the **Keys** page, then use the unified API key with any OpenAI client.

## Public Deployment Security Considerations

Deploying this proxy on a public-facing server exposes API key management to the internet. Follow these precautions:

1. **Use HTTPS** — Hugging Face Spaces provides TLS automatically. For custom servers, put a reverse proxy (Nginx, Caddy) with TLS termination in front.
2. **Set a strong `ADMIN_PASSWORD`** — Do not rely on the auto-generated password for production. Use a long, unique value.
3. **Set a strong `ENCRYPTION_KEY`** — Provider API keys are encrypted at rest. Losing this key makes stored keys unrecoverable.
4. **Restrict the unified API key** — The unified key printed at startup authenticates proxy requests (`/v1/chat/completions`). Treat it like any API key: rotate periodically, do not share it publicly.
5. **Private HF Space** — Keep the Space visibility set to **Private**. The admin dashboard handles its own authentication, but private visibility adds a network-level access barrier.
6. **Local-only proxy** — The `/v1/chat/completions` endpoint allows unauthenticated requests from `127.0.0.1`. This is intended for local development. On public deployments, remote requests always require the unified API key.
7. **Backup dataset** — If using HF Dataset backups, the backup dataset is world-readable by default. The database contains encrypted API keys and session tokens. Set the dataset visibility to **Private** as well.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENCRYPTION_KEY` | Yes | — | 64-char hex key for AES-256-GCM. Persisted to DB on first run if omitted, but setting it explicitly ensures it survives DB resets. |
| `PORT` | No | `3001` | Server port (HF Spaces default: `7860` mapped internally) |
| `ADMIN_PASSWORD` | No | random | Admin dashboard password. Set this for reproducible credentials. |
| `HF_TOKEN` | No* | — | Hugging Face token with write access to the backup dataset |
| `HF_DATASET_ID` | No* | — | Dataset repo ID, e.g. `yourname/freellmapi-backups` |
| `BACKUP_ENABLED` | No | `false` | Set to `true` to enable automatic backup & restore via HF Dataset |
| `BACKUP_INTERVAL_MS` | No | `86400000` | Backup interval in milliseconds |

*Required only when `BACKUP_ENABLED=true`.

### Typical HF Spaces Secret Setup

```
ENCRYPTION_KEY=<64 hex chars>
ADMIN_PASSWORD=<your secure password>
HF_TOKEN=hf_your_token
HF_DATASET_ID=yourname/freellmapi-backups
BACKUP_ENABLED=true
```

## API Usage

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

## License

MIT
