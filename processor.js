class DeltaSigmaProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [{ name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1 }];
    }

    constructor(options) {
        super();
        this.taps = 128;

        this.silenceThreshold = 0.0001;  // この値以下を無音とみなす
        this.silenceFrames = 0;
        this.silenceLimit = Math.ceil(sampleRate / 128 * 3); // 3秒分のブロック数
        this.sleeping = false;

        // ユーザーが後から変更可能なパラメータ
        this.params = {
            targetLevel: 0.70,
            expansionDepth: 1.15,
            aggression: 0.70,
            exciteAmount: 0.15,  // 歪みの深さ（0=オフ、0.15〜0.30が実用域）
            exciteMix: 0.10,     // 混合量（0.05〜0.15）
        };

        this.initialized = false;
        const wasmModule = options.processorOptions.wasmModule;
        if (wasmModule) this.initWasm(wasmModule);
    }

    async initWasm(module) {
        try {
            const importObject = { env: { seed: () => Date.now() * Math.random(), abort: () => { } } };
            this.instance = await WebAssembly.instantiate(module, importObject);
            this.exports = this.instance.exports;
            this.memory = this.exports.memory;

            // oversampleFactorをここで確定（sampleRateが確実に利用可能）
            const sr = sampleRate || 44100;
            const baseRate = (sr % 44100 === 0) ? 44100 : 48000;
            const targetRate = baseRate * 128;
            this.oversampleFactor = Math.ceil(Math.round(targetRate / sr) / 4) * 4;
            console.log(`Lilin: sampleRate=${sr}, oversample=${this.oversampleFactor}`);

            this.inputLPtr = 10000; this.inputRPtr = 20000;
            this.outputLPtr = 30000; this.outputRPtr = 40000;
            this.sincTablePtr = 50000;
            this.historyLPtr = 1100000; this.historyRPtr = 1200000;
            this.stateLPtr = 1300000; this.stateRPtr = 1400000;

            // oversampleFactor確定後にテーブル生成
            this.exports.generatePolyphaseTable(
                this.sincTablePtr, this.oversampleFactor, this.taps
            );

            this.wasmInputL = new Float32Array(this.memory.buffer, this.inputLPtr, 128);
            this.wasmInputR = new Float32Array(this.memory.buffer, this.inputRPtr, 128);
            this.wasmOutputL = new Float32Array(this.memory.buffer, this.outputLPtr, 128);
            this.wasmOutputR = new Float32Array(this.memory.buffer, this.outputRPtr, 128);

            new Float32Array(this.memory.buffer, this.stateLPtr, 13).fill(0);
            new Float32Array(this.memory.buffer, this.stateRPtr, 13).fill(0);
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

        // 無音検知
        let inputPeak = 0;
        for (let c = 0; c < input.length; c++) {
            for (let i = 0; i < bufferLen; i++) {
                const a = Math.abs(input[c][i]);
                if (a > inputPeak) inputPeak = a;
            }
        }

        if (inputPeak < this.silenceThreshold) {
            this.silenceFrames++;
            if (this.silenceFrames >= this.silenceLimit) {
                // スリープ状態：入力をそのままスルーして計算をスキップ
                if (!this.sleeping) {
                    this.sleeping = true;
                    console.log("Lilin: Sleeping (silence detected)");
                }
                for (let c = 0; c < input.length; c++) output[c].set(input[c]);
                return true;
            }
        } else {
            // 音声再開時の処理
            if (this.sleeping) {
                this.sleeping = false;
                this.silenceFrames = 0;
                console.log("Lilin: Waking up");
                // 積分器状態をリセット（無音中に蓄積したDCを除去）
                if (this.memory) {
                    new Float32Array(this.memory.buffer, this.stateLPtr, 13).fill(0);
                    new Float32Array(this.memory.buffer, this.stateRPtr, 13).fill(0);
                }
            } else {
                this.silenceFrames = 0;
            }
        }

        this.wasmInputL.set(input[0]);
        this.wasmInputR.set(input[1] || input[0]);

        this.exports.process_simd(
            this.inputLPtr, this.inputRPtr, this.outputLPtr, this.outputRPtr,
            this.sincTablePtr, this.historyLPtr, this.historyRPtr,
            this.stateLPtr, this.stateRPtr,
            bufferLen, this.oversampleFactor, this.taps,
            this.params.targetLevel, this.params.expansionDepth, this.params.aggression, sampleRate || 44100,
            this.params.exciteAmount, this.params.exciteMix
        );

        output[0].set(this.wasmOutputL);
        output[1].set(this.wasmOutputR);
        return true;
    }
}
registerProcessor('delta-sigma-processor', DeltaSigmaProcessor);