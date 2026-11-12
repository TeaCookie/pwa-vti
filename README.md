# Voice Counter PWA — Needle 3 Fine-Tuning Experiment

## Overview

This repository documents a complete experiment in **fine-tuning Needle 3 (a small LLM) for reliable on-device tool calling** in a Progressive Web App. The Voice Counter is a voice-controlled counter that runs Needle 3 entirely in the browser via WebAssembly — no server, no API keys, no network required after initial load.

## What This Experiment Demonstrates

| Aspect | Achievement |
|--------|-------------|
| **Model size** | Needle 3 (~35MB base, ~60MB fine-tuned) runs in browser WASM |
| **Inference** | On-device via Cactus Compute runtime in a Web Worker |
| **Tool calling** | 3 tools (`increment`, `decrement`, `reset`) with >95% accuracy |
| **Voice input** | Web Speech API → transcript → LLM → tool calls → UI update |
| **Offline** | Full PWA with service worker caching (model + runtime + assets) |
| **Deployment** | Netlify static hosting, model files downloaded at build time |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser (PWA)                          │
├─────────────────────────────────────────────────────────────┤
│  index.html (UI, Speech Recognition, Worker communication) │
│  sw.js (Service Worker - offline caching)                  │
└─────────────────────────┬───────────────────────────────────┘
                          │ postMessage
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Web Worker                               │
│  needle.worker.js (Cactus runtime + Needle 3 model)        │
│  • Loads cactus.js + cactus.wasm                           │
│  • Loads tuned_needle3_gpu.cact (fine-tuned model)         │
│  • Caches all files via Cache API                          │
│  • Runs inference: transcript → tool calls                 │
└─────────────────────────────────────────────────────────────┘
```

## Repository Structure

```
pwa-vti/
├── app/                    # PWA application (served by Netlify)
│   ├── index.html          # Main UI + speech recognition + worker wiring
│   ├── needle.worker.js    # Web Worker: loads Cactus + Needle, runs inference
│   ├── sw.js               # Service Worker for offline caching
│   ├── manifest.webmanifest # PWA manifest
│   ├── cactus.js           # Cactus Compute runtime (JS glue)
│   ├── cactus.wasm         # Cactus Compute runtime (WASM binary)
│   ├── tuned_needle3_gpu.cact # Fine-tuned Needle 3 model (~60MB, Git LFS)
│   ├── download-models.js  # Netlify build script: downloads base models
│   ├── netlify.toml        # Netlify config (publishes from app/)
│   └── icons/              # PWA icons
├── models/                 # Training artifacts (excluded from Netlify deploy)
│   ├── needle3.cact        # Base Needle 3 model
│   ├── tuned_needle3.cact  # Intermediate fine-tuned model
│   └── adapter.safetensors # LoRA adapter weights
├── training/               # Fine-tuning pipeline
│   ├── tools.json          # Tool schemas with regex triggers
│   ├── training_data.jsonl         # Seed examples (20-50 manual)
│   ├── training_data_augmented.jsonl # Generated examples (200 via LLM)
│   ├── training_data_full.jsonl    # Merged training set
│   ├── train_new_model.sh  # Training script (Linux/macOS)
│   └── train_new_model.ps1 # Training script (Windows)
├── checkpoints/            # Training checkpoints (Git LFS)
├── docs/                   # Documentation
│   ├── CLAUDE.md           # Project instructions for Claude Code
│   ├── NEEDLE3_TRAINING_METHODOLOGY.md # Complete fine-tuning methodology
│   └── TESTING_ANALYSIS.md # Iterative test results & failure analysis
└── README.md               # This file
```

## The Fine-Tuning Journey

### The Core Challenge
Needle 3 is a small model (~0.5B params). Teaching it to reliably:
1. **Select the correct tool** from 3 options
2. **Extract parameters** (amount) from natural language
3. **Handle compound commands** ("add 5 then subtract 2")
4. **Reject unsupported queries** ("What is the count?", "Set to 50")

### Key Breakthroughs

| Iteration | Problem | Solution |
|-----------|---------|----------|
| v1 | Single `modify(amount)` tool confused positive/negative | Separate `increment`/`decrement`/`reset` tools |
| v2 | Signed amounts still caused sign errors | **Positive-only parameters** — tools handle sign internally |
| v3 | Verb ambiguity ("decrease", "reduce", "take away") | **Explicit regex triggers** per tool with negative lookaheads |
| v4 | Limited training diversity | **LLM data augmentation** — 200 synthetic examples via Nemotron |
| v5 | Underfitting (30 epochs) | Extended to **100 epochs**, LoRA rank **32** |

### Final Tool Schema (tools.json)
```json
{
  "increment": {
    "triggers": ["add", "plus", "increase", "more", "higher", "count up", "^\\+\\d+"],
    "params": { "amount": { "type": "integer", "minimum": 1 } }
  },
  "decrement": {
    "triggers": ["subtract", "minus", "decrease", "less", "lower", "reduce", "take away", "^\\-\\d+"],
    "params": { "amount": { "type": "integer", "minimum": 1 } }
  },
  "reset": {
    "triggers": ["reset", "zero", "clear", "start over", "go back to zero"],
    "params": {}
  }
}
```

### Training Configuration
```bash
cactus finetune training_data_full.jsonl \
    --epochs 100 \
    --batch-size 16 \
    --lr 1e-4 \
    --lora-rank 32 \
    --lora-alpha 64 \
    --max-len 1024 \
    --val-split 0.1
```

## Running Locally

### Prerequisites
- Node.js 18+ (for Netlify CLI / static server)
- Python 3 (alternative static server)
- Git LFS (`git lfs install`)

### Option 1: Quick Test (downloads models automatically)
```bash
# Clone with LFS
git lfs install
git clone https://github.com/TeaCookie/pwa-vti.git
cd pwa-vti

# Download model files (~37MB)
node app/download-models.js

# Serve locally
npx serve app
# or
python -m http.server -d app 8000

# Open http://localhost:3000 (or 8000)
```

### Option 2: Netlify Dev (full production parity)
```bash
npm install -g netlify-cli
netlify dev
# Runs download-models.js at build time, serves from app/
```

## Training Your Own Model

```bash
cd training

# 1. Review tool schemas
cat tools.json

# 2. Add seed examples to training_data.jsonl (20-50 diverse examples)

# 3. Generate augmented data (requires OpenRouter API key)
cactus generate-data \
    --tools tools.json \
    --num-samples 200 \
    --model "nvidia/nemotron-3-ultra-550b-a55b:free" \
    --output training_data_augmented.jsonl

# 4. Merge datasets
cat training_data.jsonl training_data_augmented.jsonl > training_data_full.jsonl

# 5. Train (requires GPU with 8GB+ VRAM)
../train_new_model.sh

# 6. Merge LoRA adapter into base model
cactus build ../models/needle3.cact \
    --lora checkpoints/adapter_new.safetensors \
    --out ../app/tuned_needle3_gpu.cact

# 7. Update CHECKSUMS in needle.worker.js with new model hash
```

## Deployment (Netlify)

1. Push to GitHub
2. Connect repo to Netlify
3. Build command: `node app/download-models.js`
4. Publish directory: `app`
5. Netlify automatically runs the download script and deploys

**Note**: Model files are downloaded at build time (not committed to git, except `tuned_needle3_gpu.cact` which is tracked via Git LFS).

## Key Files for Understanding the Experiment

| File | Purpose |
|------|---------|
| `docs/NEEDLE3_TRAINING_METHODOLOGY.md` | Complete methodology — tool design, data gen, training, iteration loop |
| `docs/TESTING_ANALYSIS.md` | Per-command test results, failure categorization, root cause analysis |
| `training/tools.json` | Final tool schemas with regex triggers |
| `app/needle.worker.js` | Production inference pipeline (Cache API + Cactus + Needle) |
| `app/index.html` | Speech recognition + worker communication + UI |

## Generalization to Other Apps

This methodology applies to any on-device LLM tool calling scenario:

1. **Inventory actions** → Group by semantic intent
2. **Design non-overlapping tools** → Separate tools for separate semantics
3. **Write regex triggers** → Explicit patterns per tool, negative lookaheads for compounds
4. **Create seed data** → 20-50 high-quality examples covering all verbs
5. **Augment with LLM** → 5-10x synthetic examples via strong model
6. **Train with sufficient capacity** → LoRA rank 16-32, 50-100 epochs
7. **Test systematically** → Per-command accuracy, compound commands, edge cases
8. **Iterate on failures** → Analyze → Fix schema/data/hyperparams → Retrain

## Credits & References

- **Needle 3** — Cactus Compute's small LLM for tool calling
- **Cactus Compute** — WASM runtime for running LLMs in browser
- **Nemotron 3 Ultra** — NVIDIA model used for data augmentation (via OpenRouter)
- **Web Speech API** — Browser-native speech recognition

## License

MIT License — Feel free to use this methodology for your own on-device LLM projects.