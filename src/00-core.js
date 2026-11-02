// Shared infrastructure. No remote libraries, external APIs, or page-context bridge.
const NSP = (() => {
  const version = typeof NSP_VERSION === 'string' ? NSP_VERSION : 'dev';
  const DEFAULTS = Object.freeze({ autoSign: true, signMode: 'random', profiles: true, badges: true, chat: true });
  const memory = new Map();
  const store = {
    get(key, fallback) {
      try { return typeof GM_getValue === 'function' ? GM_getValue(`nsp:v1:${key}`, fallback) : memory.has(key) ? memory.get(key) : fallback; }
      catch { return fallback; }
    },
    set(key, value) {
      if (typeof GM_setValue === 'function') GM_setValue(`nsp:v1:${key}`, value);
      else memory.set(key, structuredClone(value));
    }
  };
  const storedSettings = store.get('settings', {});
  const rawSettings = storedSettings && typeof storedSettings === 'object' && !Array.isArray(storedSettings) ? { ...storedSettings } : {};
  // This upgrade applies the owner's explicit choice even to a saved fixed mode.
  // Later deliberate setting changes are respected; migration never runs twice.
  if (store.get('migration:random-sign-v012', false) !== true) {
    rawSettings.signMode = 'random';
    try {
      store.set('settings', rawSettings);
      store.set('migration:random-sign-v012', true);
    } catch { /* Random still applies to this page if manager storage is unavailable. */ }
  }
  const settings = Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key,
    key === 'signMode' ? (rawSettings?.[key] === 'fixed' ? 'fixed' : 'random') : typeof rawSettings?.[key] === 'boolean' ? rawSettings[key] : fallback
  ]));
  function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function button(label, handler, className = '') {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }
  function css(text) {
    const style = document.createElement('style');
    style.textContent = text;
    (document.head || document.documentElement).append(style);
  }
  function safeURL(value, base = location.href, { sameOrigin = false } = {}) {
    try {
      const url = new URL(value, base);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
      if (sameOrigin && url.origin !== location.origin) return null;
      return url;
    } catch { return null; }
  }
  function validUser(value) {
    const id = Number(value?.member_id ?? value?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return { id, name: String(value.member_name ?? value.name ?? `用户 ${id}`) };
  }
  const configCache = new WeakMap();
  function userFromDocument(doc) {
    const raw = doc.querySelector('#temp-script')?.textContent?.trim();
    if (raw && raw.length < 5_000_000) {
      try {
        const prior = configCache.get(doc);
        const config = prior?.raw === raw ? prior.config : JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), char => char.charCodeAt(0))));
        configCache.set(doc, { raw, config });
        if (config && Object.hasOwn(config, 'user')) return { known: true, user: validUser(config.user) };
      } catch { /* A partially streamed script is retried by the observer. */ }
    }
    // Only the signed-in sidebar, never arbitrary post authors, can identify the account.
    for (const card of doc.querySelectorAll('.user-card')) {
      if (!card.querySelector('a[href^="/notification"], .user-stat a[href*="/notification"]')) continue;
      for (const link of card.querySelectorAll('a[href]')) {
        const url = safeURL(link.getAttribute('href'), location.origin, { sameOrigin: true });
        const match = url?.pathname.match(/^\/space\/([1-9]\d*)\/?$/);
        if (match) return { known: true, user: validUser({ id: match[1], name: link.textContent?.trim() || link.querySelector('img')?.alt }) };
      }
    }
    return { known: false, user: null };
  }
  let capturedIdentity = { known: false, user: null };
  let sessionMismatch = false;
  function captureIdentity() {
    const next = userFromDocument(document);
    if (next.known) capturedIdentity = next;
  }
  // document-start preserves declarative JSON if the forum later removes its node.
  const identityObserver = new MutationObserver(captureIdentity);
  identityObserver.observe(document, { childList: true, subtree: true });
  captureIdentity();
  function getUser() {
    if (sessionMismatch) return null;
    const live = userFromDocument(document);
    if (live.known) capturedIdentity = live;
    return capturedIdentity.user;
  }
  const allowRequest = (url, method) => {
    if (method === 'GET') return /^\/api\/account\/getInfo\/[1-9]\d*$/.test(url.pathname)
      || url.pathname === '/api/block-list/list'
      || /^\/api\/notification\/message\/(?:list|with\/[1-9]\d*)$/.test(url.pathname);
    return method === 'POST' && (url.pathname === '/api/attendance'
      || /^\/api\/(?:fans|block-list)\/(?:add|del)$/.test(url.pathname)
      || /^\/api\/notification\/message\/(?:send|markViewed)$/.test(url.pathname));
  };
  let cooldownUntil = 0;
  async function api(path, options = {}) {
    const url = safeURL(path, location.origin, { sameOrigin: true });
    const method = String(options.method || 'GET').toUpperCase();
    if (!url || url.hash || !allowRequest(url, method)) throw new Error('不允许访问该接口');
    if (Date.now() < cooldownUntil) throw new Error('论坛正在限流，请稍后再试');
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signal = options.signal;
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15_000);
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      // A different tab may have changed the login cookie while this page still
      // displays the old account. Verify the server-rendered identity before writes.
      if (method === 'POST') {
        const expected = getUser()?.id;
        if (!expected) throw Object.assign(new Error('请刷新页面并登录后再操作'), { confirmedFailure: true });
        const check = await fetch(`${location.origin}/`, {
          method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal
        });
        if (!check.ok) throw Object.assign(new Error('暂时无法核对登录状态，请刷新论坛页面后重试'), { confirmedFailure: true });
        const identity = userFromDocument(new DOMParser().parseFromString(await check.text(), 'text/html'));
        if (!identity.known || !identity.user) throw Object.assign(new Error('无法确认当前登录账号，请刷新论坛页面后重试'), { confirmedFailure: true });
        if (identity.user.id !== expected || getUser()?.id !== expected) {
          sessionMismatch = true;
          throw Object.assign(new Error('登录账号已变化，请刷新页面后再操作'), { confirmedFailure: true });
        }
      }
      const response = await fetch(url.href, {
        method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}), signal: controller.signal
      });
      if ([403, 429, 503].includes(response.status)) cooldownUntil = Date.now() + 60_000;
      const result = await response.json().catch(() => null);
      if (!response.ok && result?.success !== false) throw new Error(`接口请求失败（${response.status}），请在原页面确认登录状态`);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('论坛没有返回有效数据，请刷新原页面确认登录状态');
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('请求已取消或超时，操作结果尚未确认');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  const observers = new Set();
  let watchTimer;
  const domObserver = new MutationObserver(records => {
    if (!records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && !node.closest?.('[data-nsp-ui]')))) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      for (const fn of observers) { try { fn(document); } catch (error) { console.warn('[NodeSeek Personal]', error); } }
    }, 150);
  });
  function observe(fn) {
    if (!observers.size) domObserver.observe(document, { childList: true, subtree: true });
    observers.add(fn);
    fn(document);
    return () => observers.delete(fn);
  }
  let tools, toastNode, toastTimer, settingsDialog;
  function toast(text) {
    if (!toastNode) {
      toastNode = el('div', 'nsp-toast');
      toastNode.dataset.nspUi = '';
      toastNode.setAttribute('role', 'status');
      document.body.append(toastNode);
    }
    clearTimeout(toastTimer);
    toastNode.textContent = text;
    toastNode.hidden = false;
    toastTimer = setTimeout(() => { toastNode.hidden = true; }, 6500);
  }
  function addTool(label, handler) {
    if (!tools) initUI();
    const control = button(label, handler, 'nsp-tool');
    tools.append(control);
    return control;
  }
  const cacheCleaners = new Map();
  function registerCacheCleaner(clean, ready = () => true) {
    cacheCleaners.set(clean, ready);
  }
  function clearCaches() {
    if ([...cacheCleaners.values()].some(ready => !ready())) {
      toast('消息操作正在进行，请等待结果确认后再清理缓存');
      return false;
    }
    for (const clean of cacheCleaners.keys()) clean();
    toast('缓存已清理；设置、备注、签到状态和未发送草稿已保留');
    return true;
  }
  function openSettings() {
    if (settingsDialog?.open) return;
    settingsDialog?.remove();
    const dialog = el('dialog', 'nsp-settings');
    settingsDialog = dialog;
    dialog.dataset.nspUi = '';
    dialog.setAttribute('aria-label', 'NodeSeek 个人版设置');
    const heading = el('h2', '', `NodeSeek 个人版 ${version}`);
    const description = el('p', 'nsp-muted', '签到、用户资料、私信。设置保存在本机，保存后刷新生效。');
    const form = el('form');
    const fields = new Map();
    for (const [key, label] of [['autoSign', '每天自动签到'], ['profiles', '头像悬停显示用户资料'], ['badges', '用户名旁显示资料徽章'], ['chat', '聊天式私信面板']]) {
      const row = el('label', 'nsp-setting-row');
      const input = el('input');
      input.type = 'checkbox'; input.checked = settings[key];
      row.append(el('span', '', label), input); form.append(row); fields.set(key, input);
    }
    const modeRow = el('label', 'nsp-setting-row');
    const select = el('select');
    for (const [value, text] of [['random', '随机鸡腿'], ['fixed', '固定鸡腿']]) {
      const option = el('option', '', text); option.value = value; select.append(option);
    }
    select.value = settings.signMode;
    modeRow.append(el('span', '', '签到奖励方式'), select); form.append(modeRow);
    const cacheInfo = el('p', 'nsp-muted', '清理资料和私信内存缓存，保留设置、备注、签到状态和草稿。浏览器图片缓存由浏览器管理。');
    const clear = button('一键清理缓存', () => { if (clearCaches()) dialog.close(); }, 'nsp-clear-cache');
    form.append(cacheInfo, clear);
    const foot = el('div', 'nsp-settings-actions');
    const cancel = button('关闭', () => dialog.close());
    const save = el('button', 'nsp-primary', '保存并刷新'); save.type = 'submit';
    foot.append(cancel, save); form.append(foot);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (NSP.hasDraft?.() && !confirm('私信框里还有未发送的内容，刷新会清除当前页草稿。仍要保存并刷新吗？')) return;
      const next = Object.fromEntries([...fields].map(([key, input]) => [key, input.checked]));
      next.signMode = select.value;
      try { store.set('settings', next); location.reload(); }
      catch { toast('设置保存失败，请检查脚本管理器权限'); }
    });
    dialog.append(heading, description, form);
    document.body.append(dialog);
    dialog.showModal();
  }
  function initUI() {
    if (tools) return;
    css(`
      :root{--nsp-bg:#fff;--nsp-text:#27312e;--nsp-muted:#747f79;--nsp-line:#e2e8e4;--nsp-accent:#16835c;--nsp-soft:#f3f6f4}
      :root.nsp-dark{--nsp-bg:#202624;--nsp-text:#e4ece7;--nsp-muted:#9eaaa3;--nsp-line:#39433e;--nsp-accent:#6ccba5;--nsp-soft:#29322d}
      .nsp-dark :is(.nsp-chat,.nsp-profile-card,.nsp-settings){color-scheme:dark}
      .nsp-tools{position:fixed;right:14px;bottom:24px;z-index:2147482000;display:flex;flex-direction:column;gap:6px;padding:7px;border:1px solid var(--nsp-line);border-radius:13px;background:var(--nsp-bg);box-shadow:0 6px 28px #0001}
      .nsp-tool{appearance:none;border:0;border-radius:8px;padding:8px 11px;background:var(--nsp-soft);color:var(--nsp-text);cursor:pointer;font:12px/1.4 system-ui,-apple-system,'PingFang SC',sans-serif}
      .nsp-tool:hover{color:var(--nsp-accent)}.nsp-tool:disabled{cursor:default;opacity:.6}
      .nsp-toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);max-width:min(500px,calc(100vw - 36px));z-index:2147483647;padding:12px 17px;border:1px solid var(--nsp-line);border-radius:12px;color:var(--nsp-text);background:var(--nsp-bg);box-shadow:0 8px 32px #0002;font:14px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}
      .nsp-toast[hidden]{display:none}.nsp-settings{box-sizing:border-box;width:min(420px,calc(100vw - 28px));padding:24px;border:1px solid var(--nsp-line);border-radius:16px;background:var(--nsp-bg);color:var(--nsp-text);font:14px/1.6 system-ui,-apple-system,'PingFang SC',sans-serif}
      .nsp-settings::backdrop{background:#10191466}.nsp-settings h2{font-size:19px;margin:0 0 7px}.nsp-muted{color:var(--nsp-muted);font-size:12px}
      .nsp-setting-row{display:flex;gap:16px;align-items:center;justify-content:space-between;margin:16px 0}.nsp-setting-row input{accent-color:var(--nsp-accent)}
      .nsp-settings select,.nsp-settings button{font:inherit;color:var(--nsp-text);background:var(--nsp-soft);border:1px solid var(--nsp-line);border-radius:8px;padding:6px 10px}
      .nsp-settings-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:22px}.nsp-settings .nsp-primary{background:#16835c;color:white;border-color:#16835c;cursor:pointer}
      .nsp-tools :focus-visible,.nsp-settings :focus-visible{outline:2px solid var(--nsp-accent);outline-offset:2px}
      @media(max-width:600px){.nsp-tools{right:8px;bottom:12px}.nsp-tool{padding:9px 8px;font-size:11px}}
    `);
    const theme = () => document.documentElement.classList.toggle('nsp-dark', document.body.classList.contains('dark-layout') || document.documentElement.classList.contains('dark-layout') || document.documentElement.dataset.theme === 'dark');
    theme();
    new MutationObserver(theme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    tools = el('nav', 'nsp-tools'); tools.dataset.nspUi = ''; tools.dataset.nspVersion = version; tools.title = `NodeSeek 个人版 ${version}`; tools.setAttribute('aria-label', 'NodeSeek 个人版'); document.body.append(tools);
    addTool('设置', openSettings);
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('NodeSeek 个人版设置', openSettings);
  }
  return { version, modules: [], settings, store, el, button, css, safeURL, userFromDocument, getUser, api, observe, toast, addTool, initUI, openSettings, registerCacheCleaner, clearCaches };
})();
