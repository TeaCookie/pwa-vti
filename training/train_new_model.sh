#!/bin/bash
# Complete training script for new Needle 3 model with redesigned tools
# Run this in WSL2

set -e  # Exit on error

echo "=========================================="
echo "Needle 3 Model Training - Complete Redo"
echo "=========================================="

# Navigate to project directory
cd /mnt/c/Users/Basic/Documents/GitHub/pwa-vti

echo ""
echo "Step 1: Verify training data and tools..."
if [ ! -f "training_data.jsonl" ]; then
    echo "ERROR: training_data.jsonl not found!"
    exit 1
fi
if [ ! -f "tools.json" ]; then
    echo "ERROR: tools.json not found!"
    exit 1
fi
echo "✓ Files present"

# Count current training examples
EXAMPLE_COUNT=$(wc -l < training_data.jsonl)
echo "Current training examples: $EXAMPLE_COUNT"

echo ""
echo "Step 2: Generate augmented training data using OpenRouter..."
echo "This will generate 200 additional diverse examples from tool schemas..."

# Generate augmented data using the new tools.json
cactus generate-data \
    --tools tools.json \
    --num-samples 200 \
    --batch-size 25 \
    --workers 8 \
    --model "nvidia/nemotron-3-ultra-550b-a55b:free" \
    --output training_data_augmented.jsonl

echo "✓ Generated augmented data"

# Merge original + augmented
cat training_data.jsonl training_data_augmented.jsonl > training_data_full.jsonl
FULL_COUNT=$(wc -l < training_data_full.jsonl)
echo "Total training examples after augmentation: $FULL_COUNT"

echo ""
echo "Step 3: Train LoRA adapter (long run - 100 epochs)..."
echo "This will take a while. Coffee time ☕"

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

echo "✓ LoRA adapter trained"

echo ""
echo "Step 4: Build merged model (.cact)..."
cactus build checkpoints/needle3.safetensors \
    --lora checkpoints/adapter_new.safetensors \
    --out tuned_needle3_gpu.cact

echo "✓ Merged model created: tuned_needle3_gpu.cact"

echo ""
echo "Step 5: Copy to Windows project and update checksum..."
cp tuned_needle3_gpu.cact /mnt/c/Users/Basic/Documents/GitHub/pwa-vti/

# Calculate new checksum
python3 -c "
import hashlib
with open('tuned_needle3_gpu.cact', 'rb') as f:
    sha256 = hashlib.sha256(f.read()).hexdigest()
    print(f'SHA-256: {sha256}')
    print(f'Size: {len(open(\"tuned_needle3_gpu.cact\", \"rb\").read()) / 1024 / 1024:.1f} MB')
"

echo ""
echo "=========================================="
echo "Training complete! Next steps:"
echo "=========================================="
echo "1. Update needle.worker.js CHECKSUMS with the new SHA-256 above"
echo "2. Bump sw.js cache version (CACHE_NAME = 'voice-counter-v8')"
echo "3. Hard refresh browser (Ctrl+Shift+R) and test"
echo ""
echo "Test commands:"
echo "  'decrease by 5'  → should give amount: -5"
echo "  'reduce by 3'    → should give amount: -3"
echo "  'take away 2'    → should give amount: -2"
echo "  'add 5'          → should give amount: +5"
echo "  'reset'          → should reset to 0"
echo ""
echo "Training run complete! 🎉"
