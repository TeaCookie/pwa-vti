// needle.worker.js - Needle 3 in a Web Worker with Cache API caching
// Based on sandbox.worker.js from Cactus Compute demo

const CACHE_NAME = 'needle-v1';

// Pinned revisions from sandbox.worker.js
const ENGINE_BASE = 'https://huggingface.co/Cactus-Compute/cactus/resolve/1a028f5a3972b67dd8d8752f882113d475e7ec4c/releases/4.0.0/wasm';
const NEEDLE_BASE = 'https://huggingface.co/Cactus-Compute/needle3/resolve/d6c7d6a2e9655505e0f8e23339356dd1705900eb';

const RUNTIME_URL = `${ENGINE_BASE}/cactus.js`;
const WASM_URL = `${ENGINE_BASE}/cactus.wasm`;
const MODEL_URL = `${NEEDLE_BASE}/needle3.cact`;

// Checksums from sandbox.worker.js
const CHECKSUMS = {
  'cactus.js': 'bb61bcf0c48712bfb9cd0ade8f0748889dfde9944ac308220f42afbc605f82bc',
  'cactus.wasm': '4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6'
};

const CAPACITY = 1 << 18; // 262144 bytes for output buffer

let engine = null;
let outputPtr = 0;
let initialized = false;

function errorMessage(err) {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}\n${err.stack || ''}`;
  }
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return `Unknown error: ${JSON.stringify(err)}`;
}

function wrapError(context, fn) {
  try {
    return fn();
  } catch (err) {
    throw new Error(`${context}: ${errorMessage(err)}`);
  }
}

async function cachedFetch(url, checksum) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    const cloned = cached.clone();
    if (checksum) {
      const bytes = new Uint8Array(await cloned.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      if (actual === checksum) return cloned;
    } else {
      return cloned;
    }
  }

  // Explicit CORS mode for cross-origin requests to Hugging Face
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${response.statusText} - Check CORS headers on ${url}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  if (checksum) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    if (actual !== checksum) throw new Error('Runtime checksum mismatch');
  }

  const cachedResponse = new Response(bytes, {
    headers: { 'Access-Control-Allow-Origin': '*' }
  });
  await cache.put(url, cachedResponse.clone());
  return cachedResponse;
}

async function loadRuntime() {
  self.postMessage({ type: 'progress', stage: 'fetching runtime' });
  const [jsResponse, wasmResponse] = await wrapError('fetching runtime', () => Promise.all([
    cachedFetch(RUNTIME_URL, CHECKSUMS['cactus.js']),
    cachedFetch(WASM_URL, CHECKSUMS['cactus.wasm'])
  ]));

  self.postMessage({ type: 'progress', stage: 'reading runtime' });
  const source = await wrapError('reading cactus.js', () => jsResponse.text());
  const wasmBytes = await wrapError('reading cactus.wasm', () => wasmResponse.arrayBuffer());

  // Load cactus.js via importScripts (create blob URL)
  self.postMessage({ type: 'progress', stage: 'loading runtime' });
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  await wrapError('importScripts', () => {
    importScripts(url);
  });
  URL.revokeObjectURL(url);

  // Create engine instance (createCactus is global after importScripts)
  self.postMessage({ type: 'progress', stage: 'creating engine' });
  await wrapError('createCactus', () => {
    if (typeof createCactus !== 'function') {
      throw new Error('createCactus not found - importScripts may have failed');
    }
    engine = createCactus({ wasmBinary: wasmBytes });
    if (!engine) throw new Error('createCactus returned null/undefined');
  });

  // Allocate output buffer
  outputPtr = await wrapError('malloc output buffer', () => engine._malloc(CAPACITY));
  if (!outputPtr) throw new Error('Insufficient browser memory');

  // Request persistent storage
  if (navigator.storage && navigator.storage.persist) {
    try {
      await navigator.storage.persist();
      console.log('Persistent storage granted');
    } catch (e) {
      console.warn('Persistent storage request failed:', e);
    }
  }
}

async function loadModel() {
  self.postMessage({ type: 'progress', stage: 'fetching model' });
  const modelResponse = await wrapError('fetching model', () => cachedFetch(MODEL_URL));

  self.postMessage({ type: 'progress', stage: 'reading model' });
  const modelBytes = await wrapError('reading model bytes', () => {
    return new Uint8Array(await modelResponse.arrayBuffer());
  });
  self.postMessage({ type: 'progress', stage: 'loading model', size: modelBytes.length });

  const pointer = await wrapError('malloc model buffer', () => engine._malloc(modelBytes.length));
  if (!pointer) throw new Error('The model exceeds available browser memory');

  try {
    await wrapError('copying model to heap', () => {
      engine.HEAPU8.set(modelBytes, pointer);
    });
    self.postMessage({ type: 'progress', stage: 'initializing model' });
    await wrapError('cactus_load', () => {
      if (engine._cactus_load(pointer, BigInt(modelBytes.length)) < 0) {
        throw new Error('The model could not be loaded');
      }
    });
  } finally {
    engine._free(pointer);
  }
}

async function initializeNeedle(tools) {
  if (!engine) throw new Error('Runtime not loaded');

  await loadModel();

  // cactus_init("", tools_json_string, 0)
  const toolsJson = JSON.stringify(tools);
  await wrapError('cactus_init', () => {
    const result = engine.ccall('cactus_init', 'number', ['string', 'string', 'number'], ['', toolsJson, 0]);
    if (Number(result) < 0) throw new Error('The tools could not initialize');
  });

  initialized = true;
  self.postMessage({ type: 'ready' });
}

async function complete(text, id) {
  if (!initialized) throw new Error('Needle not initialized');

  // cactus_complete(text, 0, 0, 384, outputPtr, CAPACITY)
  await wrapError('cactus_complete', () => {
    const code = engine.ccall('cactus_complete', 'number', ['string', 'number', 'number', 'number', 'number', 'number'], [text, 0, 0, 384, outputPtr, CAPACITY]);
    if (code < 0) throw new Error('Inference failed');
  });

  const output = await wrapError('UTF8ToString', () => engine.UTF8ToString(outputPtr));
  self.postMessage({ type: 'result', id, output });
}

self.onmessage = async (e) => {
  const { type, tools, text, id } = e.data;

  try {
    switch (type) {
      case 'load':
        await loadRuntime();
        self.postMessage({ type: 'loaded' });
        break;
      case 'init':
        await initializeNeedle(tools);
        break;
      case 'complete':
        await complete(text, id);
        break;
      default:
        throw new Error('Unknown message type: ' + type);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: errorMessage(err) });
  }
};

// Start loading runtime immediately
loadRuntime().catch((err) => {
  self.postMessage({ type: 'error', message: 'Load failed: ' + errorMessage(err) });
});