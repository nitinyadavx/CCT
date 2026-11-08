const sendToAllFrames = async (payload) => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = tabs?.[0];
  if (!tab?.id) return;

  const url = tab.url || '';
  const isRestricted =
    /^(chrome|edge|about|brave|opera|vivaldi|view-source|devtools|chrome-extension):/i.test(url) ||
    /chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com/i.test(url);

  if (isRestricted) return;

  const injectMessage = (msg) => {
    window.postMessage({ source: 'CCT_V6_DOWN', ...msg }, '*');
  };

  const res = await chrome.scripting
    .executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: injectMessage,
      args: [payload]
    })
    .catch(() => null);

  if (!res) {
    await chrome.scripting
      .executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: injectMessage,
        args: [payload]
      })
      .catch(() => null);
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