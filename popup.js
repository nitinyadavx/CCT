const sendToAllFrames = async (payload) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: 'MAIN',
    func: (msg) => {
      window.postMessage({ source: 'CCT_V6_DOWN', ...msg }, '*');
    },
    args: [payload]
  });
};

document.getElementById('p-skip').onclick = () => sendToAllFrames({ cmd: 'SKIP' });
document.getElementById('p-next').onclick = () => sendToAllFrames({ cmd: 'NEXT_UNIT' });

document.querySelectorAll('.seg').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    sendToAllFrames({ cmd: 'SPEED', rate: Number(btn.dataset.rate) });
  };
});