<div align="center">

# FreeLLMAPI (Bun Branch)

**One OpenAI-compatible endpoint. Free LLM models from models.dev.**

Aggregate free-tier models dynamically fetched from [models.dev](https://github.com/anomalyco/models.dev) behind a single `/v1/chat/completions` endpoint. Runs on **Bun** with automatic SQLite backups to Hugging Face Dataset.

</div>

---

## Features

- **Dynamic model catalog** — Free models auto-fetched from [models.dev](https://github.com/anomalyco/models.dev) on first startup
- **OpenAI-compatible** — Drop-in replacement for OpenAI API clients
- **Automatic fallback** — Routes to the next available model when one hits rate limits
- **Encrypted key storage** — AES-256-GCM encryption for API keys
- **Admin dashboard** — React SPA for managing keys, fallback chain, and analytics
- **SQLite backup to HF Dataset** — Automatic periodic backups with 3-snapshot retention
- **Bun runtime** — Fast startup, low memory footprint

---

## Quick Start (Local)

### Prerequisites

- [Bun](https://bun.sh/) 1.3+
- Node.js 20+ (for building client)

### 1. Clone & Install

```bash
git clone -b bun https://github.com/stxh/freellmapi.git
cd freellmapi
bun install
cd client && bun install && cd ..
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env and set ENCRYPTION_KEY, optionally HF_TOKEN / HF_DATASET_ID
```

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Build & Run

```bash
# Build client
bun run build

# Run server (dev mode with watch)
bun run dev

# Or production mode
bun run build:server
bun run start
```

Server starts on `http://0.0.0.0:3001` (or `PORT` env var).

- Dashboard: `http://localhost:3001`
- API endpoint: `http://localhost:3001/v1/chat/completions`

### 4. Login

Default admin credentials are printed on first startup. Set `ADMIN_PASSWORD` in `.env` to customize.

---

## Hugging Face Space Deployment

### Step 1: Create Dataset for Backups (Optional)

Create a new **Dataset** on Hugging Face (e.g. `yourname/freellmapi-backups`). This will store SQLite backups.

### Step 2: Create Space

1. Go to [Hugging Face Spaces](https://huggingface.co/spaces) and click **Create new Space**
2. Choose **Docker** as the SDK
3. Space name: e.g. `freellmapi`
4. Set visibility (Private recommended since it stores API keys)

### Step 3: Push Code

```bash
git clone https://huggingface.co/spaces/yourname/freellmapi
cd freellmapi
# Copy all files from this repo
cp -r /path/to/freellmapi-bun/* .
git add .
git commit -m "Initial deploy"
git push
```

### Step 4: Configure Secrets

In Space **Settings > Secrets**, add:

| Secret | Description |
|--------|-------------|
| `ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM encryption |
| `ADMIN_PASSWORD` | Admin dashboard password (optional, random if omitted) |
| `HF_TOKEN` | Hugging Face token with write access to backup dataset |
| `HF_DATASET_ID` | Dataset repo ID, e.g. `yourname/freellmapi-backups` |
| `BACKUP_ENABLED` | Set to `true` to enable automatic backup/restore |
| `BACKUP_INTERVAL_MS` | Backup interval in ms (default: 86400000 = 24h) |

### Step 5: Access

After the Space builds (may take 2-3 minutes):

- Open the Space URL
- Login with admin credentials (check Space logs for auto-generated password if not set)
- Add your provider API keys in the **Keys** page
- Grab your unified API key from the header

### Docker Build Notes

The included `Dockerfile` uses `oven/bun:1` as the base image. It:

1. Installs build tools for native modules
2. Runs `bun install` for both client and server
3. Builds the client with Vite
4. Builds the server with Bun bundler
5. Exposes port `7860` (Hugging Face default)

---

## Model Data Source

This branch uses [models.dev](https://github.com/anomalyco/models.dev) as the canonical source for free model listings.

On first startup (when the SQLite database has no models), the server:

1. Downloads `models.json` from models.dev
2. Filters models where `pricing.prompt === "0"` and `pricing.completion === "0"`
3. Maps each model to a platform:
   - Known native providers (`google`, `groq`, `cerebras`, `sambanova`, `nvidia`, `mistral`, `github`, `cohere`, `cloudflare`, `zhipu`) are used directly
   - Everything else (including `:free` suffix models) routes through **OpenRouter**
4. Computes initial `intelligence_rank` and `speed_rank` based on model name heuristics
5. Seeds the fallback chain in intelligence order

Models are **not** hardcoded. To refresh the catalog, delete `data/freeapi.db` and restart.

---

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
print("Routed via:", resp.headers.get("x-routed-via"))
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENCRYPTION_KEY` | Yes | — | 64-char hex encryption key |
| `PORT` | No | `3001` | Server port |
| `ADMIN_PASSWORD` | No | random | Initial admin password |
| `HF_TOKEN` | No | — | HF token for dataset backup |
| `HF_DATASET_ID` | No | — | Dataset repo ID for backups |
| `BACKUP_ENABLED` | No | `false` | Enable HF dataset backup |
| `BACKUP_INTERVAL_MS` | No | `86400000` | Backup interval (ms) |

---

## License

MIT
