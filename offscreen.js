// offscreen.js: The Heart of Lilin DSP

let audioContext;
let dspNode;
let sourceNode;

chrome.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'INIT_DSP_STREAM') {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: 'tab',
                        chromeMediaSourceId: message.streamId
                    }
                },
                video: false
            });
            await startAudioProcessing(stream);
        } catch (err) {
            console.error('[Offscreen] Failed to capture tab audio:', err.name, err.message);
        }
    }
});

async function startAudioProcessing(stream) {
    if (audioContext) audioContext.close();

    // sampleRate未指定 → OSのネイティブレートを使用
    // processor.jsのoversampleFactorがsampleRateに応じて自動調整される
    audioContext = new AudioContext({ latencyHint: 'interactive' });
    console.log(`[Offscreen] AudioContext: ${audioContext.sampleRate}Hz`);

    const wasmUrl = chrome.runtime.getURL('processor.wasm');
    const wasmModule = await WebAssembly.compile(
        await (await fetch(wasmUrl)).arrayBuffer()
    );

    await audioContext.audioWorklet.addModule(
        chrome.runtime.getURL('processor.js')
    );

    sourceNode = audioContext.createMediaStreamSource(stream);
    dspNode = new AudioWorkletNode(audioContext, 'delta-sigma-processor', {
        processorOptions: { wasmModule },
        outputChannelCount: [2]
    });

    sourceNode.connect(dspNode).connect(audioContext.destination);

    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    console.log('[Offscreen] Lilin DSP Engine ACTIVE.');
}