/**
 * stem-queue.js — FIFO queue manager for stem separation jobs.
 * Loaded in offscreen.js. Processes one job at a time.
 *
 * Model: htdemucs.ort.gz from https://bucket.freemusicdemixer.com/
 * WASM: demucs_onnx_simd.js + demucs_onnx_simd.wasm (from free-music-demixer)
 */

const MODEL_VERSION = 'htdemucs-free-4s';
const MODEL_URL = chrome.runtime.getURL('htdemucs.ort.gz');
const MAX_CACHE_BYTES = 500 * 1024 * 1024; // 500 MB

class StemQueue {
    constructor() {
        this.processing = false;
        this.worker = null;
        this.currentJobId = null;
    }

    /** Send status back to background.js → popup.js */
    _notify(msg) {
        chrome.runtime.sendMessage({ target: 'background', ...msg });
    }

    /** Ensure model weights are downloaded, decompressed, and cached */
    async _ensureModel() {
        let model = await StemDB.getModel(MODEL_VERSION);
        if (model) return model.weights;

        this._notify({ type: 'stem-progress', progress: 0, stage: 'loading' });

        const response = await fetch(MODEL_URL);
        if (!response.ok) throw new Error(`Model load failed: ${response.status}`);

        const contentLength = +response.headers.get('Content-Length') || 0;

        // Stream download with progress
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (contentLength > 0) {
                this._notify({
                    type: 'stem-progress',
                    progress: (received / contentLength) * 0.8,
                    stage: 'loading'
                });
            }
        }

        // Combine chunks
        const compressed = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            compressed.set(chunk, offset);
            offset += chunk.length;
        }

        // Decompress gzip — the model file is .ort.gz
        this._notify({ type: 'stem-progress', progress: 0.85, stage: 'loading' });
        let weights;
        try {
            const ds = new DecompressionStream('gzip');
            const writer = ds.writable.getWriter();
            const readStream = ds.readable.getReader();
            writer.write(compressed);
            writer.close();

            const decompressedChunks = [];
            while (true) {
                const { done, value } = await readStream.read();
                if (done) break;
                decompressedChunks.push(value);
            }
            let totalLen = decompressedChunks.reduce((s, c) => s + c.length, 0);
            weights = new Uint8Array(totalLen);
            let off = 0;
            for (const c of decompressedChunks) {
                weights.set(c, off);
                off += c.length;
            }
        } catch (err) {
            // If DecompressionStream not available or not gzipped, use raw bytes
            console.warn('[StemQueue] Gzip decompression failed, using raw bytes:', err.message);
            weights = compressed;
        }

        this._notify({ type: 'stem-progress', progress: 0.95, stage: 'loading' });
        await StemDB.saveModel(MODEL_VERSION, weights.buffer);
        return weights.buffer;
    }

    /** Request the background service worker to fetch a URL and return an ArrayBuffer.
     *  The background SW has broader network access once optional host permissions are granted. */
    _fetchViaBackground(url) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { target: 'background', type: 'fetch-audio', url },
                (response) => {
                    if (chrome.runtime.lastError) {
                        return reject(new Error(chrome.runtime.lastError.message));
                    }
                    if (!response || response.error) {
                        return reject(new Error(response?.error || 'No response from background fetch'));
                    }
                    // response.data is a base64 string; decode to ArrayBuffer
                    const binary = atob(response.data);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    resolve(bytes.buffer);
                }
            );
        });
    }

    /** Fetch and decode audio from a URL into separate L/R Float32Arrays */
    async _fetchAudio(url) {
        let arrayBuffer;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`status ${response.status}`);
            arrayBuffer = await response.arrayBuffer();
        } catch (directErr) {
            console.warn('[StemQueue] Direct fetch failed, routing through background:', directErr.message);
            arrayBuffer = await this._fetchViaBackground(url);
        }

        const offlineCtx = new OfflineAudioContext(2, 1, 44100);
        const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);

        const length = audioBuffer.length;
        const left = new Float32Array(length);
        const right = new Float32Array(length);

        left.set(audioBuffer.getChannelData(0));
        if (audioBuffer.numberOfChannels >= 2) {
            right.set(audioBuffer.getChannelData(1));
        } else {
            right.set(left);
        }

        return {
            leftChannel: left,
            rightChannel: right,
            sampleRate: audioBuffer.sampleRate,
            duration: audioBuffer.duration
        };
    }

    /** Encode a stem (L/R Float32Arrays) as Opus WebM blob for compact storage */
    async _encodeStemToOpus(stemLeft, stemRight, sampleRate) {
        const length = stemLeft.length;
        const offlineCtx = new OfflineAudioContext(2, length, sampleRate);
        const buffer = offlineCtx.createBuffer(2, length, sampleRate);

        buffer.getChannelData(0).set(stemLeft);
        buffer.getChannelData(1).set(stemRight);

        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;

        const dest = offlineCtx.createMediaStreamDestination();
        source.connect(dest);
        source.connect(offlineCtx.destination);
        source.start();

        const recorder = new MediaRecorder(dest.stream, {
            mimeType: 'audio/webm;codecs=opus',
            audioBitsPerSecond: 128000
        });

        const chunks = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);

        const recordingDone = new Promise(resolve => {
            recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm;codecs=opus' }));
        });

        recorder.start();
        await offlineCtx.startRendering();
        recorder.stop();

        return recordingDone;
    }

    /** Get or create the Web Worker */
    _getWorker() {
        if (!this.worker) {
            this.worker = new Worker('demucs-worker.js');
        }
        return this.worker;
    }

    /** Process a single queue item */
    async _processJob(job) {
        this.currentJobId = job.id;
        await StemDB.updateQueueItem(job.id, { status: 'processing', progress: 0 });

        // Check if stems already cached
        const cached = await StemDB.getStems(job.url);
        if (cached) {
            await StemDB.updateQueueItem(job.id, { status: 'complete', progress: 1 });
            this._notify({ type: 'stem-ready', url: job.url, tabId: job.tabId });
            return;
        }

        // Ensure model is available
        const modelWeights = await this._ensureModel();

        // Fetch and decode audio
        this._notify({ type: 'stem-progress', progress: 0, stage: 'decoding' });
        const { leftChannel, rightChannel, sampleRate, duration } = await this._fetchAudio(job.url);

        // Run Demucs inference in worker
        const worker = this._getWorker();

        const stems = await new Promise((resolve, reject) => {
            const handler = (e) => {
                const msg = e.data;
                if (msg.type === 'progress') {
                    StemDB.updateQueueItem(job.id, { progress: msg.progress });
                    this._notify({
                        type: 'stem-progress',
                        progress: msg.progress,
                        stage: msg.stage,
                        tabId: job.tabId
                    });
                } else if (msg.type === 'complete') {
                    worker.removeEventListener('message', handler);
                    resolve(msg.stems);
                } else if (msg.type === 'error') {
                    worker.removeEventListener('message', handler);
                    reject(new Error(msg.message));
                }
            };
            worker.addEventListener('message', handler);

            worker.postMessage(
                { type: 'process', leftChannel, rightChannel, modelWeights },
                [leftChannel.buffer, rightChannel.buffer, modelWeights]
            );
        });

        // Encode stems as Opus for compact storage
        this._notify({ type: 'stem-progress', progress: 0.97, stage: 'encoding' });
        const stemBlobs = {};
        for (const name of ['vocals', 'drums', 'bass', 'other']) {
            stemBlobs[name] = await this._encodeStemToOpus(
                stems[name].left, stems[name].right, sampleRate
            );
        }

        // Evict old stems if needed
        await StemDB.evictLRU(MAX_CACHE_BYTES);

        // Save to IndexedDB
        await StemDB.saveStems(job.url, job.title, sampleRate, duration, stemBlobs);
        await StemDB.updateQueueItem(job.id, { status: 'complete', progress: 1 });

        this._notify({ type: 'stem-ready', url: job.url, tabId: job.tabId });
        this.currentJobId = null;
    }

    /** Main loop: process next pending job */
    async processNext() {
        if (this.processing) return;
        this.processing = true;

        try {
            const job = await StemDB.getNextPending();
            if (job) {
                await this._processJob(job);
            }
        } catch (err) {
            console.error('[StemQueue] Job failed:', err);
            if (this.currentJobId) {
                await StemDB.updateQueueItem(this.currentJobId, {
                    status: 'failed',
                    error: err.message
                });
                this._notify({
                    type: 'stem-error',
                    message: err.message,
                    jobId: this.currentJobId
                });
            }
            this.currentJobId = null;
        }

        this.processing = false;

        // Check for more pending jobs
        const next = await StemDB.getNextPending();
        if (next) this.processNext();
    }

    /** Public: enqueue a new separation job and start processing */
    async add(url, title, tabId) {
        await StemDB.enqueue(url, title, tabId);
        this.processNext();
    }

    /** Public: process a raw audio buffer directly (for recorded tab audio) */
    async addFromBuffer(leftChannel, rightChannel, sampleRate, duration, recordId, title, tabId) {
        // Store a synthetic queue entry and process immediately
        this._pendingBuffer = { leftChannel, rightChannel, sampleRate, duration, recordId, title, tabId };
        this._processBufferJob();
    }

    async _processBufferJob() {
        if (this.processing || !this._pendingBuffer) return;
        this.processing = true;

        const { leftChannel, rightChannel, sampleRate, duration, recordId, title, tabId } = this._pendingBuffer;
        this._pendingBuffer = null;

        try {
            // Check cache
            const cached = await StemDB.getStems(recordId);
            if (cached) {
                this._notify({ type: 'stem-ready', url: recordId, tabId });
                this.processing = false;
                return;
            }

            const modelWeights = await this._ensureModel();

            this._notify({ type: 'stem-progress', progress: 0, stage: 'loading' });

            const worker = this._getWorker();
            const lCopy = new Float32Array(leftChannel);
            const rCopy = new Float32Array(rightChannel);

            const stems = await new Promise((resolve, reject) => {
                const handler = (e) => {
                    const msg = e.data;
                    if (msg.type === 'progress') {
                        this._notify({
                            type: 'stem-progress',
                            progress: msg.progress,
                            stage: msg.stage,
                            tabId
                        });
                    } else if (msg.type === 'complete') {
                        worker.removeEventListener('message', handler);
                        resolve(msg.stems);
                    } else if (msg.type === 'error') {
                        worker.removeEventListener('message', handler);
                        reject(new Error(msg.message));
                    }
                };
                worker.addEventListener('message', handler);
                worker.postMessage(
                    { type: 'process', leftChannel: lCopy, rightChannel: rCopy, modelWeights },
                    [lCopy.buffer, rCopy.buffer, modelWeights]
                );
            });

            this._notify({ type: 'stem-progress', progress: 0.97, stage: 'encoding' });
            const stemBlobs = {};
            for (const name of ['vocals', 'drums', 'bass', 'other']) {
                stemBlobs[name] = await this._encodeStemToOpus(
                    stems[name].left, stems[name].right, sampleRate
                );
            }

            await StemDB.evictLRU(MAX_CACHE_BYTES);
            await StemDB.saveStems(recordId, title, sampleRate, duration, stemBlobs);

            this._notify({ type: 'stem-ready', url: recordId, tabId });
        } catch (err) {
            console.error('[StemQueue] Buffer job failed:', err);
            this._notify({ type: 'stem-error', message: err.message });
        }

        this.processing = false;
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.StemQueue = StemQueue;
}
