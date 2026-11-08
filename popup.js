const sendToAllFrames = async (payload) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
      return;
    }

    const injectMessage = (msg) => {
      window.postMessage({ source: 'CCT_V6_DOWN', ...msg }, '*');
    };

    try {
      // Dispatch to top frame first; content.js automatically relays down to nested iframes
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: injectMessage,
        args: [payload]
      });
    } catch (_) {
      // Fallback: attempt all frames if top frame context is isolated
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: injectMessage,
        args: [payload]
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('[CCT Popup] Dispatch skipped:', err.message);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const skipBtn = document.getElementById('p-skip');
  const nextBtn = document.getElementById('p-next') || document.getElementById('p-sync');
  const segBtns = document.querySelectorAll('.seg');

  if (skipBtn) {
    skipBtn.addEventListener('click', () => sendToAllFrames({ cmd: 'SKIP' }));
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => sendToAllFrames({ cmd: 'NEXT_UNIT' }));
  }

  segBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      segBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      sendToAllFrames({ cmd: 'SPEED', rate: Number(btn.dataset.rate) || 1 });
    });
  });
});