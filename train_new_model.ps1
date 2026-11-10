#!/usr/bin/env pwsh
# Complete training script for new Needle 3 model with redesigned tools
# Run this in WSL2 (or PowerShell with WSL)

Write-Host "=========================================="
Write-Host "Needle 3 Model Training - Complete Redo"
Write-Host "=========================================="

# Navigate to project directory
cd C:\Users\Basic\Documents\GitHub\pwa-vti

Write-Host ""
Write-Host "Step 1: Verify training data and tools..."
if (-not (Test-Path "training_data.jsonl")) {
    Write-Error "ERROR: training_data.jsonl not found!"
    exit 1
}
if (-not (Test-Path "tools.json")) {
    Write-Error "ERROR: tools.json not found!"
    exit 1
}
Write-Host "✓ Files present"

$exampleCount = (Get-Content training_data.jsonl).Count
Write-Host "Current training examples: $exampleCount"

Write-Host ""
Write-Host "Step 2: Generate augmented training data using OpenRouter..."
Write-Host "This will generate 200 additional diverse examples from tool schemas..."

# Generate augmented data using the new tools.json
cactus generate-data \
    --tools tools.json \
    --num-samples 200 \
    --batch-size 25 \
    --workers 2 \
    --model "meta-llama/llama-3.3-70b-instruct:free" \
    --output training_data_augmented.jsonl

Write-Host "✓ Generated augmented data"

# Merge original + augmented
Get-Content training_data.jsonl, training_data_augmented.jsonl | Set-Content training_data_full.jsonl
$fullCount = (Get-Content training_data_full.jsonl).Count
Write-Host "Total training examples after augmentation: $fullCount"

Write-Host ""
Write-Host "Step 3: Train LoRA adapter (long run - 100 epochs)..."
Write-Host "This will take a while. Coffee time ☕"

cactus finetune training_data_full.jsonl `
    --epochs 100 `
    --batch-size 16 `
    --lr 1e-4 `
    --lora-rank 32 `
    --lora-alpha 64 `
    --max-len 1024 `
    --val-split 0.1 `
    --seed 42 `
    --checkpoint-dir checkpoints `
    --out checkpoints/adapter_new.safetensors

Write-Host "✓ LoRA adapter trained"

Write-Host ""
Write-Host "Step 4: Build merged model (.cact)..."
cactus build checkpoints/needle3.safetensors `
    --lora checkpoints/adapter_new.safetensors `
    --out tuned_needle3_gpu.cact

Write-Host "✓ Merged model created: tuned_needle3_gpu.cact"

Write-Host ""
Write-Host "Step 5: Copy to Windows project and calculate checksum..."
Copy-Item tuned_needle3_gpu.cact -Destination .

# Calculate new checksum
$sha256 = Get-FileHash tuned_needle3_gpu.cact -Algorithm SHA256
$sizeMB = (Get-Item tuned_needle3_gpu.cact).Length / 1MB
Write-Host "SHA-256: $($sha256.Hash)"
Write-Host "Size: $([math]::Round($sizeMB, 1)) MB"

Write-Host ""
Write-Host "=========================================="
Write-Host "Training complete! Next steps:"
Write-Host "=========================================="
Write-Host "1. Update needle.worker.js CHECKSUMS with the new SHA-256 above"
Write-Host "2. Bump sw.js cache version (CACHE_NAME = 'voice-counter-v8')"
Write-Host "3. Hard refresh browser (Ctrl+Shift+R) and test"
Write-Host ""
Write-Host "Test commands:"
Write-Host "  'decrease by 5'  → should give amount: -5"
Write-Host "  'reduce by 3'    → should give amount: -3"
Write-Host "  'take away 2'    → should give amount: -2"
Write-Host "  'add 5'          → should give amount: +5"
Write-Host "  'reset'          → should reset to 0"
Write-Host ""
Write-Host "Training run complete! 🎉"