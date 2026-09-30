/**
 * demucs-worker.js — Web Worker for Demucs WASM inference.
 * Uses the demucs_onnx_simd.wasm module from free-music-demixer.
 *
 * WASM API (from libdemucs / demucs_onnx_simd.js):
 *   _malloc(bytes) → ptr
 *   _free(ptr)
 *   _modelInit(ptr, len) — load model weights into WASM
 *   _modelDemixSegment(leftPtr, rightPtr, length, ...outputPtrs, isBatch, numModels, modelIndex)
 *
 * Messages IN:
 *   { type: 'process', leftChannel: Float32Array, rightChannel: Float32Array, modelWeights: ArrayBuffer }
 *
 * Messages OUT:
 *   { type: 'progress', progress: number, stage: string }
 *   { type: 'complete', stems: { vocals, drums, bass, other } }  (each has .left and .right Float32Arrays)
 *   { type: 'error', message: string }
 */

const MAX_TARGETS = 6;
const NUM_STEMS = 4; // htdemucs free 4-source: drums, bass, other, vocals

let wasmModule = null;

function allocateWasmArray(mod, typedArray) {
    const bytes = typedArray.length * typedArray.BYTES_PER_ELEMENT;
    const ptr = mod._malloc(bytes);
    if (ptr === 0) throw new Error('WASM memory allocation failed');
    new Float32Array(mod.HEAPF32.buffer, ptr, typedArray.length).set(typedArray);
    return ptr;
}

function freeWasmMemory(mod, pointers) {
    pointers.forEach(ptr => {
        if (ptr !== null && ptr !== 0) mod._free(ptr);
    });
}

self.onmessage = async (e) => {
    const { type } = e.data;

    if (type === 'process') {
        try {
            const { leftChannel, rightChannel, modelWeights } = e.data;
            const numSamples = leftChannel.length;

            // Stage 1: Load WASM module
            if (!wasmModule) {
                self.postMessage({ type: 'progress', progress: 0, stage: 'loading' });
                importScripts('demucs_onnx_simd.js');
                wasmModule = await libdemucs();
                self.postMessage({ type: 'progress', progress: 0.05, stage: 'loading' });
            }

            // Stage 2: Load model weights into WASM
            self.postMessage({ type: 'progress', progress: 0.05, stage: 'loading' });
            const weightsArray = new Uint8Array(modelWeights);
            console.log('[demucs-worker] Model weights size:', weightsArray.byteLength, 'bytes');
            const modelPtr = wasmModule._malloc(weightsArray.byteLength);
            if (modelPtr === 0) throw new Error('Failed to allocate memory for model weights');
            wasmModule.HEAPU8.set(weightsArray, modelPtr);
            try {
                wasmModule._modelInit(modelPtr, weightsArray.byteLength);
            } catch (initErr) {
                wasmModule._free(modelPtr);
                throw new Error('modelInit failed: ' + (initErr.message || initErr));
            }
            wasmModule._free(modelPtr);
            self.postMessage({ type: 'progress', progress: 0.1, stage: 'loading' });

            // Stage 3: Allocate input buffers
            self.postMessage({ type: 'progress', progress: 0.1, stage: 'separating' });
            const inputPtrs = [
                allocateWasmArray(wasmModule, leftChannel),
                allocateWasmArray(wasmModule, rightChannel)
            ];

            // Allocate output buffers (MAX_TARGETS pairs of L/R)
            const outputPtrs = [];
            for (let i = 0; i < MAX_TARGETS; i++) {
                if (i < NUM_STEMS) {
                    const leftPtr = wasmModule._malloc(numSamples * 4);
                    const rightPtr = wasmModule._malloc(numSamples * 4);
                    if (leftPtr === 0 || rightPtr === 0) throw new Error('Output allocation failed for stem ' + i);
                    outputPtrs.push(leftPtr, rightPtr);
                } else {
                    outputPtrs.push(0, 0);
                }
            }

            // Stage 4: Run demixing
            // _modelDemixSegment(leftPtr, rightPtr, length, ...12 output ptrs, isBatch, numModels, modelIndex)
            const args = [
                inputPtrs[0], inputPtrs[1], numSamples,
                ...outputPtrs,
                false, // isBatch
                1,     // numModels
                0      // modelIndex
            ];

            self.postMessage({ type: 'progress', progress: 0.15, stage: 'separating' });
            wasmModule._modelDemixSegment(...args);
            self.postMessage({ type: 'progress', progress: 0.9, stage: 'separating' });

            // Stage 5: Extract results
            // htdemucs 4-source output order: drums(L,R), bass(L,R), other(L,R), vocals(L,R)
            const stemNames = ['drums', 'bass', 'other', 'vocals'];
            const stems = {};
            const transfers = [];

            for (let i = 0; i < NUM_STEMS; i++) {
                const leftPtr = outputPtrs[i * 2];
                const rightPtr = outputPtrs[i * 2 + 1];

                const left = new Float32Array(numSamples);
                const right = new Float32Array(numSamples);
                left.set(new Float32Array(wasmModule.HEAPF32.buffer, leftPtr, numSamples));
                right.set(new Float32Array(wasmModule.HEAPF32.buffer, rightPtr, numSamples));

                stems[stemNames[i]] = { left, right };
                transfers.push(left.buffer, right.buffer);
            }

            // Free WASM memory
            freeWasmMemory(wasmModule, [...inputPtrs, ...outputPtrs]);

            self.postMessage({ type: 'progress', progress: 1.0, stage: 'complete' });
            self.postMessage({ type: 'complete', stems }, transfers);

        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || String(err) });
        }
    }
};
