document.addEventListener('DOMContentLoaded', async () => {
    const btnActivate = document.getElementById('btnActivate');
    const status = document.getElementById('status');
    const visualizer = document.getElementById('visualizer');

    // バーの生成
    for (let i = 0; i < 20; i++) {
        const bar = document.createElement('div');
        bar.className = 'bar';
        visualizer.appendChild(bar);
    }

    // 現在の状態を問い合わせ
    const response = await chrome.runtime.sendMessage({ type: 'STATUS_QUERY' });
    updateUI(response.active);

    function updateUI(active) {
        if (active) {
            status.textContent = "DSP ACTIVE";
            status.style.color = "#10b981";
            status.style.background = "rgba(16, 185, 129, 0.1)";
            btnActivate.textContent = "Deactivate Lilin";
            // ビジュアライザーアニメーション開始（ダミー）
            document.querySelectorAll('.bar').forEach(b => b.style.opacity = "1");
        } else {
            status.textContent = "Ready to Process";
            status.style.color = "#8b5cf6";
            status.style.background = "rgba(139, 92, 246, 0.1)";
            btnActivate.textContent = "Activate DSP";
            document.querySelectorAll('.bar').forEach(b => b.style.opacity = "0.3");
        }
    }

    btnActivate.addEventListener('click', async () => {
        const queryResponse = await chrome.runtime.sendMessage({ type: 'STATUS_QUERY' });
        
        if (queryResponse.active) {
            // 停止
            chrome.runtime.sendMessage({ type: 'STOP_DSP' });
            updateUI(false);
        } else {
            // 開始
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            status.textContent = "Injecting...";
            chrome.runtime.sendMessage({ type: 'START_DSP', tabId: tab.id });
            
            // 少し待ってから状態を再取得（または強制的にUI更新）
            setTimeout(async () => {
                const check = await chrome.runtime.sendMessage({ type: 'STATUS_QUERY' });
                updateUI(check.active);
            }, 500);
        }
    });
});
