let audioContext;
let dspNode;
let mediaSource;
const audioEl = document.getElementById('player');

document.getElementById('audioFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // 前の再生を停止
    audioEl.pause();
    const fileURL = URL.createObjectURL(file);
    audioEl.src = fileURL;

    if (!audioContext) {
        audioContext = new AudioContext();
        await audioContext.audioWorklet.addModule('processor.js');
    }

    // WASM読み込み（前と同じ）
    let wasmModule = null;
    try {
        const wasmRes = await fetch('/processor.wasm');
        const wasmBuffer = await wasmRes.arrayBuffer();
        wasmModule = await WebAssembly.compile(wasmBuffer);
    } catch (err) {
        console.error("WASM loading failed:", err);
    }

    // 既にノードがある場合は接続し直さないための処理
    if (!mediaSource) {
        mediaSource = audioContext.createMediaElementSource(audioEl);
        dspNode = new AudioWorkletNode(audioContext, 'delta-sigma-processor', {
            processorOptions: { wasmModule }
        });

        // パラメータ制御
        const checkDSP = document.getElementById('checkDSP');
        const bypassParam = dspNode.parameters.get('bypass');
        setInterval(() => {
            bypassParam.value = checkDSP.checked ? 0 : 1;
        }, 100);

        mediaSource.connect(dspNode).connect(audioContext.destination);
    }

    audioEl.play();
});