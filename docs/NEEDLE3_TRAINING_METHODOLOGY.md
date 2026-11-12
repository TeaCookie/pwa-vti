# Needle 3 Fine-Tuning Methodology for Voice Counter PWA

This document outlines the complete methodology used to fine-tune the Needle 3 model for reliable voice-controlled counter operations. The approach can be generalized to other applications needing on-device LLM tool calling.

---

## Overview

The Voice Counter PWA uses Needle 3 (a small LLM) running in a Web Worker via Cactus Compute's WASM runtime for on-device inference. The model needed to reliably interpret voice commands (speech-to-text transcripts) and call the appropriate tool functions: `increment`, `decrement`, and `reset`.

---

## Phase 1: Function Analysis & Tool Schema Design

### 1.1 Scan App Functions

**Methodology:**
- Inventory all user-facing actions in the application
- For the Voice Counter: `add`, `subtract`, `reset` (and voice variants: plus, minus, increase, decrease, etc.)
- Group by semantic intent (positive change, negative change, state reset)

**Generalization for Other Apps:**
```
For any app:
1. List all user actions (buttons, menu items, voice commands, API endpoints)
2. Group by semantic category (CRUD operations, navigation, settings, etc.)
3. Identify which actions need LLM tool calling vs. direct UI handling
4. Design tool schemas with clear, non-overlapping responsibilities
```

### 1.2 Design Tool Schemas (Iterative Evolution)

**Version 1: Single `modify` Tool (Failed)**
```json
{
  "name": "modify",
  "description": "Change counter by positive or negative amount",
  "parameters": { "amount": { "type": "number" } }
}
```
**Problem:** Model confused positive/negative semantics, especially for "decrease", "reduce", "take away"

**Version 2: Two Tools - `increment`/`decrement` with Signed Amounts (Partial Success)**
```json
{
  "name": "increment",
  "description": "Increase counter by positive amount",
  "parameters": { "amount": { "type": "integer", "minimum": 1 } }
}
{
  "name": "decrement", 
  "description": "Decrease counter by positive amount (internally applies negative)",
  "parameters": { "amount": { "type": "integer", "minimum": 1 } }
}
```
**Improvement:** Separated semantics, but trigger patterns still overlapped

**Version 3: Three Tools with Explicit Triggers (Final - Success)**
```json
{
  "name": "increment",
  "description": "Increase counter. Use for: add, plus, increase, more, higher, count up.",
  "parameters": { "amount": { "type": "integer", "minimum": 1 } },
  "triggers": [
    "^(?!.*\\b(and|then|also)\\b).*\\b(add|plus|increase|more|higher|count up)\\b.*\\d+",
    "^\\+\\s*\\d+"
  ]
}
{
  "name": "decrement",
  "description": "Decrease counter. Use for: subtract, minus, decrease, less, lower, reduce, take away.",
  "parameters": { "amount": { "type": "integer", "minimum": 1 } },
  "triggers": [
    "^(?!.*\\b(and|then|also)\\b).*\\b(subtract|minus|decrease|less|lower|reduce|take away)\\b.*\\d+",
    "^\\-\\s*\\d+"
  ]
}
{
  "name": "reset",
  "description": "Reset counter to zero.",
  "parameters": {},
  "triggers": [
    "^(?!.*\\b(and|then|also)\\b).*\\b(reset|zero|clear|start over|go back to zero)\\b"
  ]
}
```

**Key Design Principles:**
| Principle | Implementation |
|-----------|----------------|
| **Semantic Separation** | Positive/negative operations in distinct tools |
| **Positive-Only Parameters** | Both increment/decrement take positive amounts; tool handles sign internally |
| **Explicit Triggers** | Regex patterns per tool prevent ambiguity |
| **Compound Command Exclusion** | Negative lookahead `(?!.*\b(and|then|also)\b)` prevents partial matches in multi-step commands |
| **Comprehensive Verb Coverage** | Include all voice recognition variants (speech-to-text produces "plus", "add", "increase", etc.) |

---

## Phase 2: Training Data Generation with `--generate` Flag

### 2.1 Base Training Data (Manual Curation)

Create initial `training_data.jsonl` with high-quality, diverse examples covering:
- Basic commands: "add 5", "subtract 3", "reset"
- Voice variants: "plus five", "minus three", "clear"
- Compound commands: "add 5 and then subtract 2"
- Word numbers: "add five", "subtract three"
- Edge cases: "What is the count?" (no tool), "Set to 50" (unsupported)

**Format:** JSONL with `query`, `reasoning`, `answers` (tool calls), `tools` (schema)

### 2.2 Augmented Data Generation

**Command:**
```bash
cactus generate-data \
    --tools tools.json \
    --num-samples 200 \
    --batch-size 25 \
    --workers 8 \
    --model "nvidia/nemotron-3-ultra-550b-a55b:free" \
    --output training_data_augmented.jsonl
```

**Parameters Explained:**
| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `--num-samples` | 200 | 10x base data; enough diversity without overfitting |
| `--batch-size` | 25 | Balance API rate limits and throughput |
| `--workers` | 8 | Parallel generation for speed |
| `--model` | nemotron-3-ultra | Strong reasoning model for quality examples |

**Generalization:**
```
For any app:
1. Define tool schemas in tools.json with triggers
2. Create 20-50 high-quality seed examples (training_data.jsonl)
3. Run cactus generate-data with 5-10x multiplier
4. Review generated data for quality (spot-check 10-20 examples)
5. Merge: cat training_data.jsonl training_data_augmented.jsonl > training_data_full.jsonl
```

### 2.3 Data Augmentation Best Practices

1. **Include negative examples** - Queries that should NOT trigger tools
2. **Cover edge cases** - Zero amounts, unsupported operations, compound commands
3. **Balance tool distribution** - Ensure all tools have adequate examples
4. **Add word-number variants** - Speech recognition outputs words, not digits
5. **Test compound commands** - "add 5 then subtract 2" → two tool calls

---

## Phase 3: Fine-Tuning Configuration

### 3.1 Training Command

```bash
cactus finetune training_data_full.jsonl \
    --epochs 100 \
    --batch-size 16 \
    --lr 1e-4 \
    --lora-rank 32 \
    --lora-alpha 64 \
    --max-len 1024 \
    --val-split 0.1 \
    --seed 42 \
    --checkpoint-dir checkpoints \
    --out checkpoints/adapter_new.safetensors
```

### 3.2 Hyperparameter Reasoning

| Parameter | Value | Reasoning |
|-----------|-------|-----------|
| `--epochs` | 100 | Extended training for complex tool calling; early stopping via val loss |
| `--batch-size` | 16 | Fits GPU memory (RTX 3060 12GB); larger = more stable gradients |
| `--lr` | 1e-4 | Standard LoRA learning rate; lower than full fine-tune |
| `--lora-rank` | 32 | Higher rank for complex reasoning; 16 was insufficient |
| `--lora-alpha` | 64 | Alpha = 2x rank; standard scaling for LoRA |
| `--max-len` | 1024 | Covers full context (query + tools schema + reasoning + answers) |
| `--val-split` | 0.1 | 10% validation for early stopping monitoring |
| `--seed` | 42 | Reproducibility |

### 3.3 LoRA Configuration Deep Dive

**Why LoRA (Low-Rank Adaptation)?**
- Needle 3 is ~35MB; full fine-tune requires massive compute
- LoRA adds ~0.5% trainable parameters
- Preserves base model knowledge while adapting to tool calling

**Rank Selection (32):**
- Rank 8-16: Insufficient for multi-tool reasoning
- Rank 32: Sweet spot for 3-tool schema with triggers
- Rank 64+: Diminishing returns, overfitting risk

**Alpha Selection (64):**
- Standard practice: alpha = 2 × rank
- Controls LoRA scaling; higher = more adaptation

### 3.4 Model Building (Merge LoRA)

```bash
cactus build checkpoints/needle3.safetensors \
    --lora checkpoints/adapter_new.safetensors \
    --out tuned_needle3_gpu.cact
```

Creates deployable `.cact` model with merged weights.

---

## Phase 4: Iterative Analysis & Optimization Loop

### 4.1 Testing Protocol

After each training run, systematically test:

```markdown
## Test Cases (Run in Order)
1. `add 5`              → amount: +5
2. `subtract 3`         → amount: -3
3. `decrease by 5`      → amount: -5  (CRITICAL - was broken)
4. `reduce by 3`        → amount: -3  (CRITICAL - was broken)
5. `take away 2`        → amount: -2  (was triggering reset)
6. `plus 4`             → amount: +4
7. `minus 1`            → amount: -1
8. `reset`              → reset tool
9. `add 5 and subtract 2` → +5, -2 (compound)
10. `increase by 10 then decrease by 2` → +10, -2
11. `reset then add 5`  → reset, +5
12. `What is count?`    → no tool (query)
13. `Set to 50`         → no tool (unsupported)
```

### 4.2 Analysis Framework (TESTING_ANALYSIS.md Pattern)

Document every test run with:

| Category | Command | Expected | Actual | Status | Notes |
|----------|---------|----------|--------|--------|-------|
| Working | add 5 | +5 | +5 | ✅ | |
| Broken | decrease by 5 | -5 | +5 | ❌ | Wrong sign |
| Regression | take away 2 | -2 | reset | ❌ | Trigger confusion |

**Key Metrics to Track:**
- Per-command accuracy (not just overall)
- Sign correctness for negative verbs
- Compound command handling
- Context independence (each command isolated)
- False positive rate (queries triggering tools incorrectly)

### 4.3 Root Cause Analysis Process

When errors found:

1. **Categorize error type:**
   - Wrong tool called (semantic confusion)
   - Wrong sign (positive/negative inversion)
   - Missing tool call (should have triggered)
   - Extra tool call (false positive)

2. **Check training data coverage:**
   - Are there examples for this verb/pattern?
   - Are negative examples sufficient?
   - Do triggers match the speech-to-text output?

3. **Analyze trigger patterns:**
   - Do regex patterns overlap?
   - Are negative lookaheads working?
   - Does speech recognition output match triggers?

4. **Check model capacity:**
   - Is LoRA rank sufficient?
   - Is training converging (val loss decreasing)?

### 4.4 Optimization Loop

**Iteration 1 → 2 (30 epochs → 100 epochs):**
- Problem: Insufficient training for complex patterns
- Fix: Extended epochs, added more negative verb examples

**Iteration 2 → 3 (Single modify → Three tools):**
- Problem: Fundamental semantic confusion in single tool
- Fix: Architectural redesign - separate tools for separate semantics

**Iteration 3 (Data augmentation):**
- Problem: Limited diversity in manual examples
- Fix: `cactus generate-data --num-samples 200` for synthetic diversity

**Each iteration:**
1. Diagnose specific failure modes
2. Modify tool schemas / training data / hyperparameters
3. Retrain
4. Run full test suite
5. Document results in TESTING_ANALYSIS.md

---

## Phase 5: Deployment & Verification

### 5.1 Model Checksum & Integration

```bash
# Calculate checksum for needle.worker.js
python3 -c "
import hashlib
with open('tuned_needle3_gpu.cact', 'rb') as f:
    print(hashlib.sha256(f.read()).hexdigest())
"
```

Update `needle.worker.js` CHECKSUMS object and bump service worker cache version.

### 5.2 Production Testing Checklist

- [ ] All 13 test cases pass
- [ ] Context independence verified (no command history leakage)
- [ ] Speech recognition variants tested (accent, noise, speed)
- [ ] Offline functionality works (model cached)
- [ ] Model loads within acceptable time (<3s on mobile)
- [ ] Memory usage acceptable (<100MB WASM heap)

---

## Generalization Checklist for Other Apps

### App Analysis Phase
- [ ] Inventory all user actions
- [ ] Group by semantic intent
- [ ] Design non-overlapping tool schemas
- [ ] Write regex triggers for each tool
- [ ] Create 20-50 seed training examples

### Data Generation Phase
- [ ] Define tools.json with triggers
- [ ] Run `cactus generate-data` with 5-10x multiplier
- [ ] Review and merge augmented data
- [ ] Add negative examples (queries that shouldn't trigger tools)

### Training Phase
- [ ] Start with conservative hyperparameters (epochs=30, rank=16)
- [ ] Monitor val loss for early stopping
- [ ] Increase epochs/rank if underfitting
- [ ] Decrease LR if unstable

### Evaluation Phase
- [ ] Create systematic test suite covering all verbs/patterns
- [ ] Test compound commands
- [ ] Test edge cases (unsupported queries)
- [ ] Document failures in analysis template
- [ ] Iterate until >95% accuracy on critical commands

### Deployment Phase
- [ ] Verify model checksum
- [ ] Update service worker cache
- [ ] Test on target devices (mobile, desktop)
- [ ] Monitor production error rates

---

## Key Learnings & Anti-Patterns

### ✅ What Worked
1. **Separate tools for separate semantics** - increment vs decrement vs reset
2. **Positive-only parameters** - model doesn't need to learn sign logic
3. **Explicit regex triggers** - eliminates ambiguity in tool selection
4. **Data augmentation via strong LLM** - 200 synthetic examples dramatically improved coverage
5. **Extended training (100 epochs)** - complex tool calling needs more epochs than classification
6. **Higher LoRA rank (32)** - multi-tool reasoning needs capacity
7. **Systematic testing with documentation** - TESTING_ANALYSIS.md enabled targeted fixes

### ❌ What Didn't Work
1. **Single tool with signed amounts** - fundamental semantic confusion
2. **Insufficient negative verb examples** - "decrease", "reduce", "take away" underrepresented
3. **Low LoRA rank (8-16)** - couldn't capture tool selection logic
4. **Short training (30 epochs)** - val loss still decreasing at epoch 30
5. **No compound command training** - model couldn't handle multi-step commands
6. **Missing negative examples** - model hallucinated tool calls for queries

### 🔄 Recommended Defaults for New Projects

| Setting | Default | Adjust If |
|---------|---------|-----------|
| Base epochs | 50 | Val loss still dropping → increase to 100 |
| LoRA rank | 16 | >3 tools or complex reasoning → 32 |
| LoRA alpha | 32 | Rank changed → 2× rank |
| Batch size | 16 | OOM → 8; large GPU → 32 |
| Learning rate | 1e-4 | Unstable → 5e-5; slow → 2e-4 |
| Augmentation | 5-10x | Simple domain → 3x; complex → 20x |

---

## Files Reference

| File | Purpose |
|------|---------|
| `tools.json` | Tool schemas with triggers |
| `training_data.jsonl` | Manual seed examples (20-50) |
| `training_data_augmented.jsonl` | Generated examples (200) |
| `training_data_full.jsonl` | Merged training set |
| `train_new_model.sh` | Complete training pipeline |
| `TESTING_ANALYSIS.md` | Failure analysis & test results |
| `needle.worker.js` | Model loading + inference |
| `tuned_needle3_gpu.cact` | Deployable merged model |

---

## Conclusion

The methodology combines:
1. **Architectural clarity** in tool design (separate semantics → separate tools)
2. **Data-driven augmentation** (LLM-generated diverse examples)
3. **Sufficient model capacity** (LoRA rank 32, 100 epochs)
4. **Rigorous iterative testing** (documented analysis → targeted fixes)

This approach generalizes to any application needing reliable on-device LLM tool calling: voice assistants, chatbots, automation agents, or any interface where natural language maps to discrete actions.