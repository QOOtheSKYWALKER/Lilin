let isCapturing = false;
let activeTabId = null;

// ポップアップからの問い合わせや操作を処理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STATUS_QUERY') {
    sendResponse({ active: isCapturing, tabId: activeTabId });
  }

  if (message.type === 'START_DSP') {
    activeTabId = message.tabId;
    isCapturing = true;
    startDspProcess(message.tabId);
  }

  if (message.type === 'STOP_DSP') {
    stopDspProcess();
    isCapturing = false;
    activeTabId = null;
  }
});

async function startDspProcess(tabId) {
  try {
    await setupOffscreen();
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        isCapturing = false;
        return;
      }
      chrome.runtime.sendMessage({ type: 'INIT_DSP_STREAM', streamId });
    });
  } catch (e) {
    console.error(e);
    isCapturing = false;
  }
}

async function stopDspProcess() {
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {}
}

async function setupOffscreen() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Lilin Audio Processing'
  });
}

