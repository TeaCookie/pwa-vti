// download-models.js - Download Needle model files during Netlify build
// This script runs at build time to fetch model files from Hugging Face
// so they can be served from the same origin (avoiding CORS issues)

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Model files to download
const MODELS = [
  {
    name: 'cactus.js',
    url: 'https://huggingface.co/Cactus-Compute/cactus/resolve/1a028f5a3972b67dd8d8752f882113d475e7ec4c/releases/4.0.0/wasm/cactus.js',
    checksum: 'bb61bcf0c48712bfb9cd0ade8f0748889dfde9944ac308220f42afbc605f82bc',
    size: 63150
  },
  {
    name: 'cactus.wasm',
    url: 'https://huggingface.co/Cactus-Compute/cactus/resolve/1a028f5a3972b67dd8d8752f882113d475e7ec4c/releases/4.0.0/wasm/cactus.wasm',
    checksum: '4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6',
    size: 1241703
  },
  {
    name: 'needle3.cact',
    url: 'https://huggingface.co/Cactus-Compute/needle3/resolve/d6c7d6a2e9655505e0f8e23339356dd1705900eb/needle3.cact',
    checksum: 'c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38',
    size: 35335380
  }
];

async function downloadFile(model) {
  const filePath = path.join(__dirname, model.name);

  // Check if file already exists and has correct checksum
  if (fs.existsSync(filePath)) {
    const existingChecksum = await computeChecksum(filePath);
    if (existingChecksum === model.checksum) {
      console.log(`✓ ${model.name} already exists with correct checksum, skipping`);
      return true;
    }
    console.log(`⚠ ${model.name} exists but checksum mismatch, re-downloading`);
  }

  console.log(`⬇ Downloading ${model.name} (${(model.size / 1024 / 1024).toFixed(1)} MB)...`);

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    let downloaded = 0;
    const startTime = Date.now();

    https.get(model.url, (response) => {
      // Follow redirects
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
        if (response.headers.location) {
          file.close();
          fs.unlinkSync(filePath);
          downloadFile({ ...model, url: response.headers.location }).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(filePath);
        reject(new Error(`Failed to download ${model.name}: ${response.statusCode} ${response.statusMessage}`));
        return;
      }

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = (downloaded / 1024 / 1024 / elapsed).toFixed(1);
        const progress = ((downloaded / model.size) * 100).toFixed(1);
        process.stdout.write(`\r  ${progress}% (${speed} MB/s)`);
      });

      response.pipe(file);

      file.on('finish', async () => {
        file.close();
        process.stdout.write('\n');

        // Verify checksum
        const actualChecksum = await computeChecksum(filePath);
        if (actualChecksum !== model.checksum) {
          fs.unlinkSync(filePath);
          reject(new Error(`Checksum mismatch for ${model.name}: expected ${model.checksum}, got ${actualChecksum}`));
          return;
        }

        console.log(`✓ ${model.name} downloaded and verified`);
        resolve(true);
      });

      file.on('error', (err) => {
        file.close();
        fs.unlinkSync(filePath);
        reject(err);
      });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      reject(err);
    });
  });
}

async function computeChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function main() {
  console.log('=== Downloading Needle Model Files ===\n');

  try {
    for (const model of MODELS) {
      await downloadFile(model);
    }

    console.log('\n=== All model files downloaded successfully ===');

    // Verify all files exist
    for (const model of MODELS) {
      const filePath = path.join(__dirname, model.name);
      const stats = fs.statSync(filePath);
      console.log(`  ${model.name}: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
    }

    process.exit(0);
  } catch (err) {
    console.error('\n✗ Build failed:', err.message);
    process.exit(1);
  }
}

main();