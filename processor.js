class DeltaSigmaProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [{ name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1 }];
    }

    constructor(options) {
        super();
        this.oversampleFactor = 128;
        this.taps = 128;
        // アグレッション0.70を活かしつつプチノイズを防ぐため、0.50から0.47へ微調整
        this.targetLevel = 0.47;
        this.expansionDepth = 1.20;

        this.initialized = false;
        this.states = [{ currentPeak: 0.1 }, { currentPeak: 0.1 }];

        // --- 動的B係数の計算 ---
        const fs = (typeof sampleRate !== 'undefined' ? sampleRate : 44100) * this.oversampleFactor;
        const calcB = (f) => Math.pow((2 * Math.PI * f) / fs, 2);

        this.bCoeffs = {
            b1: calcB(10390),
            b2: calcB(17000),
            b3: calcB(24760)
        };

        const wasmModule = options.processorOptions.wasmModule;
        if (wasmModule) {
            this.initWasm(wasmModule);
        }
    }

    // (generateSincTable, initWasm は前回同様。引数の変更はないためそのまま使えます)
    async initWasm(module) {
        try {
            const importObject = {
                env: {
                    seed: () => Date.now() * Math.random(),
                    abort: () => { },
                    "NativeMath.tanh": (x) => Math.tanh(x),
                    "Math.tanh": (x) => Math.tanh(x)
                }
            };
            this.instance = await WebAssembly.instantiate(module, importObject);
            this.exports = this.instance.exports;
            this.memory = this.exports.memory;

            this.inputPtr = 10000;
            this.outputPtr = 20000;
            this.sincTablePtr = 40000;
            this.historyPtr = 1100000;
            this.statePtr = 1200000;

            // --- 重要：Sincテーブルは絶対に必要です ---
            const rate = typeof sampleRate !== 'undefined' ? sampleRate : 44100;
            const sincData = this.generateSincTable(rate);
            new Float32Array(this.memory.buffer, this.sincTablePtr, sincData.length).set(sincData);

            // 固定ビューの作成
            this.wasmInputView = new Float32Array(this.memory.buffer, this.inputPtr, 128);
            this.wasmOutputView = new Float32Array(this.memory.buffer, this.outputPtr, 128);

            // --- 状態のリセット（追加分も含めて28要素） ---
            // 1chあたり14要素 (56byte) × 2チャンネル分 = 28要素
            new Float32Array(this.memory.buffer, this.statePtr, 28).fill(0);

            // 履歴バッファのリセット
            new Float32Array(this.memory.buffer, this.historyPtr, 256).fill(0);

            this.initialized = true;
            console.log("Lilin: Multi-stage Engine Online (Optimized)");
        } catch (e) { console.error("WASM Init Error:", e); }
    }

    generateSincTable(rate) {
        const size = this.oversampleFactor * this.taps;
        const table = new Float32Array(size);
        const center = (this.taps / 2) * this.oversampleFactor;
        for (let i = 0; i < size; i++) {
            const x = (i - center) / this.oversampleFactor;
            if (x === 0) table[i] = 1.0;
            else {
                const pix = Math.PI * x;
                const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (size - 1));
                table[i] = (Math.sin(pix) / pix) * window;
            }
        }
        return table;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        if (!this.initialized || !input || !input[0] || parameters.bypass[0] > 0.5) {
            if (input && input[0]) {
                for (let c = 0; c < input.length; c++) output[c].set(input[c]);
            }
            return true;
        }

        const bufferLen = input[0].length;
        let globalPeak = 0;
        for (let c = 0; c < input.length; c++) {
            for (let i = 0; i < bufferLen; i++) {
                const a = Math.abs(input[c][i]);
                if (a > globalPeak) globalPeak = a;
            }
        }

        for (let channel = 0; channel < input.length; channel++) {
            const inputChannel = input[channel];
            const state = this.states[channel];

            let chPeak = 0;
            for (let i = 0; i < bufferLen; i++) {
                const a = Math.abs(inputChannel[i]);
                if (a > chPeak) chPeak = a;
            }

            if (chPeak > state.currentPeak) state.currentPeak = chPeak * 1.1;
            else state.currentPeak += (chPeak - state.currentPeak) * 0.0001;

            const baseGain = this.targetLevel / Math.max(0.01, state.currentPeak);
            const expansionFactor = Math.pow(Math.max(0.01, globalPeak), this.expansionDepth - 1.0);
            const targetGain = baseGain * expansionFactor;

            this.wasmInputView.set(inputChannel);

            // process_simd に計算済みの B1, B2, B3 を渡す
            this.exports.process_simd(
                this.inputPtr, this.outputPtr, this.sincTablePtr,
                this.historyPtr + (channel * this.taps * 4),
                this.statePtr + (channel * 14 * 4),
                bufferLen, this.oversampleFactor, this.taps,
                targetGain,
                this.bCoeffs.b1, this.bCoeffs.b2, this.bCoeffs.b3
            );

            output[channel].set(this.wasmOutputView);
        }
        return true;
    }
}
registerProcessor('delta-sigma-processor', DeltaSigmaProcessor);