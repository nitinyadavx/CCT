const dispatchToPage = async (payload) => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = tabs?.[0];
  if (!tab?.id) return;

  const url = tab.url || '';
  const isRestricted =
    /^(chrome|edge|about|brave|opera|vivaldi|view-source|devtools|chrome-extension):/i.test(url) ||
    /chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com/i.test(url);

  if (isRestricted) return;

  const injectFn = (msg) => {
    window.postMessage({ source: 'CCT_V8_BUS', ...msg }, '*');
  };

  await chrome.scripting
    .executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'MAIN',
      func: injectFn,
      args: [payload]
    })
    .catch(async () => {
      await chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: injectFn,
          args: [payload]
        })
        .catch(() => null);
    });
};

document.addEventListener('DOMContentLoaded', () => {
  const heroBtn = document.getElementById('p-oneclick');
  const hintEl = document.getElementById('p-hint');

  if (heroBtn) {
    heroBtn.addEventListener('click', () => {
      heroBtn.classList.add('running');
      heroBtn.textContent = '✓ Completing & Auto-Advancing...';
      if (hintEl) hintEl.textContent = 'Playing video, forging watch time & marking read...';
      dispatchToPage({ cmd: 'ONE_CLICK_START', speed: 16 });
    });
  }
});