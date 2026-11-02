let personalStarted = false;
let startObserver;
let startupTimer;
function startPersonal() {
  if (personalStarted || location.origin !== 'https://www.nodeseek.com' || window.top !== window.self) return;
  if (!document.body) return;
  // Cloudflare/login interstitials are not forum pages.
  if (!document.querySelector('#nsk-body, #nsk-body-left, .user-card, ul.post-list, ul.comments, a[href="/notification"]')) return;
  personalStarted = true;
  startObserver?.disconnect();
  clearTimeout(startupTimer);
  if (document.querySelector('.nsp-tools')) return;
  NSP.initUI();
  for (const module of NSP.modules) {
    try { module.start(); }
    catch (error) { console.error(`[NodeSeek Personal: ${module.id}]`, error); NSP.toast('部分功能未能启动，可刷新页面后重试'); }
  }
}
function waitForPersonalPage() {
  if (location.origin !== 'https://www.nodeseek.com' || window.top !== window.self) return;
  document.documentElement?.setAttribute('data-nsp-loaded', NSP.version);
  startPersonal();
  if (personalStarted) return;
  startObserver ||= new MutationObserver(() => {
    clearTimeout(startupTimer);
    startupTimer = setTimeout(startPersonal, 50);
  });
  startObserver.observe(document, { childList: true, subtree: true });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForPersonalPage, { once: true });
else waitForPersonalPage();
window.addEventListener('pageshow', waitForPersonalPage);
