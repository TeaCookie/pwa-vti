// needle.worker.js - Needle 3 in a Web Worker with Cache API caching
// Loads model and runtime from local files (same origin) for Netlify compatibility
// DEBUG: Enhanced logging to trace loading issues

const CACHE_NAME = 'needle-v1';

// Local file paths - served from same origin to avoid CORS issues
const RUNTIME_URL = './cactus.js';
const WASM_URL = './cactus.wasm';
const MODEL_URL = './tuned_needle3_gpu.cact';

// Checksums for integrity verification (SHA-256)
const CHECKSUMS = {
  'cactus.js': 'bb61bcf0c48712bfb9cd0ade8f0748889dfde9944ac308220f42afbc605f82bc',
  'cactus.wasm': '4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6',
  'tuned_needle3_gpu.cact': '4460a6deed695a283f38f11797ac7f61d2903fadf9a2ac4b1dda8464337c864c'
};

const CAPACITY = 1 << 18; // 262144 bytes for output buffer

let engine = null;
let outputPtr = 0;
let initialized = false;

function log(msg, data = null) {
  self.postMessage({ type: 'debug', message: msg, data });
}

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
    log(`ERROR in ${context}: ${errorMessage(err)}`);
    throw new Error(`${context}: ${errorMessage(err)}`);
  }
}

async function cachedFetch(url, checksum) {
  log(`cachedFetch: ${url}`);
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    log(`  cache HIT: ${url}`);
    const cloned = cached.clone();
    if (checksum) {
      const bytes = new Uint8Array(await cloned.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      if (actual === checksum) {
        log(`  checksum OK: ${url}`);
        return cloned;
      }
      log(`  checksum MISMATCH: ${url} (expected ${checksum}, got ${actual})`);
      // Checksum mismatch - fall through to re-fetch
    } else {
      return cloned;
    }
  }

  log(`  cache MISS: ${url}, fetching...`);
  // Same-origin fetch (no CORS needed)
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${response.statusText} - ${url}`);
  }

  // Read the response body FIRST (consumes the stream)
  const bytes = new Uint8Array(await response.arrayBuffer());
  log(`  downloaded ${bytes.length} bytes from ${url}`);

  if (checksum) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    if (actual !== checksum) throw new Error(`Checksum mismatch for ${url}: expected ${checksum}, got ${actual}`);
    log(`  checksum OK after download: ${url}`);
  }

  // Create TWO new Response objects from the bytes - one for return, one for cache
  // This avoids the "body stream already read" issue with cloned Responses
  const responseForReturn = new Response(bytes.slice()); // slice() creates a copy
  const cachedResponse = new Response(bytes);
  await cache.put(url, cachedResponse);
  log(`  cached: ${url}`);

  // Return a fresh Response from the bytes
  return responseForReturn;
}

async function loadRuntime() {
  log('=== loadRuntime START ===');
  self.postMessage({ type: 'progress', stage: 'fetching runtime' });

  log('fetching runtime files...');
  const [jsResponse, wasmResponse] = await wrapError('fetching runtime', () => Promise.all([
    cachedFetch(RUNTIME_URL, CHECKSUMS['cactus.js']),
    cachedFetch(WASM_URL, CHECKSUMS['cactus.wasm'])
  ]));
  log('runtime files fetched successfully');

  self.postMessage({ type: 'progress', stage: 'reading runtime' });
  log('reading cactus.js text...');
  const source = await wrapError('reading cactus.js', () => jsResponse.text());
  log(`  cactus.js length: ${source.length} chars`);
  log(`  cactus.js first 200 chars: ${source.substring(0, 200)}`);
  log(`  cactus.js last 200 chars: ${source.substring(source.length - 200)}`);

  log('reading cactus.wasm bytes...');
  const wasmBytes = await wrapError('reading cactus.wasm', () => wasmResponse.arrayBuffer());
  log(`  cactus.wasm size: ${wasmBytes.byteLength} bytes`);

  // Load cactus.js via importScripts (create blob URL)
  self.postMessage({ type: 'progress', stage: 'loading runtime' });
  log('creating blob URL for cactus.js...');
  const blob = new Blob([source], { type: 'text/javascript' });
  log(`  blob size: ${blob.size}, type: ${blob.type}`);
  const blobUrl = URL.createObjectURL(blob);
  log(`  blob URL: ${blobUrl}`);

  log('calling importScripts...');
  await wrapError('importScripts', () => {
    importScripts(blobUrl);
  });
  log('importScripts completed successfully');
  URL.revokeObjectURL(blobUrl);
  log('blob URL revoked');

  // Create engine instance (createCactus is global after importScripts)
  self.postMessage({ type: 'progress', stage: 'creating engine' });
  log('checking if createCactus is available...');
  await wrapError('createCactus', async () => {
    log(`  typeof createCactus: ${typeof createCactus}`);
    if (typeof createCactus !== 'function') {
      throw new Error('createCactus not found - importScripts may have failed');
    }
    log('  calling createCactus with wasmBinary...');
    engine = await createCactus({ wasmBinary: wasmBytes });
    log(`  engine created: ${!!engine}`);
    if (!engine) throw new Error('createCactus returned null/undefined');
  });
  log('engine creation successful');

  // Allocate output buffer
  log('allocating output buffer...');
  outputPtr = await wrapError('malloc output buffer', () => engine._malloc(CAPACITY));
  log(`  outputPtr: ${outputPtr}`);
  if (!outputPtr) throw new Error('Insufficient browser memory');

  // Request persistent storage
  if (navigator.storage && navigator.storage.persist) {
    try {
      await navigator.storage.persist();
      log('Persistent storage granted');
    } catch (e) {
      log(`Persistent storage request failed: ${e}`);
    }
  }
  log('=== loadRuntime COMPLETE ===');
}

async function loadModel() {
  log('=== loadModel START ===');
  self.postMessage({ type: 'progress', stage: 'fetching model' });
  log('fetching model...');
  const modelResponse = await wrapError('fetching model', () => cachedFetch(MODEL_URL, CHECKSUMS['tuned_needle3_gpu.cact']));
  log('model fetched successfully');

  self.postMessage({ type: 'progress', stage: 'reading model' });
  log('reading model bytes...');
  const modelBytes = await wrapError('reading model bytes', async () => {
    return new Uint8Array(await modelResponse.arrayBuffer());
  });
  log(`  modelBytes length: ${modelBytes.length}`);
  self.postMessage({ type: 'progress', stage: 'loading model', size: modelBytes.length });

  log('allocating model buffer...');
  const pointer = await wrapError('malloc model buffer', () => engine._malloc(modelBytes.length));
  log(`  model pointer: ${pointer}`);
  if (!pointer) throw new Error('The model exceeds available browser memory');

  try {
    log('copying model to heap...');
    await wrapError('copying model to heap', () => {
      engine.HEAPU8.set(modelBytes, pointer);
    });
    log('model copied to heap');

    self.postMessage({ type: 'progress', stage: 'initializing model' });
    log('calling cactus_load...');
    await wrapError('cactus_load', () => {
      const loadResult = engine._cactus_load(pointer, BigInt(modelBytes.length));
      log(`  cactus_load result: ${loadResult}`);
      if (loadResult < 0) {
        throw new Error('The model could not be loaded');
      }
    });
    log('cactus_load successful');
  } finally {
    log('freeing model buffer...');
    engine._free(pointer);
  }
  log('=== loadModel COMPLETE ===');
}

async function initializeNeedle(tools) {
  log('=== initializeNeedle START ===');
  if (!engine) throw new Error('Runtime not loaded');

  await loadModel();

  // cactus_init("", tools_json_string, 0)
  const toolsJson = JSON.stringify(tools);
  log(`initializing tools: ${toolsJson}`);
  await wrapError('cactus_init', () => {
    const result = engine.ccall('cactus_init', 'number', ['string', 'string', 'number'], ['', toolsJson, 0]);
    log(`  cactus_init result: ${result}`);
    if (Number(result) < 0) throw new Error('The tools could not initialize');
  });

  initialized = true;
  log('=== initializeNeedle COMPLETE - sending ready ===');
  self.postMessage({ type: 'ready' });
}

async function complete(text, id) {
  log(`=== complete START: "${text}" (id: ${id}) ===`);
  if (!initialized) throw new Error('Needle not initialized');

  // Reset model state to ensure each command is independent (no conversation context)
  try {
    log('  Calling cactus_reset...');
    const resetCode = engine._cactus_reset();
    log(`  cactus_reset code: ${resetCode}`);
    if (resetCode < 0) {
      log(`  WARNING: cactus_reset returned ${resetCode}, continuing anyway`);
    }
  } catch (resetErr) {
    log(`  WARNING: cactus_reset failed: ${resetErr.message}, continuing anyway`);
  }

  // cactus_complete(text, 0, 0, 384, outputPtr, CAPACITY)
  await wrapError('cactus_complete', () => {
    const code = engine.ccall('cactus_complete', 'number', ['string', 'number', 'number', 'number', 'number', 'number'], [text, 0, 0, 384, outputPtr, CAPACITY]);
    log(`  cactus_complete code: ${code}`);
    if (code < 0) throw new Error('Inference failed');
  });

  const output = await wrapError('UTF8ToString', () => engine.UTF8ToString(outputPtr));
  log(`  output: ${output}`);
  self.postMessage({ type: 'result', id, output });
  log('=== complete END ===');
}

self.onmessage = async (e) => {
  const { type, tools, text, id } = e.data;
  log(`onmessage received: ${type}`, { type, tools, text, id });

  try {
    switch (type) {
      case 'load':
        log('handling load message');
        await loadRuntime();
        log('loadRuntime complete, sending loaded message');
        self.postMessage({ type: 'loaded' });
        break;
      case 'init':
        log('handling init message, tools:', tools);
        await initializeNeedle(tools);
        break;
      case 'complete':
        log('handling complete message');
        await complete(text, id);
        break;
      default:
        throw new Error('Unknown message type: ' + type);
    }
  } catch (err) {
    log(`onmessage ERROR: ${errorMessage(err)}`);
    self.postMessage({ type: 'error', message: errorMessage(err) });
  }
};

// Start loading runtime immediately
log('Starting initial loadRuntime...');
loadRuntime().then(() => {
  log('Initial loadRuntime complete, sending loaded message');
  self.postMessage({ type: 'loaded' });
}).catch((err) => {
  log(`Initial loadRuntime FAILED: ${errorMessage(err)}`);
  self.postMessage({ type: 'error', message: 'Load failed: ' + errorMessage(err) });
});