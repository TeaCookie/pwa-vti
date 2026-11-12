# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Voice Counter** - A PWA voice-controlled counter using on-device Needle 3 (small LLM) running in a Web Worker via Cactus Compute's WASM runtime.

## Architecture

- **index.html** - Main PWA entry point with counter UI, speech recognition, and Needle worker integration
- **needle.worker.js** - Web Worker that loads Cactus runtime + Needle 3 model for on-device inference
- **sw.js** - Service worker for offline support and caching
- **manifest.webmanifest** - PWA manifest
- **cactus.js / cactus.wasm** - Cactus Compute WASM runtime (loaded locally)
- **needle3.cact** - Needle 3 model file (~35MB, loaded locally)

## Build/Lint/Test Commands

```bash
# Download model files (run locally or on Netlify build)
node download-models.js

# Serve locally for testing (any static server)
npx serve .
# or
python -m http.server 8000

# No formal lint/test setup yet - this is a vanilla JS PWA
```

## Netlify Deployment

The project is configured for Netlify deployment:
- `netlify.toml` configures build command to download models
- Model files are downloaded at build time (not committed to git)
- Headers configured for proper WASM and model file caching

## Key Conventions

- All model/runtime files served from same origin (no CORS issues)
- Needle worker uses Cache API for persistent caching of model files
- Service worker caches all assets for offline support
- Speech recognition uses Web Speech API (Chrome/Edge/Safari support)
- LocalStorage used for counter persistence

## Common Tasks

```bash
# Test locally after downloading models
node download-models.js && npx serve .

# Deploy to Netlify - just push to main branch
git push origin main

# Check model file integrity
node -e "
const crypto = require('crypto');
const fs = require('fs');
['cactus.js', 'cactus.wasm', 'needle3.cact'].forEach(f => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(f));
  console.log(f, hash.digest('hex'));
});
"
```

## Model Files

Model files are NOT committed to git (too large). They are downloaded at build time via `download-models.js`:
- `cactus.js` (~63KB) - Cactus runtime JS
- `cactus.wasm` (~1.2MB) - Cactus WASM binary  
- `needle3.cact` (~35MB) - Needle 3 model

Expected SHA-256 checksums are verified during download.