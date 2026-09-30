# Third-party notices

Keyshift's own code is under the [MIT license](LICENSE). These bundled files keep their own licenses.

| File | Project | License |
|---|---|---|
| `extension/pitch-shifter-processor.js` (SoundTouch classes) | [SoundTouch JS](https://github.com/cutterbl/SoundTouchJS) by Olli Parviainen, Ryan Berdeen, Jakub Fiala, and Steve "Cutter" Blades | [LGPL 2.1 or later](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) |
| `extension/demucs_onnx_simd.js`, `extension/demucs_onnx_simd.wasm` | [free-music-demixer](https://github.com/sevagh/free-music-demixer) and [demucs.onnx](https://github.com/sevagh/demucs.onnx) by Sevag Hanssian, built with [ONNX Runtime](https://github.com/microsoft/onnxruntime) | MIT |
| `extension/htdemucs.ort.gz` (model weights) | [Demucs v4 (Hybrid Transformer)](https://github.com/facebookresearch/demucs) by Meta AI Research, converted by free-music-demixer | MIT |

## SoundTouch JS (LGPL)

The SoundTouch classes ship as readable, unminified source in `pitch-shifter-processor.js`. You can change or replace them and reload the extension. The LGPL applies to those classes only. The AudioWorklet wrapper at the end of that file is Keyshift code under MIT.
