# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FreeLLMAPI is an OpenAI-compatible proxy aggregating free-tier LLM models from multiple providers (Google AI Studio, Groq, Mistral, OpenRouter, NVIDIA NIM, etc.) behind a single endpoint. This is a Bun-native fork — it replaces Express with Bun's built-in HTTP server (`Bun.serve`).

Monorepo with workspaces: `server` (Bun + TypeScript), `client` (Vite + React SPA), `shared` (TypeScript types), `cli` (CLI tool).

## Commands

```bash
bun install                    # Install all workspace dependencies
bun run dev                    # Start server in dev mode (file watching, :3001)
bun run build                  # Build client SPA then server (output: server/dist/)
bun run test                   # Run all server + client tests
cd server && bun test          # Run server tests only
cd client && bun test          # Run client tests only
bun run test:migrations        # Run migration tests
bun run db:migration:up        # Apply pending migrations to local DB
bun run db:migration:down      # Roll back last migration
bun run db:migration:fresh     # Drop all tables, re-run all migrations (local/dev only)
bun run db:migration:create --name=description  # Create new migration file
cd server && bun run test:watch  # Watch mode for server tests
cd client && bun run dev       # Client dev server on :5173 (separate from server)
```

Server default port: 3001. Client Vite dev port: 5173. Build output: `server/dist/server.js` (single bundled Bun binary) + `server/dist/web/` (static frontend).

## Architecture

### Server (`server/src/`)

**Entry point:** `server/src/server.ts` — monolithic `Bun.serve` handler with inline route dispatch. No router library; paths are matched with if/else chains.

**Route groups:**
- `/v1/*` — OpenAI-compatible proxy endpoints (chat/completions, embeddings, images, audio, responses). Core proxy logic in `routes/bun/proxy.ts`.
- `/v1beta/*` — Gemini native API passthrough (`routes/bun/gemini.ts`).
- `/v1/messages` — Anthropic-compatible Messages API (`routes/bun/anthropic.ts`).
- `/api/*` — Admin dashboard API (keys, models, fallback config, analytics, settings, auth).
- `/api/health`, `/livez`, `/readyz` — Health probes.
- `/api/ping` — Debug endpoint (no auth).
- `/api/ollama` emulation — Ollama-compatible endpoints when enabled.
- Static SPA served from `server/dist/web/`.

**Providers (`server/src/providers/`):** Each provider extends `BaseProvider` and implements `chatCompletion()`, `streamChatCompletion()`, and `validateKey()`. The index (`providers/index.ts`) registers all platform instances. Most platforms use `OpenAICompatProvider`; Google has its own custom adapter; others are specialized (AIHorde, Cloudflare, Cohere, ModelScope, Pollinations).

**Router (`server/src/services/router.ts`):** The core model selection engine. Supports multiple strategies (priority, balanced, smartest, fastest, reliable, custom). Uses Thompson sampling bandit for reliability/speed scoring with exponential decay weighting over a 7-day window. Routes through a fallback chain (from `fallback_config` or user profiles) with per-key cooldowns, rate limits, and concurrency guards.

**Fallback loop (`server/src/lib/fallback-loop.ts`):** Shared retry/fallback logic for all chat surfaces (OpenAI, Anthropic, Gemini). Handles per-key failures, cooldown selection, exhaustion tracking, and up to 20 serial retry hops with a wall-clock budget.

**Auth (`server/src/lib/auth.ts`):** Two auth layers — session-based for the admin dashboard (`/api/*` routes), unified API key for the proxy (`/v1/*` routes).

**Database (`server/src/db/index.ts`):** Single SQLite file. Schema is initialized in-code (not migration-driven for the baseline) with `ensureSchemaCompat()` adding columns incrementally. Migrations under `db/migrate/` handle additive changes. Model catalog seeds from models.dev on empty DB.

**Key encryption (`server/src/lib/crypto.ts`):** AES-256-GCM for provider API key storage. Key loaded from `ENCRYPTION_KEY` env var or auto-generated/persisted.

**Proxy/outbound (`server/src/lib/proxy.ts`):** Supports HTTP/HTTPS/SOCKS proxies with per-platform bypass, NO_PROXY rules, lazy undici import (avoids crash on Node), and global fetch dispatcher cache for wake-from-suspend recovery.

### Client (`client/src/`)

Vite + React 19 + TanStack Query + React Router. Pages: Keys, Models, Fallback, Analytics, Settings, Playground, Agents, Media, Embeddings, Premium. Uses shadcn/ui components with Tailwind CSS. i18n support via context. Auth via session cookie.

### Shared (`shared/src/`)

Only TypeScript types (`shared/types.ts`) — platforms, model shapes, chat message types, etc.

## Key Design Patterns

- **Bandit routing:** The router uses a Beta-Bernoulli Thompson sampling model for per-key reliability scoring, combined with deterministic speed/intelligence scores. Stats are cache-rewritten every 60s with exponential decay (2-day half-life).
- **Coexistence of old and new DB shapes:** `ensureSchemaCompat()` in `db/index.ts` runs on every startup to add missing columns, so the app works on both fresh installs and databases that grew through multiple migration cycles. Never rely on a column being present without checking it exists first — use `ensureCol()` or PRAGMA `table_info`.
- **Request attempts tracking:** Every upstream call attempt is logged to `request_attempts` with ordinal, outcome, and duration. Used for the attempt-trace debug output and for the `error_summary` column on `requests`.
- **Endpoint scope:** Custom providers (relay endpoints) are differentiated by `base_url`/`endpoint_scope` so multiple relays offering the same model ID don't share key rotation or stats buckets.
- **Test structure:** Server tests use vitest in `server/src/__tests__/`. Most tests use `initDb()` for a fresh database. Shared test helpers are in `server/src/__tests__/helpers/`. Client tests use vitest in `client/src/`.
- **Error classification:** `lib/error-classify.ts` maps upstream HTTP errors to semantic categories (rate limit, auth failure, model not found, timeout, etc.) that drive cooldown decisions and fallback behavior.
- **Model retirement:** `services/model-retirement.ts` monitors for upstream 404/403 model removals and tombstones models so they stop being routed to.

## Environment Variables

See `.env.example` for the full list. Critical ones:
- `ENCRYPTION_KEY` — 64-char hex AES-256-GCM key (required in production)
- `PORT` — server port (default 3001)
- `ADMIN_PASSWORD` — dashboard password (auto-generated if omitted)
- `HF_TOKEN` / `HF_DATASET_ID` / `BACKUP_ENABLED` — Hugging Face backup
- `PROXY_URL` / `ALL_PROXY` — outbound proxy for provider requests
- `FALLBACK_TIME_BUDGET_MS` — wall-clock retry budget

## Migration Creation

```bash
bun run db:migration:create --name=add_your_migration_here
```
Migrations go in `server/src/db/migrations/`. The baseline schema lives in `server/src/db/index.ts` and is updated there for new table/column additions (not via migration files).

## Docker

Multi-platform CI builds native images for `linux/amd64` and `linux/arm64` (no QEMU emulation). Dockerfile is at the repo root. Build with `bun run build` first, then copy `server/dist/` into the image.
