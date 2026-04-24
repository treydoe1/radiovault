# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

## Commands

```bash
npm start        # launch Electron app in dev mode
npm run build    # build unsigned .dmg for macOS (arm64), output in dist/
npm run release  # build signed + notarized .dmg (local only)
npm run publish  # build signed + notarized, upload to GitHub Releases
```

Release flow is wrapped by `.Codex/commands/release.md` (invoke with `/release [patch|minor|major|X.Y.Z]`).

No test suite exists. Manual testing only.

## What This Is

Electron desktop app (RadioVault v1.1.3) for Clemson Athletics radio broadcast archiving. Subscribes to RSS/podcast feeds (Tiger Network), downloads audio, transcribes via MLX Whisper or Groq API, extracts clips using keyword taxonomy + TF-IDF scoring, generates AI summaries via Codex API, and exports trimmed audio clips. Otter.ai-style transcript-first UI. Data syncs across machines via Supabase. Forked from ClipVault.

## Architecture

### Process model

Electron main process (`main.js`) owns all filesystem, ffmpeg, Keychain, RSS fetching, and Supabase operations. Renderer pages (`app.html`, `settings.html`, `onboarding.html`) communicate via IPC through `preload.js`. Renderer runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.

### Data flow

```
RSS Feeds ──> feeds.js ──> vault_db.json (local)
                 │                 │
                 └──> supabase.js ──> Supabase (cloud)
                                        │
                 main.js startup ──> fetchRemoteDB()
                                        │
                 mergeDbForRenderer(network, local) ──> renderer DB
```

- `feeds.js` fetches RSS feeds, parses episodes, downloads MP3 audio to local cache.
- `ingest.js` prepares audio (16kHz mono), transcribes (MLX Whisper or Groq API), extracts clips via `taxonomy.js` keywords + TF-IDF, generates AI summaries via Codex API.
- On startup, `main.js` fetches from Supabase, merges with local DB, injects into renderer.
- `supabase.js` is a standalone client wrapper -- initialized lazily from Keychain credentials.

### Key IPC pattern

Main process injects data into renderer with `executeJavaScript` setting `window.DB`. The renderer variable must be declared with `var DB` (not `let`) in `app.html` so the window property assignment works.

### Merge contract

`mergeDbForRenderer(networkDb, localDb)` starts from network data and overlays local-only fields. `file_path`, `summary`, and `key_moments` are local-only and must never be overwritten by network data.

### File Map

| File | Role |
|---|---|
| `main.js` | Electron main process: window, IPC handlers, ffmpeg, Keychain, RSS, Supabase |
| `preload.js` | Context bridge: all IPC methods exposed to renderer |
| `feeds.js` | RSS feed engine: fetch, parse, episode discovery, audio download |
| `taxonomy.js` | Configurable keyword taxonomy for clip extraction |
| `ingest.js` | Pipeline: prepare audio, transcribe, extract clips, AI summary |
| `supabase.js` | Supabase client wrapper |
| `app.html` | Main renderer: Otter.ai-style transcript-first UI |
| `settings.html` | RSS feeds, API keys, transcription provider, taxonomy editor |
| `onboarding.html` | First-run: feed URL setup, optional API keys |
| `vault_db.json` | Bundled empty DB seed |
| `mlx_transcribe.py` | On-device Whisper via MLX (Apple Silicon) |
| `schema.sql` | Supabase table definitions |

### Keychain

Service: `radiovault`

| Account | Purpose |
|---|---|
| `supabase_url` | Supabase project URL |
| `supabase_service_key` | Supabase service role key |
| `groq_api_key` | Groq transcription API |
| `anthropic_api_key` | Codex API for AI summaries |

## Build & Release

Build output: `dist/RadioVault-<version>-arm64.dmg` (+ `.zip` for auto-update). App icon at `build/icon.icns`.

**Signing:** Developer ID Application — `RAYMOND RANDOLPH KEYS (PQ4PV58B72)`. Hardened runtime enabled. Entitlements: `build/entitlements.mac.plist`.

**Notarization:** `build/notarize.js` runs as `afterSign` hook via `@electron/notarize`. Uses notarytool keychain profile `RadioVault` (stored with `xcrun notarytool store-credentials`). Requires env vars `APPLE_TEAM_ID` and `NOTARY_KEYCHAIN_PROFILE` — both are set by the `release`/`publish` npm scripts.

**Publish target:** GitHub Releases at `treydoe1/radiovault`. Auto-update handled by `electron-updater` (reads `latest-mac.yml` from the release).

**Node requirement:** Use a standalone Node (Homebrew or nodejs.org), NOT the Codex-bundled node at `/Applications/Codex.app/Contents/Resources/node`. Codex-node is signed with a different Team ID and its hardened runtime refuses to load native modules like `iconv-corefoundation`. Running `which node` should return `/opt/homebrew/bin/node`.
