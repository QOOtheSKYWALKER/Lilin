class DeltaSigmaProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [{ name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1 }];
    }

    constructor(options) {
        super();
        this.oversampleFactor = 128;
        this.taps = 128;

        // ユーザーが後から変更可能なパラメータ
        this.params = {
            targetLevel: 0.70,
            expansionDepth: 1.15,
            aggression: 0.70
        };

        this.initialized = false;
        const wasmModule = options.processorOptions.wasmModule;
        if (wasmModule) this.initWasm(wasmModule);
    }

    async initWasm(module) {
        try {
            const importObject = {
                env: {
                    seed: () => Date.now() * Math.random(),
                    abort: () => { },
                }
            };
            this.instance = await WebAssembly.instantiate(module, importObject);
            this.exports = this.instance.exports;
            this.memory = this.exports.memory;

            this.inputLPtr = 10000; this.inputRPtr = 20000;
            this.outputLPtr = 30000; this.outputRPtr = 40000;
            this.sincTablePtr = 50000;
            this.historyLPtr = 1100000; this.historyRPtr = 1200000;
            this.stateLPtr = 1300000; this.stateRPtr = 1400000;

            // Sincテーブル生成をWasm内部で実行
            this.exports.generateSincTable(this.sincTablePtr, this.oversampleFactor, this.taps, sampleRate || 44100);

            this.wasmInputL = new Float32Array(this.memory.buffer, this.inputLPtr, 128);
            this.wasmInputR = new Float32Array(this.memory.buffer, this.inputRPtr, 128);
            this.wasmOutputL = new Float32Array(this.memory.buffer, this.outputLPtr, 128);
            this.wasmOutputR = new Float32Array(this.memory.buffer, this.outputRPtr, 128);

            // ③ stateの初期化サイズを修正（14要素 = i1〜i7, fb, curPeak, h0〜h3, lastGain）
            new Float32Array(this.memory.buffer, this.stateLPtr, 14).fill(0);
            new Float32Array(this.memory.buffer, this.stateRPtr, 14).fill(0);
            // historyの初期化（taps要素、×4はbyte数なので不要）
            new Float32Array(this.memory.buffer, this.historyLPtr, this.taps).fill(0);
            new Float32Array(this.memory.buffer, this.historyRPtr, this.taps).fill(0);

            this.initialized = true;
        } catch (e) { console.error("Lilin Init Error:", e); }
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
        this.wasmInputL.set(input[0]);
        this.wasmInputR.set(input[1] || input[0]);

        this.exports.process_simd(
            this.inputLPtr, this.inputRPtr, this.outputLPtr, this.outputRPtr,
            this.sincTablePtr, this.historyLPtr, this.historyRPtr,
            this.stateLPtr, this.stateRPtr,
            bufferLen, this.oversampleFactor, this.taps,
            this.params.targetLevel, this.params.expansionDepth, this.params.aggression, sampleRate || 44100
        );

        output[0].set(this.wasmOutputL);
        output[1].set(this.wasmOutputR);
        return true;
    }
}
registerProcessor('delta-sigma-processor', DeltaSigmaProcessor);