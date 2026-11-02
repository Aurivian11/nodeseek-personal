// ==UserScript==
// @name         NodeSeek 个人版
// @namespace    local.nodeseek.personal
// @version      0.1.7
// @description  只提供自动签到、用户资料卡和聊天式私信；本地配置，无远程依赖。
// @homepageURL  https://github.com/Aurivian11/nodeseek-personal
// @supportURL   https://github.com/Aurivian11/nodeseek-personal/issues
// @updateURL    https://raw.githubusercontent.com/Aurivian11/nodeseek-personal/main/dist/nodeseek-personal.meta.js
// @downloadURL  https://raw.githubusercontent.com/Aurivian11/nodeseek-personal/main/dist/nodeseek-personal.user.js
// @match        https://www.nodeseek.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
'use strict';
const NSP_VERSION = "0.1.7";

// Source: 00-core.js
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


// Source: 15-profile-model.js
// A local, transparent profile reference score. It makes no claim about a person.
(() => {
  const terms = [
    { key: 'days', label: '注册时长', cap: 730, max: 40 },
    { key: 'nPost', label: '主题帖', cap: 100, max: 15 },
    { key: 'nComment', label: '评论', cap: 1000, max: 20 },
    { key: 'fans', label: '粉丝', cap: 50, max: 10 },
    { key: 'coin', label: '鸡腿', cap: 5000, max: 10 },
    { key: 'stardust', label: '星辰', cap: 200, max: 5 }
  ];
  const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  NSP.scoreDescription = () => '本地参考信任分，非官方评级，不代表交易信用。每项为权重 × √(实际值/上限)，达到上限后不再加分：注册730天40分、主题100帖15分、评论1000条20分、粉丝50人10分、鸡腿5000枚10分、星辰200枚5分。缺少数据时不评分。';
  NSP.profileMetrics = (user = {}, now = Date.now()) => {
    const raw = user?.created_at;
    const timestamp = typeof raw === 'number' && Number.isFinite(raw)
      ? (raw < 100_000_000_000 ? raw * 1000 : raw)
      : typeof raw === 'string' && raw.trim() ? Date.parse(raw) : NaN;
    const validDate = Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= now;
    const days = validDate ? Math.floor((now - timestamp) / 86_400_000) : null;
    const joined = validDate ? new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(timestamp) : '未知';
    const level = count(user?.rank) && user.rank <= 6 ? user.rank : null;
    const source = { ...user, days };
    const complete = terms.every(term => count(source[term.key]));
    const breakdown = terms.map(term => ({
      label: term.label, max: term.max,
      points: count(source[term.key]) ? term.max * Math.sqrt(Math.min(source[term.key] / term.cap, 1)) : null
    }));
    const score = complete ? Math.min(100, Math.max(0, Math.round(breakdown.reduce((sum, term) => sum + term.points, 0)))) : null;
    return { days, joined, level, score, breakdown };
  };
})();


// Source: 18-profile-actions.js
// Profile actions run only after explicit clicks. Transfers stay in the forum UI.
NSP.profileActions = (id, getName, initialProfile = {}) => {
  const group = NSP.el('div', 'nsp-profile-actions');
  if (!Number.isSafeInteger(id) || id <= 0) return group;
  const owner = NSP.getUser()?.id || null;
  const ownAccount = owner === id;
  let followState = typeof initialProfile.followed === 'boolean' ? initialProfile.followed : null;
  let blockState = null;
  let following = false, blocking = false;
  const name = () => String(getName?.() || `用户 ${id}`);
  const sameAccount = () => !!owner && NSP.getUser()?.id === owner;
  const requireAccount = () => {
    if (!sameAccount()) throw new Error('请刷新页面并登录后再操作');
    if (ownAccount) throw new Error('不能对自己执行此操作');
  };
  const make = (key, label, handler) => {
    const control = NSP.button(label, handler, `nsp-profile-${key}`);
    control.dataset.action = key;
    control.disabled = !owner || ownAccount;
    if (!owner) control.title = '登录后可用';
    group.append(control);
    return control;
  };
  const transfer = make('transfer', '转账', () => {
    try {
      requireAccount();
      // Use the forum's own handler; never synthesize a money-transfer request.
      const native = [...document.querySelectorAll('.user-card a, .user-card button')].find(node =>
        !node.closest('.nsp-profile-card, .nsp-chat, .nsp-tools, .hover-user-card') &&
        (node.getAttribute('title') === '转账' || node.textContent.trim() === '转账')
      );
      if (!native) throw new Error(`未找到原站转账入口，请从论坛用户菜单打开。收款人：${name()}（UID ${id}）`);
      // Close our modal first so the native forum dialog is not behind it.
      group.closest('dialog[open]')?.close();
      native.click();
      NSP.toast(`请在原站转账窗口确认收款人：${name()}（UID ${id}）和数量`);
    } catch (error) { NSP.toast(error.message || '无法打开原站转账'); }
  });
  transfer.title = '打开论坛原生转账窗口，收款人和数量由你确认';
  const follow = make('follow', followState === true ? '已关注' : '关注', async () => {
    if (following) return;
    const desired = followState === true ? false : true;
    following = true; follow.disabled = true;
    try {
      requireAccount();
      const fresh = await NSP.api(`/api/account/getInfo/${id}`);
      if (fresh?.success !== true || typeof fresh.detail?.followed !== 'boolean') throw new Error('无法确认关注状态，请稍后再试');
      requireAccount();
      followState = fresh.detail.followed;
      if (followState === desired) { NSP.toast(desired ? '已经关注该用户' : '已取消关注'); return; }
      const result = await NSP.api(`/api/fans/${desired ? 'add' : 'del'}`, { method: 'POST', body: { followed_member_id: id } });
      if (result?.success !== true) throw new Error(result?.message || '关注结果未确认，请核对后重试');
      requireAccount();
      followState = desired;
      NSP.toast(desired ? '已关注' : '已取消关注');
    } catch (error) { NSP.toast(error.message || '关注操作失败'); }
    finally {
      following = false; follow.disabled = !sameAccount() || ownAccount;
      follow.textContent = followState === true ? '已关注' : '关注';
      follow.title = followState === true ? '点击取消关注' : '关注此用户';
    }
  });
  follow.title = followState === true ? '点击取消关注' : '关注此用户';
  make('message', '私信', () => {
    try {
      requireAccount();
      if (typeof NSP.openChat === 'function') NSP.openChat(id, name());
      else location.assign(`/notification#/message?mode=talk&to=${id}`);
    } catch (error) { NSP.toast(error.message || '请登录后使用私信'); }
  });
  const block = make('block', '屏蔽', async () => {
    if (blocking) return;
    const prior = blockState;
    blocking = true; block.disabled = true;
    try {
      requireAccount();
      const result = await NSP.api('/api/block-list/list');
      if (result?.success !== true || !Array.isArray(result.data) || result.data.some(row => !Number.isSafeInteger(Number(row?.block_member_id)) || Number(row.block_member_id) <= 0)) throw new Error('屏蔽状态读取失败');
      requireAccount();
      blockState = result.data.some(row => Number(row.block_member_id) === id);
      if (prior === null && blockState || prior !== null && prior !== blockState) {
        NSP.toast(blockState ? '该用户已经被屏蔽，再次点击可解除屏蔽' : '该用户当前未被屏蔽');
        return;
      }
      const label = blockState ? '解除屏蔽' : '屏蔽';
      if (!confirm(`${label} ${name()}（UID ${id}）？`)) return;
      requireAccount();
      const changed = await NSP.api(`/api/block-list/${blockState ? 'del' : 'add'}`, {
        method: 'POST', body: blockState ? { block_member_id: id } : { block_member_name: name() }
      });
      if (changed?.success !== true) throw new Error(changed?.message || '屏蔽结果未确认，请核对后重试');
      requireAccount();
      blockState = !blockState;
      NSP.toast(blockState ? '已屏蔽，刷新论坛后按站点规则隐藏内容' : '已解除屏蔽');
    } catch (error) { NSP.toast(error.message || '屏蔽操作失败'); }
    finally {
      blocking = false; block.disabled = !sameAccount() || ownAccount;
      block.textContent = blockState ? '解除屏蔽' : '屏蔽';
    }
  });
  return group;
};


// Source: 20-account.js
// Account helpers. Profile responses stay in memory; only notes and sign-in dates persist.
NSP.modules.push({
  id: 'account',
  start() {
    if (this.started) return;
    this.started = true;
    const site = location.hostname;
    const dayInShanghai = () => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    const signKey = (id, kind) => `account:${site}:${id}:sign:${kind}`;
    const supportsLocks = typeof navigator.locks?.request === 'function';
    let signing = false;
    const signButton = NSP.addTool('签到', () => { void signIn(false); });

    function renderSignButton() {
      const user = NSP.getUser();
      const day = dayInShanghai();
      const signed = !!user && NSP.store.get(signKey(user.id, 'done'), '') === day;
      const attempted = !!user && NSP.store.get(signKey(user.id, 'attempt'), '') === day;
      const label = signing ? '签到中…' : signed ? '今日已签到' : attempted ? '重试签到' : '签到';
      if (signButton.textContent !== label) signButton.textContent = label;
      signButton.disabled = signing || signed || !user;
      signButton.title = !user ? '登录后可以签到' : !supportsLocks
        ? '当前浏览器不支持跨标签互斥，请点击手动签到'
        : attempted && !signed ? '自动签到未确认成功；可手动重试，今日不再自动请求' : label;
      signButton.setAttribute('aria-busy', String(signing));
    }

    async function signIn(automatic) {
      const user = NSP.getUser();
      if (signing || !user || document.hidden || automatic && (!NSP.settings.autoSign || !supportsLocks)) return;
      const accountId = user.id;
      const day = dayInShanghai();
      if (NSP.store.get(signKey(accountId, 'done'), '') === day) return;
      if (automatic && NSP.store.get(signKey(accountId, 'attempt'), '') === day) return;
      signing = true;
      renderSignButton();
      const perform = async () => {
        // Recheck inside the lock: another tab may have completed while this one waited.
        if (document.hidden || NSP.getUser()?.id !== accountId || dayInShanghai() !== day) return;
        if (automatic && !NSP.settings.autoSign) return;
        if (NSP.store.get(signKey(accountId, 'done'), '') === day) return;
        if (automatic && NSP.store.get(signKey(accountId, 'attempt'), '') === day) return;
        // A failed or interrupted request must not create a background retry loop.
        NSP.store.set(signKey(accountId, 'attempt'), day);
        const random = NSP.settings.signMode === 'random';
        const result = await NSP.api(`/api/attendance?random=${random}`, { method: 'POST' });
        if (result?.success !== true) throw new Error(result?.message || '签到未确认成功，请手动重试');
        NSP.store.set(signKey(accountId, 'done'), day);
        if (NSP.getUser()?.id === accountId) {
          const gain = typeof result.gain === 'number' ? `，获得 ${result.gain} 鸡腿` : '';
          NSP.toast(result.message || `签到成功${gain}`);
        }
      };
      try {
        if (supportsLocks) {
          await navigator.locks.request(`nsp:sign:${site}:${accountId}`, { ifAvailable: true }, async lock => {
            if (lock) await perform();
            else if (!automatic) NSP.toast('另一个标签页正在签到，请稍后查看');
          });
        } else await perform();
      } catch (error) {
        if (NSP.getUser()?.id === accountId) NSP.toast(`签到未完成：${error?.message || '请求失败'}。可以手动重试。`);
      } finally {
        signing = false;
        renderSignButton();
      }
    }

    const checkSignIn = () => {
      renderSignButton();
      if (!document.hidden) void signIn(true);
    };
    document.addEventListener('visibilitychange', checkSignIn);
    window.addEventListener('focus', checkSignIn);
    setInterval(checkSignIn, 60_000);
    // Login state can become available after the initial document render.
    let lastAccount = '';
    NSP.observe(() => {
      const current = String(NSP.getUser()?.id || '');
      if (current !== lastAccount) {
        lastAccount = current;
        checkSignIn();
      }
    });
    checkSignIn();

    if (!NSP.settings.profiles) return;
    NSP.css(`
      .nsp-profile-card { position:fixed; z-index:2147483000; width:340px; max-width:calc(100vw - 20px);
        max-height:calc(100dvh - 20px); overflow:auto; box-sizing:border-box; padding:19px 18px 14px;
        border:1px solid #c9e2d2; border-radius:13px; background:linear-gradient(135deg,#eff9f0,#f6fcf8 66%,#edf8f3); color:#263d32;
        box-shadow:0 9px 32px #234c351f; font:13px/1.55 system-ui,-apple-system,"PingFang SC",sans-serif; }
      .nsp-profile-card[hidden] { display:none; }
      .nsp-profile-card * { box-sizing:border-box; }
      .nsp-profile-card a { color:inherit; text-decoration:none; }
      .nsp-profile-card a:hover { text-decoration:underline; }
      .nsp-profile-head { display:grid; grid-template-columns:44px minmax(0,1fr) auto; gap:10px; align-items:center;
        padding-bottom:14px; border-bottom:1px solid #cce3d4; }
      .nsp-profile-avatar { width:44px; height:44px; border-radius:9px; object-fit:cover; }
      .nsp-profile-identity { min-width:0; }
      .nsp-profile-name-line { display:flex; gap:4px; align-items:center; min-width:0; }
      .nsp-profile-name { font-size:15px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .nsp-profile-card .nsp-profile-copy { padding:2px 3px; border:0; background:transparent; color:#7c9587; cursor:pointer; font:17px/1 system-ui; }
      .nsp-profile-roles { display:flex; flex-wrap:wrap; gap:4px; margin-top:5px; }
      .nsp-profile-role { padding:1px 5px; border-radius:4px; color:#40805b; background:#dcefe2; font-size:10px; line-height:16px; }
      .nsp-profile-card .nsp-profile-score { display:flex; flex-direction:column; align-items:flex-end; gap:0; padding:0;
        border:0; background:transparent; color:#3b9560; cursor:help; white-space:nowrap; }
      .nsp-profile-score strong { font:600 34px/1 system-ui; font-variant-numeric:tabular-nums; letter-spacing:-1px; }
      .nsp-profile-score small { margin-top:5px; color:#799284; font-size:10px; font-weight:400; }
      .nsp-profile-id,.nsp-profile-status { color:var(--nsp-muted); font-size:12px; }
      .nsp-profile-card .nsp-profile-close { position:absolute; top:1px; right:4px; border:0; background:transparent;
        color:#8ba294; cursor:pointer; padding:0 4px; font-size:16px; line-height:19px; }
      .nsp-profile-facts { display:grid; grid-template-columns:1fr 1fr; gap:9px 22px; margin:17px 0 13px; }
      .nsp-profile-facts>div { display:flex; justify-content:space-between; gap:8px; min-width:0; }
      .nsp-profile-facts dt { display:flex; align-items:center; gap:6px; color:#61776a; white-space:nowrap; font-size:12px; }
      .nsp-profile-metric-icon { flex:none; width:14px; height:14px; color:#779384; }
      .nsp-profile-facts dd { margin:0; text-align:right; font-weight:500; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
      .nsp-profile-facts dd[data-kind=level] { color:#9c7420; background:#f9ecc6; border-radius:4px; padding:0 6px; font-weight:650; }
      .nsp-profile-bio { white-space:pre-wrap; overflow-wrap:anywhere; margin:11px 0 0; max-height:80px; overflow:auto; color:#6c8175; font-size:12px; }
      .nsp-profile-dates { display:flex; justify-content:space-between; align-items:center; gap:10px; border-top:1px solid #cce3d48c; padding-top:10px; }
      .nsp-profile-age { color:#3e8257; background:#e1f1e4; border-radius:5px; padding:2px 7px; font-size:12px; }
      .nsp-profile-joined { color:#8b9e92; font-size:11px; }
      .nsp-profile-actions { display:flex; gap:6px; margin:12px 0 0; align-items:center; }
      .nsp-profile-actions>* { flex:1; min-width:0; }
      .nsp-profile-card .nsp-profile-actions button,.nsp-profile-card .nsp-profile-actions a { border:1px solid transparent; border-radius:6px;
        padding:5px 6px; background:#218748; color:#fff; cursor:pointer; font:inherit; font-size:12px; line-height:1.5; text-align:center; white-space:nowrap; }
      .nsp-profile-card .nsp-profile-actions>:nth-child(2) { background:#1268de; }
      .nsp-profile-card .nsp-profile-actions>:nth-child(3) { background:#8548df; }
      .nsp-profile-card .nsp-profile-actions>:nth-child(4) { background:#d73236; }
      .nsp-profile-card .nsp-profile-actions>:hover:not(:disabled) { filter:brightness(1.06); text-decoration:none; }
      .nsp-profile-card .nsp-profile-actions>:disabled { opacity:.55; cursor:default; }
      .nsp-profile-notes { margin-top:10px; border-top:1px solid #cce3d48c; padding-top:7px; }
      .nsp-profile-notes summary { cursor:pointer; color:#80978a; font-size:11px; }
      .nsp-profile-note-label { display:block; color:var(--nsp-muted); font-size:12px; }
      .nsp-profile-note { display:block; width:100%; resize:vertical; min-height:60px; max-height:150px; margin-top:5px;
        padding:7px 9px; color:var(--nsp-text); background:var(--nsp-bg); border:1px solid var(--nsp-line);
        border-radius:8px; font:inherit; }
      .nsp-profile-card :focus-visible { outline:2px solid var(--nsp-accent); outline-offset:2px; }
      .nsp-dark .nsp-profile-card { color:#d1e3d8; border-color:#365746; background:linear-gradient(135deg,#1e3328,#20352d); box-shadow:0 10px 40px #0006; }
      .nsp-dark .nsp-profile-role { color:#9ac6a9; background:#314d3c; }
      .nsp-dark .nsp-profile-facts dt,.nsp-dark .nsp-profile-bio { color:#aec5b7; }
      .nsp-dark .nsp-profile-facts dd[data-kind=level] { color:#edce7f; background:#534529; }
      .nsp-dark .nsp-profile-score { color:#83c69b; }
      .nsp-dark .nsp-profile-age { color:#a2d4af; background:#304f3c; }
      .nsp-dark .nsp-profile-head,.nsp-dark .nsp-profile-dates,.nsp-dark .nsp-profile-notes { border-color:#54745c60; }
    `);

    const cache = new Map();
    const pending = new Map();
    const queue = [];
    const profileTTL = 5 * 60_000;
    let cacheGeneration = 0;
    let activeRequests = 0;
    function pump() {
      while (activeRequests < 2 && queue.length) {
        const job = queue.shift();
        activeRequests++;
        (async () => {
          try {
            const data = await NSP.api(`/api/account/getInfo/${job.id}`, { signal: job.controller.signal });
            if (job.generation !== cacheGeneration) throw new Error('资料缓存已清理');
            if (data?.success !== true || !data.detail || typeof data.detail !== 'object') {
              throw new Error(data?.message || '暂时无法读取资料');
            }
            const entry = { time: Date.now(), data: data.detail };
            cache.delete(job.id);
            cache.set(job.id, entry);
            while (cache.size > 100) cache.delete(cache.keys().next().value);
            job.resolve(entry.data);
          } catch (error) {
            job.reject(error);
          } finally {
            if (pending.get(job.id) === job) pending.delete(job.id);
            activeRequests--;
            pump();
          }
        })();
      }
    }
    function loadProfile(rawId, options = {}) {
      const id = Number(rawId);
      if (!Number.isSafeInteger(id) || id <= 0) return Promise.reject(new Error('用户编号无效'));
      const priority = options?.priority === 'badge' ? 'badge' : 'hover';
      const found = cache.get(id);
      if (found && Date.now() - found.time < profileTTL) return Promise.resolve(found.data);
      const existing = pending.get(id);
      if (existing) {
        const index = queue.indexOf(existing);
        if (priority === 'hover' && index >= 0 && existing.priority === 'badge') {
          queue.splice(index, 1);
          existing.priority = 'hover';
          const before = queue.findIndex(job => job.priority === 'badge');
          queue.splice(before < 0 ? queue.length : before, 0, existing);
        }
        return existing.promise;
      }
      // Badge prefetches leave room for interactive requests, and all queues stay bounded.
      if (queue.length >= (priority === 'badge' ? 64 : 72)) return Promise.reject(new Error('资料请求较多，请稍后再试'));
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const job = { id, priority, promise, resolve, reject, generation: cacheGeneration, controller: new AbortController() };
      pending.set(id, job);
      const before = priority === 'hover' ? queue.findIndex(item => item.priority === 'badge') : -1;
      queue.splice(before < 0 ? queue.length : before, 0, job);
      pump();
      return promise;
    }
    NSP.getProfile = loadProfile;

    const card = NSP.el('section', 'nsp-profile-card');
    card.hidden = true;
    card.id = 'nsp-profile-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '用户资料');
    document.body.append(card);
    let anchor = null;
    let showTimer, hideTimer;
    let generation = 0;
    let returningFocus = false;
    let dialogObserver;
    function profileLink(target) {
      if (!(target instanceof Element) || card.contains(target)) return null;
      const link = target.closest('a[href]');
      if (!link) return null;
      try {
        const url = new URL(link.href, location.href);
        const match = url.origin === location.origin && url.pathname.match(/^\/space\/([1-9]\d*)\/?$/);
        const id = match ? Number(match[1]) : 0;
        return Number.isSafeInteger(id) && id > 0 ? { link, id } : null;
      } catch { return null; }
    }
    function position() {
      if (card.hidden || !anchor?.isConnected) return;
      const source = anchor.getBoundingClientRect();
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      const below = source.bottom + 8;
      const top = below + height <= innerHeight - 10 ? below : Math.max(10, source.top - height - 8);
      card.style.left = `${Math.min(Math.max(10, source.left), Math.max(10, innerWidth - width - 10))}px`;
      card.style.top = `${Math.min(top, Math.max(10, innerHeight - height - 10))}px`;
    }
    function closeCard(returnFocus = false) {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      dialogObserver?.disconnect();
      dialogObserver = undefined;
      generation++;
      const focusedInside = card.contains(document.activeElement);
      card.hidden = true;
      anchor?.removeAttribute('aria-describedby');
      const previous = anchor;
      anchor = null;
      if (focusedInside) document.activeElement?.blur();
      // Keep the reusable card alive when a modal's contents are removed.
      if (card.parentElement !== document.body) document.body.append(card);
      const previousDialog = previous?.closest('dialog');
      if (returnFocus && previous?.isConnected && (!previousDialog || previousDialog.open)) {
        returningFocus = true;
        previous.focus({ preventScroll: true });
        returningFocus = false;
      }
    }
    NSP.registerCacheCleaner(() => {
      cacheGeneration++;
      cache.clear();
      for (const job of pending.values()) job.controller.abort();
      for (const job of queue.splice(0)) job.reject(new Error('资料缓存已清理'));
      pending.clear();
      closeCard();
      card.replaceChildren();
    });
    function delayedClose() {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      if (card.hidden) return;
      hideTimer = setTimeout(() => {
        if (!card.matches(':hover') && !card.contains(document.activeElement) && document.activeElement !== anchor) closeCard();
      }, 220);
    }
    function numberText(value) {
      return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : '未知';
    }
    function metricIcon(label) {
      const paths = {
        '等级': 'M4 2h8v4a4 4 0 0 1-8 0V2Zm0 1H2v2a3 3 0 0 0 3 3m7-5h2v2a3 3 0 0 1-3 3M8 10v3m-3 1h6',
        '主题帖': 'M4 1.5h6l3 3v10H3v-13h1Zm6 0v3h3M5.5 7h5m-5 3h5',
        '鸡腿': 'M6.3 9.7 4 12a1.5 1.5 0 1 1-2-2l2.3-2.3m1.1-4.1C7.5 1.5 11 1.2 13 3.2s1.7 5.5-.4 7.6c-1.2 1.2-3.6.5-5.5-1.4S4.2 4.8 5.4 3.6Z',
        '评论数': 'M2 2.5h12v8H6l-4 3v-11Zm3 3h6m-6 2.5h4',
        '星辰': 'm8 1.5 2 4.1 4.5.6-3.3 3.2.8 4.6-4-2.2L4 14l.8-4.6-3.3-3.2L6 5.6 8 1.5Z',
        '粉丝': 'M6 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm-4.5 6v-1.5a4.5 4.5 0 0 1 9 0V14m.5-11a2.5 2.5 0 0 1 0 5m1 2a3.5 3.5 0 0 1 2.5 3.5v.5'
      };
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'nsp-profile-metric-icon');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', paths[label] || '');
      svg.append(path);
      return svg;
    }
    function registration(value) {
      let timestamp = NaN;
      if (typeof value === 'number' && Number.isFinite(value)) timestamp = value < 100_000_000_000 ? value * 1000 : value;
      else if (typeof value === 'string' && value.trim()) timestamp = Date.parse(value);
      if (!Number.isFinite(timestamp) || timestamp > Date.now()) return ['未知', '未知'];
      const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp);
      return [date, `${Math.floor((Date.now() - timestamp) / 86_400_000).toLocaleString('zh-CN')} 天`];
    }
    async function openCard(link, id) {
      if (!NSP.settings.profiles || !link.isConnected) return;
      const ownerDialog = link.closest('dialog');
      // A hover timer may fire after the dialog has already closed.
      if (ownerDialog && !ownerDialog.open) return;
      const surface = ownerDialog || document.body;
      clearTimeout(hideTimer);
      if (anchor === link && !card.hidden) return;
      dialogObserver?.disconnect();
      dialogObserver = undefined;
      if (card.parentElement !== surface) surface.append(card);
      if (ownerDialog) {
        dialogObserver = new MutationObserver(() => {
          if (!ownerDialog.open) closeCard();
        });
        dialogObserver.observe(ownerDialog, { attributes: true, attributeFilter: ['open'] });
      }
      anchor?.removeAttribute('aria-describedby');
      anchor = link;
      anchor.setAttribute('aria-describedby', card.id);
      const ticket = ++generation;
      const fallbackName = link.textContent?.trim() || link.querySelector('img')?.alt?.trim() || `用户 ${id}`;
      const heading = NSP.el('div', 'nsp-profile-head');
      const avatar = NSP.el('img', 'nsp-profile-avatar');
      avatar.src = `/avatar/${id}.png`;
      avatar.alt = '';
      const identity = NSP.el('div', 'nsp-profile-identity');
      const nameLine = NSP.el('div', 'nsp-profile-name-line');
      const name = NSP.el('a', 'nsp-profile-name', fallbackName);
      name.href = `/space/${id}`;
      name.title = `个人主页 · UID ${id}`;
      const copy = NSP.button('⧉', async () => {
        try {
          await navigator.clipboard.writeText(name.textContent || fallbackName);
          NSP.toast('已复制用户名');
        } catch { NSP.toast('复制失败，请手动选择用户名复制'); }
      }, 'nsp-profile-copy');
      copy.title = '复制用户名';
      copy.setAttribute('aria-label', '复制用户名');
      nameLine.append(name, copy);
      const roles = NSP.el('div', 'nsp-profile-roles');
      roles.hidden = true;
      identity.append(nameLine, roles);
      const score = NSP.button('', () => NSP.toast(score.title), 'nsp-profile-score');
      const points = NSP.el('strong', '', '—');
      score.append(points, NSP.el('small', '', '参考信任分'));
      score.title = '参考信任分，仅供资料参考，非官方评级，不代表交易信用。资料读取后显示。';
      score.setAttribute('aria-label', '参考信任分，资料尚未读取');
      heading.append(avatar, identity, score);
      const dismiss = NSP.button('×', () => closeCard(true), 'nsp-profile-close');
      dismiss.setAttribute('aria-label', '关闭用户资料');
      const details = NSP.el('div');
      const status = NSP.el('p', 'nsp-profile-status', '正在读取资料…');
      status.setAttribute('role', 'status');
      details.append(status);
      let actions = NSP.el('div', 'nsp-profile-actions');
      const profile = NSP.el('a', '', '个人主页');
      profile.href = `/space/${id}`;
      profile.target = '_blank';
      profile.rel = 'noopener noreferrer';
      const chat = NSP.button('私信', () => {
        if (!NSP.getUser()) { NSP.toast('请先登录后发送私信'); return; }
        if (typeof NSP.openChat === 'function') NSP.openChat(id, name.textContent);
        else location.assign(`/notification#/message?mode=talk&to=${id}`);
        closeCard();
      });
      chat.hidden = NSP.getUser()?.id === id;
      actions.append(profile, chat);
      const notes = NSP.el('details', 'nsp-profile-notes');
      notes.append(NSP.el('summary', '', '本地备注'));
      notes.addEventListener('toggle', position);
      const label = NSP.el('label', 'nsp-profile-note-label', '我的备注（仅保存在本机）');
      const note = NSP.el('textarea', 'nsp-profile-note');
      note.rows = 2;
      note.maxLength = 500;
      note.placeholder = '例如：交流过的主题、待跟进事项';
      const noteOwner = NSP.getUser()?.id || 'guest';
      const noteKey = `account:${site}:${noteOwner}:note:${id}`;
      const savedNote = NSP.store.get(noteKey, '');
      note.value = typeof savedNote === 'string' ? savedNote : '';
      note.addEventListener('input', () => {
        NSP.store.set(noteKey, note.value.slice(0, 500));
      });
      label.append(note);
      notes.append(label);
      card.replaceChildren(dismiss, heading, details, actions, notes);
      card.hidden = false;
      position();
      try {
        const data = await loadProfile(id);
        if (ticket !== generation || card.hidden) return;
        if (typeof data.member_name === 'string' && data.member_name.trim()) name.textContent = data.member_name.trim();
        const [date, age] = registration(data.created_at);
        const hasMetrics = typeof NSP.profileMetrics === 'function';
        const metrics = hasMetrics ? NSP.profileMetrics(data) : {};
        const actualLevel = hasMetrics ? metrics.level : data.rank;
        const level = Number.isSafeInteger(actualLevel) && actualLevel >= 0 ? `Lv ${actualLevel}` : '未知';
        const referenceScore = Number.isFinite(metrics.score) && metrics.score >= 0 && metrics.score <= 100 ? metrics.score : null;
        points.textContent = referenceScore === null ? '—' : String(referenceScore);
        const explanation = typeof NSP.scoreDescription === 'function'
          ? NSP.scoreDescription()
          : '参考信任分，仅供资料参考，非官方评级，不代表交易信用。';
        const scoreParts = (Array.isArray(metrics.breakdown) ? metrics.breakdown : [])
          .filter(part => typeof part?.label === 'string' && Number.isFinite(part.points) && Number.isFinite(part.max))
          .map(part => `${part.label}：${Number(part.points.toFixed(1))}/${part.max}`);
        score.title = [referenceScore === null ? '资料不足，暂不评分。' : `参考信任分 ${referenceScore}/100`, explanation, ...scoreParts].join('\n');
        score.setAttribute('aria-label', referenceScore === null ? '参考信任分未知，查看说明' : `参考信任分 ${referenceScore}，查看说明`);
        const roleNames = new Set((Array.isArray(data.roles) ? data.roles : []).map(role => {
          if (typeof role === 'string') return role;
          return role?.display_text || role?.title || role?.name;
        }).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 40)));
        if ((data.isAdmin === true || typeof data.isAdmin === 'number' && data.isAdmin > 0) &&
          ![...roleNames].some(value => /管理|^admin(?:istrator)?$/i.test(value))) roleNames.add('管理员');
        roles.replaceChildren(...[...roleNames].slice(0, 5).map(value => NSP.el('span', 'nsp-profile-role', value)));
        roles.hidden = !roleNames.size;
        const facts = NSP.el('dl', 'nsp-profile-facts');
        const balance = value => Number.isSafeInteger(value) ? value.toLocaleString('zh-CN') : '未知';
        for (const [term, value] of [['等级', level], ['主题帖', numberText(data.nPost)], ['鸡腿', balance(data.coin)], ['评论数', numberText(data.nComment)], ['星辰', balance(data.stardust)], ['粉丝', numberText(data.fans)]]) {
          const cell = NSP.el('div');
          const termNode = NSP.el('dt');
          termNode.append(metricIcon(term), NSP.el('span', '', term));
          const valueNode = NSP.el('dd', '', value);
          if (term === '等级' && level !== '未知') valueNode.dataset.kind = 'level';
          cell.append(termNode, valueNode);
          facts.append(cell);
        }
        const dates = NSP.el('div', 'nsp-profile-dates');
        const ageLabel = Number.isFinite(metrics.days) && metrics.days >= 0 ? `加入 ${Math.floor(metrics.days).toLocaleString('zh-CN')} 天`
          : !hasMetrics && age !== '未知' ? `加入 ${age}` : '加入时长未知';
        const joined = typeof metrics.joined === 'string' && metrics.joined ? metrics.joined : date;
        dates.append(NSP.el('span', 'nsp-profile-age', ageLabel), NSP.el('span', 'nsp-profile-joined', `注册 ${joined}`));
        const bioText = [data.bio, data.introduction, data.signature_text, data.signature].find(value => typeof value === 'string' && value.trim());
        // All server-provided content is text; no profile HTML is inserted.
        details.replaceChildren(facts, dates);
        if (bioText) details.prepend(NSP.el('p', 'nsp-profile-bio', bioText.trim()));
        if (typeof NSP.profileActions === 'function') {
          const readyActions = NSP.profileActions(id, () => name.textContent || fallbackName, data);
          if (readyActions instanceof HTMLElement) {
            readyActions.classList.add('nsp-profile-actions');
            readyActions.addEventListener('click', event => {
              const control = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
              if (control && !control.disabled && ['transfer', 'message'].includes(control.dataset.action)) closeCard();
            });
            actions.replaceWith(readyActions);
            actions = readyActions;
          }
        }
        position();
      } catch (error) {
        if (ticket !== generation || card.hidden) return;
        status.textContent = `资料读取失败：${error?.message || '请稍后再试'}`;
        position();
      }
    }
    const scheduleOpen = (target, delay) => {
      const found = profileLink(target);
      if (!found) return;
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      showTimer = setTimeout(() => { void openCard(found.link, found.id); }, delay);
    };
    // Delegation also covers newly inserted comments and message bubbles.
    document.addEventListener('pointerover', event => {
      if (event.pointerType === 'touch') return;
      const found = profileLink(event.target);
      if (!found || event.relatedTarget instanceof Node && found.link.contains(event.relatedTarget)) return;
      scheduleOpen(event.target, 350);
    });
    document.addEventListener('pointerout', event => {
      const found = profileLink(event.target);
      if (found && !(event.relatedTarget instanceof Node && (found.link.contains(event.relatedTarget) || card.contains(event.relatedTarget)))) delayedClose();
    });
    document.addEventListener('focusin', event => {
      if (!returningFocus) scheduleOpen(event.target, 0);
    });
    document.addEventListener('focusout', event => {
      if ((profileLink(event.target) || card.contains(event.target)) && !(event.relatedTarget instanceof Node && card.contains(event.relatedTarget))) delayedClose();
    });
    card.addEventListener('pointerenter', () => { clearTimeout(hideTimer); });
    card.addEventListener('pointerleave', delayedClose);
    document.addEventListener('close', event => {
      if (!card.hidden && event.target instanceof Element && event.target.contains(card)) closeCard();
    }, true);
    NSP.observe(() => {
      if (card.hidden) return;
      const ownerDialog = anchor?.closest('dialog');
      if (!anchor?.isConnected || !card.isConnected || ownerDialog && !ownerDialog.open) closeCard();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' && !card.hidden && document.activeElement === anchor) {
        event.preventDefault();
        card.querySelector('button')?.focus();
      }
      if (event.key === 'Escape' && !card.hidden) {
        event.preventDefault();
        closeCard(card.contains(document.activeElement));
      }
    });
    document.addEventListener('pointerdown', event => {
      if (!card.hidden && !card.contains(event.target) && !anchor?.contains(event.target)) closeCard();
    });
    window.addEventListener('resize', position);
    document.addEventListener('scroll', event => {
      if (event.target instanceof Node && card.contains(event.target)) return;
      if (!card.hidden && !card.contains(document.activeElement)) closeCard();
    }, { passive: true, capture: true });
  }
});


// Source: 25-badges.js
/* Compact profile badges beside visible forum authors. */
NSP.modules.push({
  id: 'badges',
  start() {
    if (!NSP.settings.profiles || NSP.settings.badges === false) return;
    if (typeof NSP.getProfile !== 'function' || typeof NSP.profileMetrics !== 'function') return;

    const selector = [
      '.author-info > a[href]', 'a.author-name[href]', '.author-name > a[href]',
      'a.info-author[href]', '.info-author > a[href]',
      'a.post-author[href]', '.post-author > a[href]',
      '.post-list-item .post-title a[href]'
    ].join(',');
    const excluded = 'nav,[role="navigation"],.nsp-profile-card,.nsp-chat,.nsp-tools,.nsp-settings,.nsp-user-badges';
    const records = new Map();
    const pending = new Map();
    const scanRoots = new Set();
    let scheduled = false;
    let stopped = false;
    let fallbackScheduled = false;

    function authorId(anchor) {
      if (!(anchor instanceof HTMLAnchorElement) || !anchor.matches(selector)) return null;
      if (anchor.closest(excluded) || anchor.querySelector('img,picture,canvas') || !anchor.textContent.trim()) return null;
      const url = NSP.safeURL(anchor.getAttribute('href'), location.href, { sameOrigin: true });
      const id = url && /^\/space\/([1-9]\d*)\/?$/.exec(url.pathname)?.[1];
      return id && Number.isSafeInteger(Number(id)) ? Number(id) : null;
    }

    function icon(kind) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      if (kind === 'score') {
        path.setAttribute('d', 'M3 7l4 3 5-6 5 6 4-3-2 11H5L3 7Zm2 13h14v2H5z');
        path.setAttribute('fill', 'currentColor');
      } else {
        path.setAttribute('d', kind === 'days'
          ? 'M5 5h14v16H5zM8 2v6m8-6v6M5 10h14M8 14h2m4 0h2m-8 3h2'
          : 'm12 2 8 10-8 10-8-10L12 2Zm-8 10h16M12 2l4 10-4 10-4-10 4-10Z');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', kind === 'days' ? '1.8' : '1.5');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-linecap', 'round');
      }
      svg.append(path);
      return svg;
    }

    function badge(kind, label, description) {
      const node = NSP.el('span', `nsp-user-badge nsp-user-badge-${kind}`);
      node.title = description;
      node.setAttribute('aria-label', description);
      node.tabIndex = 0;
      node.append(icon(kind), NSP.el('span', '', label));
      return node;
    }

    function makeBadges(id, user) {
      const metrics = NSP.profileMetrics(user, Date.now());
      if (!metrics || typeof metrics !== 'object') return null;
      const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      const wrapper = NSP.el('span', 'nsp-user-badges');
      wrapper.dataset.nspUser = String(id);
      wrapper.setAttribute('role', 'group');
      wrapper.setAttribute('aria-label', '用户资料摘要');
      if (known(metrics.score)) {
        const value = String(Math.round(metrics.score * 10) / 10);
        const basis = typeof NSP.scoreDescription === 'function'
          ? NSP.scoreDescription()
          : '根据公开资料计算的非官方参考分，不代表交易信用。';
        const details = Array.isArray(metrics.breakdown) ? metrics.breakdown.filter(part =>
          part && typeof part.label === 'string' && known(part.points) && known(part.max)
        ).map(part => `${part.label} ${Number(part.points.toFixed(1))}/${part.max}`).join('；') : '';
        wrapper.append(badge('score', value, `参考信任分：${value}\n${basis}${details ? `\n${details}` : ''}`));
      }
      if (known(metrics.days)) {
        const days = Math.floor(metrics.days);
        const date = typeof metrics.joined === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(metrics.joined)
          ? `（注册日期：${metrics.joined}）` : '';
        wrapper.append(badge('days', `${days}天`, `注册至今 ${days} 天${date}`));
      }
      if (known(metrics.level)) {
        const level = Math.floor(metrics.level);
        wrapper.append(badge('level', `Lv${level}`, `论坛账号等级：Lv${level}`));
      }
      return wrapper.childElementCount ? wrapper : null;
    }

    function removeRecord(anchor) {
      const record = records.get(anchor);
      if (!record) return;
      intersection?.unobserve(anchor);
      record.wrapper?.remove();
      records.delete(anchor);
    }

    async function load(record) {
      const { anchor, id } = record;
      if (stopped || record.status !== 'waiting' || !anchor.isConnected || authorId(anchor) !== id) return;
      record.status = 'loading';
      intersection?.unobserve(anchor);
      let task = pending.get(id);
      if (!task) {
        // The account module owns caching, request limits and hover priority.
        task = Promise.resolve().then(() => NSP.getProfile(id, { priority: 'badge' }));
        pending.set(id, task);
        task.then(() => { if (pending.get(id) === task) pending.delete(id); },
          () => { if (pending.get(id) === task) pending.delete(id); });
      }
      try {
        const user = await task;
        if (stopped || records.get(anchor) !== record || !anchor.isConnected || authorId(anchor) !== id) return;
        record.wrapper = makeBadges(id, user);
        record.status = 'done';
        if (record.wrapper) anchor.after(record.wrapper);
      } catch {
        // A failed/unknown profile gets no invented score and no retry loop.
        if (records.get(anchor) === record) record.status = 'failed';
      }
    }

    const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        const record = records.get(entry.target);
        if (record) void load(record);
      }
    }, { rootMargin: '240px 0px', threshold: 0 }) : null;

    function checkNearby() {
      fallbackScheduled = false;
      if (stopped || intersection) return;
      for (const record of records.values()) {
        if (record.status !== 'waiting' || !record.anchor.getClientRects().length) continue;
        const rect = record.anchor.getBoundingClientRect();
        if (rect.bottom >= -240 && rect.top <= innerHeight + 240 && rect.right >= 0 && rect.left <= innerWidth) void load(record);
      }
    }

    function scheduleNearby() {
      if (fallbackScheduled || stopped || intersection) return;
      fallbackScheduled = true;
      requestAnimationFrame(checkNearby);
    }

    function bind(anchor) {
      const id = authorId(anchor);
      const old = records.get(anchor);
      if (old?.id === id) return;
      if (old) removeRecord(anchor);
      if (!id) return;
      // Vue may replace or clone forum rows. Do not keep copied badges as data.
      const copied = anchor.nextElementSibling;
      if (copied?.classList.contains('nsp-user-badges')) copied.remove();
      const record = { anchor, id, status: 'waiting', wrapper: null };
      records.set(anchor, record);
      if (intersection) intersection.observe(anchor);
      else scheduleNearby();
    }

    function flushScan() {
      scheduled = false;
      if (stopped) return;
      const roots = [...scanRoots];
      scanRoots.clear();
      for (const root of roots) {
        if (!root.isConnected && root !== document) continue;
        if (root instanceof Element && root.matches(selector)) bind(root);
        root.querySelectorAll?.(selector).forEach(bind);
      }
      for (const [anchor, record] of records) {
        if (!anchor.isConnected || authorId(anchor) !== record.id) removeRecord(anchor);
        else if (record.wrapper && record.wrapper.previousElementSibling !== anchor) {
          // Keep the same badge instance when the site's renderer moves siblings.
          anchor.after(record.wrapper);
        }
      }
    }

    function scheduleScan(root) {
      if (stopped || !root) return;
      scanRoots.add(root);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flushScan);
    }

    const observer = new MutationObserver(changes => {
      for (const change of changes) {
        const target = change.target instanceof Element ? change.target : change.target.parentElement;
        if (!target || target.closest(excluded)) continue;
        if (change.type === 'attributes' || change.type === 'characterData') {
          scheduleScan(target.closest('a') || target);
          continue;
        }
        const changed = [...change.addedNodes, ...change.removedNodes];
        if (changed.length && changed.every(node => node instanceof Element && node.classList.contains('nsp-user-badges'))) continue;
        scheduleScan(target);
      }
    });
    function watch() {
      observer.observe(document.body, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['href', 'class']
      });
    }
    watch();
    if (!intersection) {
      window.addEventListener('scroll', scheduleNearby, { passive: true });
      window.addEventListener('resize', scheduleNearby, { passive: true });
    }
    window.addEventListener('pagehide', () => {
      stopped = true;
      observer.disconnect();
      intersection?.disconnect();
      scanRoots.clear();
      pending.clear();
      for (const anchor of [...records.keys()]) removeRecord(anchor);
    });
    window.addEventListener('pageshow', event => {
      if (!event.persisted || !stopped) return;
      stopped = false;
      scheduled = false;
      fallbackScheduled = false;
      watch();
      scheduleScan(document);
    });

    NSP.css(`
      .nsp-user-badges{display:inline-flex;align-items:center;gap:2px;vertical-align:baseline;margin:0 0 0 3px;white-space:nowrap;font:inherit;line-height:1;max-width:100%}
      .nsp-user-badges .nsp-user-badge{display:inline-flex;align-items:center;justify-content:center;gap:1px;min-height:0;padding:0 2px;border-radius:2px;font:inherit;font-size:.8em;font-weight:400;line-height:1;font-variant-numeric:tabular-nums;box-sizing:border-box;text-decoration:none;cursor:help}
      .nsp-user-badges .nsp-user-badge>span{font:inherit;line-height:inherit}
      .nsp-user-badge svg{display:block;width:.85em;height:.85em;flex:none}.nsp-user-badge-score{color:#ffe48a;background:#c7333b;border:1px solid #b72d34}.nsp-user-badge-days{color:#187e51;background:#e8f6ed;border:1px solid #cce7d6}.nsp-user-badge-level{color:#8b5d0d;background:#fff2cf;border:1px solid #e9ce8c}
      .nsp-user-badge:focus-visible{outline:2px solid var(--nsp-accent,#16835c);outline-offset:2px}.nsp-dark .nsp-user-badge-score{color:#ffe99a;background:#8e2932;border-color:#bd4651}.nsp-dark .nsp-user-badge-days{color:#8cd4aa;background:#233c30;border-color:#355947}.nsp-dark .nsp-user-badge-level{color:#ebca81;background:#3c3321;border-color:#64522c}
    `);
    scheduleScan(document);
  }
});


// Source: 28-inbox-entry.js
// An inbox shortcut on the forum's own account card. The native notice link stays intact.
NSP.modules.push({
  id: 'inbox-entry',
  start() {
    if (this.started || NSP.settings.chat === false) return;
    this.started = true;
    const records = new Map();
    const excluded = '.hover-user-card,[data-nsp-ui],.nsp-profile-card,.nsp-chat,.nsp-tools,.nsp-settings';

    NSP.css(`
      .user-card .nsp-inbox-entry { margin-top:12px; }
      .user-card .nsp-inbox-entry-button { display:flex; align-items:center; gap:9px; width:100%; box-sizing:border-box;
        padding:10px 12px; border:1px solid #c9dfd0; border-radius:8px; background:#edf7f0; color:#347951;
        text-align:left; font:inherit; font-size:13px; font-weight:600; line-height:1.4; cursor:pointer; }
      .user-card .nsp-inbox-entry-button:hover { background:#e0f0e5; border-color:#a6cdb4; }
      .user-card .nsp-inbox-entry-button:focus-visible { outline:2px solid var(--nsp-accent,#218748); outline-offset:2px; }
      .nsp-inbox-entry-icon { width:18px; height:18px; flex:none; }
      .nsp-inbox-entry-arrow { margin-left:auto; font-size:20px; font-weight:400; line-height:1; opacity:.65; }
      .nsp-dark .user-card .nsp-inbox-entry-button { background:#233c2d; border-color:#3a5b46; color:#a3d4b3; }
      .nsp-dark .user-card .nsp-inbox-entry-button:hover { background:#2c4a36; border-color:#62856c; }
    `);

    function ownCard(card, accountId) {
      if (card.closest(excluded)) return false;
      let notification = false;
      const profileIds = new Set();
      for (const link of card.querySelectorAll('a[href]')) {
        if (link.closest('.user-card') !== card || link.closest(excluded)) continue;
        const url = NSP.safeURL(link.getAttribute('href'), location.href, { sameOrigin: true });
        if (!url) continue;
        if (url.pathname.replace(/\/$/, '') === '/notification') notification = true;
        const profile = /^\/space\/([1-9]\d*)\/?$/.exec(url.pathname);
        if (profile && Number.isSafeInteger(Number(profile[1]))) profileIds.add(Number(profile[1]));
      }
      // The forum's own card has notifications; a different member's profile must not acquire our inbox entry.
      return notification && (!profileIds.size || profileIds.has(accountId));
    }

    function makeEntry() {
      const wrapper = NSP.el('div', 'nsp-inbox-entry');
      wrapper.dataset.nspUi = '';
      const button = NSP.button('', () => {
        if (NSP.settings.chat === false) return;
        if (!NSP.getUser()) { NSP.toast('请先登录后打开私信'); return; }
        if (typeof NSP.openChat === 'function') NSP.openChat();
        else NSP.toast('私信面板尚未就绪，请刷新页面后重试');
      }, 'nsp-inbox-entry-button');
      button.setAttribute('aria-label', '打开私信收件箱');
      button.title = '打开私信收件箱';
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'nsp-inbox-entry-icon');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '1.6');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      const path = document.createElementNS(icon.namespaceURI, 'path');
      path.setAttribute('d', 'M5 3.5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-9l-5 3v-3a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2ZM7.5 9h9m-9 4h6');
      icon.append(path);
      const arrow = NSP.el('span', 'nsp-inbox-entry-arrow', '›');
      arrow.setAttribute('aria-hidden', 'true');
      button.append(icon, NSP.el('span', '', '私信'), arrow);
      wrapper.append(button);
      return wrapper;
    }

    function scan() {
      const user = NSP.settings.chat === false ? null : NSP.getUser();
      for (const [card, wrapper] of records) {
        if (!user || !card.isConnected || !ownCard(card, user.id)) {
          wrapper.remove();
          records.delete(card);
        }
      }
      if (!user) return;
      for (const card of document.querySelectorAll('.user-card')) {
        if (!ownCard(card, user.id)) continue;
        let wrapper = records.get(card);
        if (!wrapper || !card.contains(wrapper)) {
          wrapper?.remove();
          wrapper = makeEntry();
          records.set(card, wrapper);
        }
        // A Vue rerender or cloned card can retain markup without its event handler.
        for (const duplicate of card.querySelectorAll('.nsp-inbox-entry')) {
          if (duplicate !== wrapper && duplicate.closest('.user-card') === card) duplicate.remove();
        }
        const statistics = [...card.querySelectorAll('.user-stat')].find(node => node.closest('.user-card') === card);
        if (statistics) {
          if (statistics.nextElementSibling !== wrapper) statistics.after(wrapper);
        } else if (wrapper.parentElement !== card) card.append(wrapper);
      }
    }
    NSP.observe(scan);
  }
});


// Source: 30-messages.js
/* Personal message panel. Only forum API schemas are shared with the site. */
NSP.modules.push({
  id: 'messages',
  start() {
    if (!NSP.settings.chat) return;

    const apiRoot = '/api/notification/message';
    const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
    const ui = (tag, name = '', text = '') => NSP.el(tag, name, text);
    const action = (label, handler, name = '') => {
      const button = NSP.button(label, handler, name);
      button.type = 'button';
      return button;
    };
    const when = value => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    };
    const ago = value => {
      const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
      if (!Number.isFinite(elapsed)) return '';
      if (elapsed < 60000) return '刚刚';
      if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前`;
      if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)} 小时前`;
      if (elapsed < 86400000 * 30) return `${Math.floor(elapsed / 86400000)} 天前`;
      return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    };
    const icon = name => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.8');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', {
        refresh: 'M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5',
        reply: 'M4 4h16v12H9l-5 4V4m4 4h8m-8 4h6',
        bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4'
      }[name] || 'M6 6l12 12M6 18L18 6');
      svg.append(path);
      return svg;
    };
    const avatar = (id, name) => {
      const holder = ui('span', 'nsp-chat-monogram', [...name][0] || '?');
      holder.setAttribute('aria-hidden', 'true');
      const image = ui('img', 'nsp-chat-avatar');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      image.src = `/avatar/${id}.png`;
      image.addEventListener('error', () => image.remove(), { once: true });
      holder.append(image);
      return holder;
    };
    const time = row => new Date(row.created_at).getTime() || 0;
    const unread = row => row.viewed === false || row.viewed === 0 || row.viewed === '0';
    const errorText = error => error && typeof error.message === 'string' ? error.message : '请求未完成，请稍后重试';
    const messageId = row => validId(row.id);
    const latestId = row => row ? validId(row.max_id) || messageId(row) : null;
    const compareLatest = (left, right) => time(left) - time(right) || (latestId(left) || 0) - (latestId(right) || 0);
    const contactSummary = row => ({
      id: row.id, max_id: row.max_id, sender_id: row.sender_id, receiver_id: row.receiver_id,
      created_at: row.created_at, viewed: row.viewed, content: row.content.slice(0, 300)
    });
    const messageKey = row => messageId(row) ? `id:${row.id}` : JSON.stringify([
      row.sender_id, row.receiver_id, row.created_at, row.content
    ]);

    // Private content never enters localStorage, IndexedDB, or userscript storage.
    // Drafts and unresolved-send guards last only for this page's lifetime.
    const drafts = new Map();
    const failures = new Map();
    const sending = new Map();
    const contacts = new Map();
    const conversations = new Map();
    const confirmedThreads = new Set();
    const cacheLimits = Object.freeze({ contacts: 200, conversations: 20, perConversation: 200, totalMessages: 1000 });
    let accountId = null;
    let activeId = null;
    let session = null;
    let sequence = 0;
    let threadSequence = 0;
    let listSequence = 0;
    let threadController = null;
    let listController = null;
    let timer = null;
    let page = 0;
    let lastPageKey = '';
    let moreAvailable = true;
    let threadBusy = false;
    let listBusy = false;
    let markAllBusy = false;
    let previousFocus = null;
    let lastRenderKey = '';
    let dismissedRoute = null;
    let observedLocation = `${location.pathname}${location.search}${location.hash}`;
    let routeScheduled = false;
    let routeSuspended = false;

    const dialog = ui('dialog', 'nsp-chat');
    dialog.setAttribute('aria-label', '私信聊天');
    const top = ui('header', 'nsp-chat-top');
    const title = ui('h2', '', '消息');
    const markAll = action('全部已读', () => markAllViewed(), 'nsp-chat-mark-all');
    markAll.title = '将全部私信标为已读，包括尚未加载的会话';
    const native = ui('a', 'nsp-chat-native', '原版页面');
    native.href = '/notification#/message?native=1';
    native.target = '_blank';
    native.rel = 'noopener noreferrer';
    native.dataset.nspNative = 'true';
    const close = action('关闭', () => closePanel(), 'nsp-chat-close');
    const clear = action('清缓存', () => NSP.clearCaches(), 'nsp-chat-clear-cache');
    clear.title = '清理缓存并关闭私信，保留设置、备注和草稿';
    top.append(title, markAll, clear, native, close);

    const layout = ui('div', 'nsp-chat-layout');
    const sidebar = ui('aside', 'nsp-chat-sidebar');
    sidebar.setAttribute('aria-label', '私信联系人');
    const searchBar = ui('div', 'nsp-chat-searchbar');
    const search = ui('input', 'nsp-chat-search');
    search.type = 'search';
    search.placeholder = '搜索联系人或消息';
    search.setAttribute('aria-label', '搜索已加载的联系人或消息');
    search.title = '搜索已加载的联系人与最近消息';
    const refreshList = action('', () => loadContacts(false), 'nsp-chat-refresh');
    refreshList.append(icon('refresh'));
    refreshList.setAttribute('aria-label', '刷新联系人');
    refreshList.title = '刷新联系人';
    searchBar.append(search, refreshList);
    const contactStatus = ui('p', 'nsp-chat-status');
    contactStatus.setAttribute('role', 'status');
    const contactList = ui('div', 'nsp-chat-contacts');
    const shortcuts = ui('nav', 'nsp-chat-shortcuts');
    shortcuts.setAttribute('aria-label', '其他通知');
    for (const [name, description, route, kind] of [
      ['@我', '查看提到我的消息', 'atMe', 'mention'],
      ['回复主题', '查看主题回复', 'reply', 'reply']
    ]) {
      const link = ui('a', 'nsp-chat-shortcut');
      link.href = `/notification#/${route}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = '在原版页面打开';
      const mark = ui('span', `nsp-chat-category-icon nsp-chat-category-${kind}`);
      mark.setAttribute('aria-hidden', 'true');
      if (kind === 'mention') mark.textContent = '@';
      else mark.append(icon('reply'));
      const label = ui('span', 'nsp-chat-contact-details');
      label.append(ui('strong', '', name), ui('span', 'nsp-chat-preview', description));
      link.append(mark, label);
      shortcuts.append(link);
    }
    const contactScroll = ui('div', 'nsp-chat-contact-scroll');
    contactScroll.append(shortcuts, contactList);
    const loadMore = action('加载更多联系人', () => loadContacts(true), 'nsp-chat-more');
    sidebar.append(searchBar, contactStatus, contactScroll, loadMore);

    const main = ui('section', 'nsp-chat-main');
    main.setAttribute('aria-label', '聊天内容');
    const heading = ui('header', 'nsp-chat-heading');
    const back = action('‹ 联系人', () => {
      saveDraft();
      activeId = null;
      threadController?.abort();
      threadSequence++;
      threadBusy = false;
      dialog.classList.remove('nsp-chat-has-peer');
      renderHeader();
      renderContacts();
      search.focus();
    }, 'nsp-chat-back');
    const peerName = ui('strong', 'nsp-chat-peer-name', '选择一个联系人');
    const profile = ui('a', 'nsp-chat-profile', '资料 ↗');
    profile.target = '_blank';
    profile.rel = 'noopener noreferrer';
    profile.hidden = true;
    const refreshThread = action('刷新记录', () => loadThread({ manual: true }));
    heading.append(back, peerName, profile, refreshThread);
    const thread = ui('div', 'nsp-chat-thread');
    thread.tabIndex = 0;
    thread.setAttribute('aria-label', '聊天记录');
    const threadStatus = ui('div', 'nsp-chat-status nsp-chat-thread-status');
    threadStatus.setAttribute('role', 'status');
    const warning = ui('div', 'nsp-chat-warning');
    warning.hidden = true;
    const warningText = ui('p');
    const unlock = action('已核对未发送，解除防重', () => {
      const failure = failures.get(activeId);
      if (!isCurrent() || !failure || !failure.verified) return;
      if (!window.confirm('请确认已检查最新聊天记录，本条消息没有发送成功。解除后仍需手动点击“发送”。')) return;
      failures.delete(activeId);
      updateComposer();
      input.focus();
    });
    const acknowledge = action('已确认发送，清空草稿', () => {
      const failure = failures.get(activeId);
      if (!isCurrent() || !failure?.verified) return;
      if (!window.confirm('确认这条消息已经发送成功，并清空当前会话的草稿？')) return;
      failures.delete(activeId);
      drafts.delete(activeId);
      input.value = '';
      updateComposer();
    });
    warning.append(warningText, unlock, acknowledge);
    const composer = ui('div', 'nsp-chat-composer');
    const input = ui('textarea', 'nsp-chat-input');
    input.rows = 3;
    input.placeholder = '写下消息…';
    input.setAttribute('aria-label', '私信内容');
    const composeFooter = ui('div', 'nsp-chat-compose-footer');
    const composeHint = ui('small', '', 'Enter 换行 · Ctrl / ⌘ + Enter 发送');
    input.title = '草稿仅留当前页，刷新后清除';
    const send = action('发送', () => sendMessage(), 'nsp-chat-send');
    composeFooter.append(composeHint, send);
    composer.append(input, composeFooter);
    main.append(heading, thread, threadStatus, warning, composer);
    layout.append(sidebar, main);
    dialog.append(top, layout);
    document.body.append(dialog);

    function isCurrent(expected = session) {
      if (!expected || session !== expected || !dialog.open || expected.controller.signal.aborted) return false;
      if (validId(NSP.getUser()?.id) !== expected.account) {
        closePanel({ dismiss: false });
        forgetAccount();
        NSP.toast('登录账号已变化，私信面板已关闭');
        return false;
      }
      return true;
    }

    function forgetAccount() {
      drafts.clear();
      failures.clear();
      sending.clear();
      contacts.clear();
      conversations.clear();
      confirmedThreads.clear();
      accountId = null;
      input.value = '';
      contactList.replaceChildren();
      thread.replaceChildren();
    }

    function saveDraft() {
      if (!activeId || !session || session.account !== accountId) return;
      if (input.value) drafts.set(activeId, input.value);
      else drafts.delete(activeId);
    }

    function trimCaches() {
      const keep = [...contacts.values()].sort((a, b) => {
        if (a.id === activeId) return -1;
        if (b.id === activeId) return 1;
        return compareLatest(b.latest || {}, a.latest || {});
      }).slice(0, cacheLimits.contacts);
      const kept = new Set(keep.map(person => person.id));
      for (const id of contacts.keys()) if (!kept.has(id)) contacts.delete(id);
      let total = [...conversations.values()].reduce((sum, rows) => sum + rows.length, 0);
      for (const [id, rows] of conversations) {
        if (conversations.size <= cacheLimits.conversations && total <= cacheLimits.totalMessages) break;
        if (id === activeId) continue;
        conversations.delete(id);
        confirmedThreads.delete(id);
        total -= rows.length;
      }
    }

    function checkedRows(result) {
      if (!result || result.success !== true) throw new Error(result?.message || '论坛未确认本次请求成功');
      if (!Array.isArray(result.msgArray)) throw new Error('消息接口格式不符，请使用原版私信');
      return result.msgArray.map(row => {
        const participant = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
        if (!row || !participant(row.sender_id) || !participant(row.receiver_id) || typeof row.content !== 'string') {
          throw new Error('消息格式不符，请使用原版私信');
        }
        return { ...row, sender_id: Number(row.sender_id), receiver_id: Number(row.receiver_id) };
      }).filter(row => row.sender_id === accountId || row.receiver_id === accountId);
    }

    function renderContacts() {
      const query = search.value.trim().toLocaleLowerCase();
      shortcuts.hidden = !!query;
      const visible = [...contacts.values()].filter(person =>
        `${person.name} ${person.id} ${person.latest?.content || ''}`.toLocaleLowerCase().includes(query)
      ).sort((a, b) => time(b.latest || {}) - time(a.latest || {}));
      contactList.replaceChildren();
      for (const person of visible) {
        const row = action('', () => selectPeer(person.id, person.name), 'nsp-chat-contact');
        row.setAttribute('aria-pressed', String(person.id === activeId));
        row.setAttribute('aria-label', `${person.name}${person.unread ? '，有未读消息' : ''}`);
        const system = person.name === '系统通知';
        const monogram = system ? ui('span', 'nsp-chat-category-icon nsp-chat-category-system') : avatar(person.id, person.name);
        if (system) monogram.append(icon('bell'));
        const details = ui('span', 'nsp-chat-contact-details');
        const line = ui('span', 'nsp-chat-contact-line');
        const stamp = ui('time', '', ago(person.latest?.created_at));
        stamp.title = when(person.latest?.created_at);
        line.append(ui('strong', '', system ? '系统消息' : person.name), stamp);
        details.append(line, ui('span', 'nsp-chat-preview', person.latest ? `${person.latest.sender_id === accountId ? '我：' : ''}${person.latest.content}` : '开始对话'));
        row.append(monogram, details);
        if (person.unread) row.append(ui('span', 'nsp-chat-unread', '●'));
        contactList.append(row);
      }
      if (!visible.length && !listBusy) contactList.append(ui('p', 'nsp-chat-empty', query ? '没有匹配的联系人' : '暂无私信。可从用户资料卡发起聊天。'));
      loadMore.hidden = !moreAvailable || !!query;
      loadMore.disabled = listBusy || contacts.size >= cacheLimits.contacts;
      loadMore.textContent = contacts.size >= cacheLimits.contacts ? '已达 200 个联系人，请用原版查看更多' : '加载更多联系人';
      refreshList.disabled = listBusy;
    }

    function renderHeader() {
      const person = contacts.get(activeId);
      heading.hidden = !activeId;
      peerName.textContent = activeId ? (person?.name === '系统通知' ? '系统消息' : person?.name) || `用户 ${activeId}` : '选择一个联系人';
      profile.hidden = !activeId || person?.name === '系统通知';
      if (activeId) profile.href = `/space/${activeId}`;
      native.href = activeId ? `/notification#/message?mode=talk&to=${activeId}&native=1` : '/notification#/message?native=1';
      refreshThread.disabled = !activeId || threadBusy;
      if (!activeId) {
        thread.replaceChildren(ui('div', 'nsp-chat-welcome', '选择左侧会话，开始聊天'));
        threadStatus.textContent = '';
      }
      updateComposer();
    }

    async function markAllViewed() {
      const opened = session;
      if (!isCurrent(opened) || markAllBusy) return;
      if (!window.confirm('将全部私信标为已读（包括尚未加载的会话）？@我和回复主题的已读状态不会改变。')) return;
      markAllBusy = true;
      markAll.disabled = true;
      markAll.textContent = '正在标记…';
      try {
        const result = await NSP.api(`${apiRoot}/markViewed?all=true`, { method: 'POST', signal: opened.controller.signal });
        if (!isCurrent(opened)) return;
        if (result?.success !== true) throw new Error(result?.message || '论坛未确认已读状态');
        // Discard snapshots started before this write. They must not restore
        // stale unread flags or downgrade a freshly loaded conversation preview.
        listController?.abort();
        listSequence++;
        listBusy = false;
        threadController?.abort();
        threadSequence++;
        threadBusy = false;
        refreshThread.disabled = !activeId;
        for (const person of contacts.values()) person.unread = false;
        for (const messages of conversations.values()) for (const row of messages) {
          if (row.receiver_id === accountId) row.viewed = true;
        }
        renderContacts();
        NSP.toast('全部私信已标为已读');
        loadContacts();
        if (activeId) loadThread();
      } catch (error) {
        if (isCurrent(opened)) contactStatus.textContent = `标记未完成：${errorText(error)}。可刷新核对。`;
      } finally {
        if (session === opened) {
          markAllBusy = false;
          markAll.disabled = false;
          markAll.textContent = '全部已读';
        }
      }
    }

    function updateComposer() {
      const id = activeId;
      const busy = !!id && sending.has(id);
      const failure = failures.get(id);
      const system = contacts.get(id)?.name === '系统通知';
      const identityConfirmed = confirmedThreads.has(id) && contacts.get(id)?.nameConfirmed === true;
      composer.hidden = !id || system;
      input.disabled = !id || busy || system;
      send.disabled = !id || !identityConfirmed || busy || system || !!failure || !input.value.trim();
      send.textContent = busy ? '发送中…' : '发送';
      warning.hidden = !id || !failure;
      if (failure) {
        warningText.textContent = '发送结果未确认，草稿已保留。先点击“刷新记录”核对：已发送则清空草稿，未发送再解除防重。';
        unlock.disabled = !failure.verified || busy;
        acknowledge.disabled = !failure.verified || busy;
      }
    }

    // A deliberately small formatter: text, links, inline code, bold, and opt-in images.
    // No response HTML is inserted or executed.
    function appendBody(container, content, markdown) {
      const expression = markdown
        ? /!\[([^\]\n]{0,200})\]\((?:<([^>\n]+)>|([^\s)]+))\)|\[([^\]\n]{1,200})\]\((?:<([^>\n]+)>|([^\s)]+))\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|https?:\/\/[^\s<>]+/g
        : /https?:\/\/[^\s<>]+/g;
      let offset = 0;
      for (const match of content.matchAll(expression)) {
        container.append(document.createTextNode(content.slice(offset, match.index)));
        offset = match.index + match[0].length;
        if (markdown && match[7] !== undefined) {
          container.append(ui('code', '', match[7]));
          continue;
        }
        if (markdown && match[8] !== undefined) {
          container.append(ui('strong', '', match[8]));
          continue;
        }
        const isImage = markdown && match[1] !== undefined;
        const href = isImage ? match[2] || match[3] : markdown && match[4] !== undefined ? match[5] || match[6] : match[0];
        const url = NSP.safeURL(href);
        if (!url) {
          container.append(document.createTextNode(match[0]));
          continue;
        }
        if (isImage) {
          const holder = ui('span', 'nsp-chat-image');
          const reveal = action(`加载图片 · ${url.hostname}`, () => {
            if (!isCurrent() || !holder.isConnected) return;
            const image = ui('img');
            image.alt = match[1] || '聊天图片';
            image.referrerPolicy = 'no-referrer';
            image.decoding = 'async';
            image.addEventListener('error', () => {
              holder.replaceChildren(ui('span', '', '图片加载失败 '), imageLink(url, '打开图片 ↗'));
            }, { once: true });
            image.src = url.href;
            holder.replaceChildren(image);
          }, 'nsp-chat-load-image');
          reveal.title = '点击后会向图片所在服务器请求图片';
          holder.append(reveal);
          container.append(holder);
        } else container.append(imageLink(url, markdown && match[4] !== undefined ? match[4] : match[0]));
      }
      container.append(document.createTextNode(content.slice(offset)));
    }

    function imageLink(url, label) {
      const link = ui('a', '', label);
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.referrerPolicy = 'no-referrer';
      return link;
    }

    function renderMessages(id, scrollToEnd = false) {
      if (!isCurrent() || activeId !== id) return;
      const messages = conversations.get(id) || [];
      const signature = JSON.stringify([id, messages.map(row => [messageKey(row), row.content])]);
      if (signature === lastRenderKey) return;
      lastRenderKey = signature;
      const atEnd = thread.scrollHeight - thread.clientHeight - thread.scrollTop < 90;
      const oldTop = thread.scrollTop;
      thread.replaceChildren();
      for (const message of messages) {
        const mine = message.sender_id === accountId;
        const row = ui('article', `nsp-chat-message${mine ? ' nsp-chat-mine' : ''}`);
        const stamp = ui('time', 'nsp-chat-time', when(message.created_at));
        stamp.setAttribute('aria-label', `${mine ? '我' : contacts.get(id)?.name || '对方'}，${when(message.created_at)}`);
        const bubble = ui('div', 'nsp-chat-bubble');
        appendBody(bubble, message.content, message.markdown !== false && message.markdown !== 0);
        const content = ui('div', 'nsp-chat-message-content');
        content.append(bubble, stamp);
        row.append(avatar(mine ? accountId : id, mine ? '我' : contacts.get(id)?.name || '对方'), content);
        thread.append(row);
      }
      if (!messages.length) thread.append(ui('div', 'nsp-chat-empty', '还没有聊天记录，发送第一条消息吧'));
      if (scrollToEnd || atEnd) thread.scrollTop = thread.scrollHeight;
      else thread.scrollTop = oldTop;
    }

    async function loadContacts(more = false) {
      const opened = session;
      if (!isCurrent(opened) || listBusy || more && !moreAvailable) return;
      const requestNumber = ++listSequence;
      listController?.abort();
      listController = new AbortController();
      const signal = AbortSignal.any([opened.controller.signal, listController.signal]);
      const requestedPage = more ? page + 1 : 1;
      listBusy = true;
      contactStatus.textContent = more ? '正在加载更多…' : '正在读取联系人…';
      renderContacts();
      try {
        const result = await NSP.api(`${apiRoot}/list?page=${requestedPage}`, { signal });
        if (!isCurrent(opened) || signal.aborted || requestNumber !== listSequence) return;
        const rows = checkedRows(result);
        for (const row of rows) {
          const id = row.sender_id === accountId ? row.receiver_id : row.sender_id;
          if (!validId(id) || id === accountId) continue;
          const old = contacts.get(id);
          const reportedName = row.sender_id === accountId ? row.receiver_name : row.sender_name;
          const hasName = typeof reportedName === 'string' && !!reportedName.trim();
          const useIncoming = !old?.latest || compareLatest(row, old.latest) >= 0;
          contacts.set(id, {
            ...old, id,
            name: hasName ? reportedName.trim() : old?.name || `用户 ${id}`,
            nameConfirmed: hasName || old?.nameConfirmed === true,
            latest: useIncoming ? contactSummary(row) : old.latest,
            unread: useIncoming ? row.receiver_id === accountId && unread(row) : old.unread
          });
        }
        trimCaches();
        const key = rows.slice(0, cacheLimits.contacts).map(row => latestId(row) || messageKey(contactSummary(row))).join('|');
        moreAvailable = rows.length > 0 && !(more && key === lastPageKey);
        lastPageKey = key;
        page = requestedPage;
        contactStatus.textContent = '';
        renderHeader();
      } catch (error) {
        if (isCurrent(opened) && !signal.aborted) contactStatus.textContent = errorText(error);
      } finally {
        if (session === opened && requestNumber === listSequence) {
          listBusy = false;
          renderContacts();
        }
      }
    }

    async function loadThread({ manual = false, first = false } = {}) {
      const opened = session;
      const id = activeId;
      if (!isCurrent(opened) || !id || threadBusy || document.hidden && !manual) return;
      threadController?.abort();
      threadController = new AbortController();
      const requestNumber = ++threadSequence;
      const signal = AbortSignal.any([opened.controller.signal, threadController.signal]);
      const current = () => isCurrent(opened) && activeId === id && requestNumber === threadSequence && !signal.aborted;
      const failureAtStart = failures.get(id);
      threadBusy = true;
      refreshThread.disabled = true;
      if (first || manual) threadStatus.textContent = '正在读取聊天记录…';
      try {
        const result = await NSP.api(`${apiRoot}/with/${id}`, { signal });
        if (!current()) return;
        const rows = checkedRows(result).filter(row =>
          row.sender_id === id && row.receiver_id === accountId || row.sender_id === accountId && row.receiver_id === id
        );
        const all = new Map((conversations.get(id) || []).map(row => [messageKey(row), row]));
        rows.forEach(row => all.set(messageKey(row), row));
        const messages = [...all.values()].sort((a, b) => time(a) - time(b) || Number(a.id || 0) - Number(b.id || 0)).slice(-cacheLimits.perConversation);
        conversations.delete(id);
        conversations.set(id, messages);
        const old = contacts.get(id) || { id, name: `用户 ${id}` };
        const reportedName = result.talkTo?.member_name;
        const hasName = typeof reportedName === 'string' && !!reportedName.trim();
        const candidate = messages.at(-1);
        const useIncoming = !!candidate && (!old.latest || compareLatest(candidate, old.latest) >= 0);
        contacts.set(id, {
          ...old, name: hasName ? reportedName.trim() : old.name,
          nameConfirmed: hasName || old.nameConfirmed === true,
          latest: useIncoming ? contactSummary(candidate) : old.latest,
          unread: useIncoming ? candidate.receiver_id === accountId && unread(candidate) : old.unread
        });
        confirmedThreads.add(id);
        trimCaches();
        if (manual && failureAtStart && failures.get(id) === failureAtStart) failureAtStart.verified = true;
        threadStatus.textContent = contacts.get(id).nameConfirmed
          ? `已同步最新记录 · 本地每会话最多 ${cacheLimits.perConversation} 条，历史完整记录请看原版` : '未能确认会话资料，请刷新记录或打开原版页面';
        renderHeader();
        renderContacts();
        renderMessages(id, first);
        const unreadIds = messages.filter(row => row.receiver_id === accountId && unread(row) && messageId(row)).map(row => Number(row.id));
        if (unreadIds.length && !document.hidden && current()) {
          try {
            const marked = await NSP.api(`${apiRoot}/markViewed`, { method: 'POST', body: { messages: unreadIds }, signal });
            if (!current()) return;
            if (marked?.success !== true) throw new Error(marked?.message || '未确认已读状态');
            const seen = new Set(unreadIds);
            messages.forEach(row => { if (seen.has(Number(row.id))) row.viewed = true; });
            const person = contacts.get(id);
            if (person && seen.has(latestId(person.latest))) {
              person.unread = false;
              person.latest.viewed = true;
            }
            renderContacts();
          } catch (error) {
            if (current()) threadStatus.textContent = `消息已加载；已读状态未同步：${errorText(error)}`;
          }
        }
      } catch (error) {
        if (current()) {
          threadStatus.textContent = `读取失败：${errorText(error)}`;
          if (!conversations.get(id)?.length) thread.replaceChildren(ui('div', 'nsp-chat-empty', '暂时无法读取消息，请点击“刷新记录”或打开原版私信。'));
        }
      } finally {
        if (session === opened && requestNumber === threadSequence) {
          threadBusy = false;
          refreshThread.disabled = !activeId;
          updateComposer();
        }
      }
    }

    function selectPeer(id, name) {
      if (!isCurrent() || !validId(id) || id === accountId) return;
      saveDraft();
      threadController?.abort();
      threadSequence++;
      threadBusy = false;
      activeId = Number(id);
      if (!contacts.has(activeId)) contacts.set(activeId, { id: activeId, name: String(name || `用户 ${activeId}`) });
      trimCaches();
      dialog.classList.add('nsp-chat-has-peer');
      input.value = drafts.get(activeId) || '';
      lastRenderKey = '';
      threadStatus.textContent = '';
      renderHeader();
      renderContacts();
      renderMessages(activeId, true);
      loadThread({ first: true });
      input.focus({ preventScroll: true });
    }

    async function sendMessage() {
      const opened = session;
      const id = activeId;
      const content = input.value.trim();
      if (!isCurrent(opened) || !id || !content || !confirmedThreads.has(id) || contacts.get(id)?.nameConfirmed !== true
        || sending.has(id) || failures.has(id) || contacts.get(id)?.name === '系统通知') return;
      saveDraft();
      const operation = { account: accountId, text: input.value, sequence: opened.sequence };
      sending.set(id, operation);
      updateComposer();
      threadStatus.textContent = '正在发送，请勿重复操作…';
      try {
        const result = await NSP.api(`${apiRoot}/send`, {
          method: 'POST', body: { receiverUid: id, content, markdown: true }, signal: opened.controller.signal
        });
        if (sending.get(id) !== operation || accountId !== operation.account || validId(NSP.getUser()?.id) !== operation.account) return;
        if (result?.success === false) {
          failures.delete(id);
          if (isCurrent() && activeId === id) threadStatus.textContent = `发送被拒绝：${result.message || '请检查消息后重试'}。草稿已保留。`;
          return;
        }
        if (result?.success !== true) throw new Error('服务器未明确确认发送结果');
        failures.delete(id);
        if (drafts.get(id) === operation.text) drafts.delete(id);
        if (isCurrent() && activeId === id) {
          if (input.value === operation.text) input.value = '';
          threadStatus.textContent = '已发送';
          threadController?.abort();
          threadSequence++;
          threadBusy = false;
          loadThread();
        }
      } catch (error) {
        if (sending.get(id) !== operation || accountId !== operation.account || validId(NSP.getUser()?.id) !== operation.account) return;
        if (error?.confirmedFailure === true) {
          failures.delete(id);
          if (isCurrent() && activeId === id) threadStatus.textContent = `发送被拒绝：${errorText(error)}。草稿已保留。`;
        } else {
          failures.set(id, { verified: false });
          if (isCurrent() && activeId === id) threadStatus.textContent = `发送结果未确认：${errorText(error)}`;
        }
      } finally {
        if (sending.get(id) === operation) sending.delete(id);
        if (isCurrent() && activeId === id) updateComposer();
      }
    }

    function stop() {
      saveDraft();
      for (const [id, operation] of sending) if (operation.account === accountId) failures.set(id, { verified: false });
      clearInterval(timer);
      timer = null;
      session?.controller.abort();
      threadController?.abort();
      listController?.abort();
      session = null;
      activeId = null;
      listSequence++;
      threadSequence++;
      listBusy = false;
      markAllBusy = false;
      markAll.disabled = false;
      markAll.textContent = '全部已读';
      threadBusy = false;
      contacts.clear();
      conversations.clear();
      confirmedThreads.clear();
      lastRenderKey = '';
      lastPageKey = '';
      page = 0;
      input.value = '';
      search.value = '';
      contactList.replaceChildren();
      thread.replaceChildren();
      dialog.classList.remove('nsp-chat-has-peer');
      previousFocus?.isConnected && previousFocus.focus?.({ preventScroll: true });
    }

    function messageRoute(url = new URL(location.href)) {
      if (url.origin !== location.origin || url.pathname !== '/notification' || !/^#\/message(?:\?|$)/.test(url.hash)) return null;
      const params = new URLSearchParams(url.hash.split('?')[1] || '');
      if (params.getAll('native').includes('1')) return null;
      const values = params.getAll('to');
      if (values.length > 1 || values.length && !/^[1-9]\d*$/.test(values[0])) return null;
      const peer = values.length ? validId(values[0]) : null;
      if (values.length && !peer) return null;
      return { key: `${url.pathname}${url.search}${url.hash}`, peer };
    }

    function rememberDismissal() {
      observedLocation = `${location.pathname}${location.search}${location.hash}`;
      dismissedRoute = messageRoute()?.key || null;
    }

    function closePanel({ dismiss = true } = {}) {
      if (dismiss) rememberDismissal();
      if (session) stop();
      if (dialog.open) dialog.close();
    }

    function openChat(id, name, source = 'manual') {
      if (!NSP.settings.chat) return;
      const me = NSP.getUser();
      const uid = validId(me?.id);
      if (!uid) {
        if (source === 'manual') NSP.toast('请先登录论坛再使用私信');
        return;
      }
      if (accountId !== uid) {
        if (dialog.open) closePanel({ dismiss: false });
        forgetAccount();
        accountId = uid;
      }
      const peer = validId(id);
      if (peer === uid) {
        if (source === 'manual') NSP.toast('不能向自己发送私信');
        return;
      }
      if (source === 'manual') dismissedRoute = null;
      if (!dialog.open) {
        previousFocus = document.activeElement;
        session = { account: uid, sequence: ++sequence, controller: new AbortController(), source, routeKey: null };
        page = 0;
        moreAvailable = true;
        lastPageKey = '';
        contactStatus.textContent = '';
        threadStatus.textContent = '';
        lastRenderKey = '';
        dialog.showModal();
        renderHeader();
        loadContacts();
        timer = setInterval(() => {
          if (!isCurrent() || document.hidden) return;
          if (activeId) loadThread();
          else loadContacts();
        }, 20000);
      } else if (source === 'manual' && session) session.source = 'manual';
      if (source === 'route' && session) session.routeKey = messageRoute()?.key || null;
      if (peer) selectPeer(peer, name);
      else search.focus();
    }

    function syncRoute() {
      routeScheduled = false;
      if (routeSuspended || !NSP.settings.chat) return;
      const locationKey = `${location.pathname}${location.search}${location.hash}`;
      if (observedLocation !== locationKey) {
        observedLocation = locationKey;
        dismissedRoute = null;
      }
      const route = messageRoute();
      if (!route) {
        if (session?.source === 'route') closePanel({ dismiss: false });
        return;
      }
      const uid = validId(NSP.getUser()?.id);
      if (session && session.account !== uid) {
        closePanel({ dismiss: false });
        forgetAccount();
      }
      // The forum may mount account details after the userscript. Stay silent
      // until they arrive; an explicitly dismissed route stays dismissed.
      if (!uid || route.key === dismissedRoute || route.peer === uid) return;
      if (dialog.open && session) {
        if (session.source !== 'route' || session.routeKey === route.key) return;
        session.routeKey = route.key;
        if (route.peer) selectPeer(route.peer);
        else {
          saveDraft();
          threadController?.abort();
          threadSequence++;
          threadBusy = false;
          activeId = null;
          input.value = '';
          dialog.classList.remove('nsp-chat-has-peer');
          renderHeader();
          renderContacts();
          search.focus();
        }
        return;
      }
      openChat(route.peer, undefined, 'route');
    }

    function scheduleRoute() {
      if (routeScheduled || routeSuspended) return;
      routeScheduled = true;
      queueMicrotask(syncRoute);
    }

    input.addEventListener('input', () => { saveDraft(); updateComposer(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !event.repeat) {
        event.preventDefault();
        sendMessage();
      }
    });
    search.addEventListener('input', renderContacts);
    // The native close event is queued. An old event must not stop a newly opened session.
    dialog.addEventListener('close', () => {
      if (!dialog.open && session) {
        rememberDismissal();
        stop();
      }
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); closePanel(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && isCurrent()) {
        if (activeId) loadThread();
        else loadContacts();
      }
    });
    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor || anchor.dataset.nspNative || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = NSP.safeURL(anchor.href, location.href, { sameOrigin: true });
      const route = url && messageRoute(url);
      if (!route || !NSP.settings.chat || !NSP.getUser()) return;
      event.preventDefault();
      openChat(route.peer);
    });
    window.addEventListener('hashchange', scheduleRoute);
    window.addEventListener('popstate', scheduleRoute);
    // History API navigation does not emit hashchange/popstate. Preserve its
    // native return value and exceptions, then inspect only the resulting URL.
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      history[name] = function (...args) {
        const result = Reflect.apply(original, this, args);
        scheduleRoute();
        return result;
      };
    }
    const routeObserver = new MutationObserver(records => {
      if (records.some(record => !dialog.contains(record.target))) scheduleRoute();
    });
    routeObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['href', 'data-user-id', 'data-member-id']
    });
    window.addEventListener('pagehide', () => {
      routeSuspended = true;
      if (dialog.open) closePanel({ dismiss: false });
      forgetAccount();
    });
    window.addEventListener('pageshow', () => { routeSuspended = false; scheduleRoute(); });
    NSP.openChat = (id, name) => openChat(id, name);
    NSP.hasDraft = () => !!input.value.trim() || [...drafts.values()].some(text => !!text.trim()) || sending.size > 0;
    NSP.registerCacheCleaner(() => {
      closePanel();
      contacts.clear();
      conversations.clear();
      confirmedThreads.clear();
      lastRenderKey = '';
      lastPageKey = '';
      thread.replaceChildren();
      contactList.replaceChildren();
    }, () => sending.size === 0 && !markAllBusy);
    NSP.addTool('私信', () => openChat());

    NSP.css(`
      .nsp-chat{position:fixed;inset:0;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:var(--nsp-bg,#f4f5f7);color:var(--nsp-text,#20262e);font:14px/1.5 system-ui,-apple-system,sans-serif;box-sizing:border-box;overflow:hidden}
      .nsp-chat[open]{display:flex;flex-direction:column}.nsp-chat::backdrop{background:#0008}.nsp-chat *{box-sizing:border-box}.nsp-chat [hidden]{display:none!important}
      .nsp-chat button,.nsp-chat input,.nsp-chat textarea{font:inherit;color:inherit}.nsp-chat button{cursor:pointer;border:1px solid var(--nsp-line,#dfe3e8);border-radius:8px;background:var(--nsp-bg,#fff);padding:6px 10px}.nsp-chat button:disabled{cursor:default;opacity:.5}.nsp-chat button:hover:not(:disabled){background:color-mix(in srgb,var(--nsp-accent,#07875b) 9%,var(--nsp-bg,#fff))}.nsp-chat :focus-visible{outline:2px solid var(--nsp-accent,#07875b);outline-offset:2px}.nsp-chat a{color:var(--nsp-accent,#07875b);text-decoration:none}.nsp-chat a:hover{text-decoration:underline}
      .nsp-chat-top{height:62px;flex:none;display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--nsp-line,#dfe3e8);padding:0 24px;background:var(--nsp-bg,#fff)}.nsp-chat-top h2{margin:0;font-size:19px;font-weight:650}.nsp-chat-note{color:var(--nsp-muted,#77818c);font-size:12px;flex:1}.nsp-chat-native{font-size:12px;white-space:nowrap}.nsp-chat-close{white-space:nowrap}.nsp-chat-layout{display:grid;grid-template-columns:300px minmax(0,1fr);flex:1;min-height:0}.nsp-chat-sidebar{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--nsp-line,#dfe3e8);background:color-mix(in srgb,var(--nsp-bg,#fff) 94%,var(--nsp-text,#20262e))}
      .nsp-chat-searchbar{display:flex;gap:8px;padding:16px 14px 8px}.nsp-chat-search{min-width:0;flex:1;border:1px solid var(--nsp-line,#dfe3e8);border-radius:8px;padding:8px 10px;background:var(--nsp-bg,#fff)}.nsp-chat-searchbar button{flex:none}.nsp-chat-contacts{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}.nsp-chat button.nsp-chat-contact{display:flex;position:relative;align-items:center;gap:12px;border:0;border-radius:0;width:100%;padding:14px;background:transparent;text-align:left}.nsp-chat-contact[aria-pressed=true]{background:color-mix(in srgb,var(--nsp-accent,#07875b) 12%,var(--nsp-bg,#fff))!important}.nsp-chat-monogram{display:grid;place-items:center;flex:none;width:42px;height:42px;border-radius:12px;background:color-mix(in srgb,var(--nsp-accent,#07875b) 14%,var(--nsp-bg,#fff));color:var(--nsp-accent,#07875b);font-size:20px}.nsp-chat-contact-details{display:flex;flex-direction:column;min-width:0;flex:1;gap:4px}.nsp-chat-contact-line{display:flex;gap:6px;align-items:center}.nsp-chat-contact-line strong{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.nsp-chat-contact-line time{font-size:10px;flex:none;color:var(--nsp-muted,#77818c)}.nsp-chat-preview{font-size:12px;color:var(--nsp-muted,#77818c);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.nsp-chat-unread{position:absolute;top:10px;left:48px;font-size:12px;color:#e85d63}.nsp-chat-more{flex:none;margin:10px 14px}
      .nsp-chat-main{display:flex;flex-direction:column;min-width:0;min-height:0}.nsp-chat-heading{display:flex;align-items:center;gap:12px;min-height:65px;padding:12px 24px;border-bottom:1px solid var(--nsp-line,#dfe3e8)}.nsp-chat-peer-name{flex:1;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nsp-chat-profile{font-size:12px;white-space:nowrap}.nsp-chat-back{display:none}.nsp-chat-thread{flex:1;min-height:0;padding:24px max(24px,calc((100% - 1000px)/2));overflow:auto;overscroll-behavior:contain}.nsp-chat-empty,.nsp-chat-welcome{text-align:center;color:var(--nsp-muted,#77818c);padding:30px 20px}.nsp-chat-welcome{display:grid;place-items:center;height:100%;font-size:16px}.nsp-chat-message{display:flex;flex-direction:column;align-items:flex-start;margin:0 0 20px}.nsp-chat-time{font-size:11px;color:var(--nsp-muted,#77818c);margin:0 0 5px 3px}.nsp-chat-bubble{max-width:min(78%,720px);padding:11px 15px;border:1px solid var(--nsp-line,#dfe3e8);border-radius:3px 14px 14px;background:var(--nsp-bg,#fff);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.nsp-chat-mine{align-items:flex-end}.nsp-chat-mine .nsp-chat-bubble{border-radius:14px 3px 14px 14px;background:color-mix(in srgb,var(--nsp-accent,#07875b) 15%,var(--nsp-bg,#fff));border-color:color-mix(in srgb,var(--nsp-accent,#07875b) 22%,var(--nsp-line,#dfe3e8))}.nsp-chat-bubble code{background:#80808015;border-radius:4px;padding:1px 5px;font:13px ui-monospace,monospace}.nsp-chat-image{display:block;margin:6px 0}.nsp-chat-image img{display:block;max-width:100%;max-height:460px;border-radius:6px;object-fit:contain}.nsp-chat-load-image{font-size:12px!important;text-align:left;overflow-wrap:anywhere}
      .nsp-chat-status{font-size:12px;color:var(--nsp-muted,#77818c);padding:0 14px;margin:4px 0 8px;min-height:0;overflow-wrap:anywhere}.nsp-chat-status:empty{display:none}.nsp-chat-thread-status{padding:0 24px}.nsp-chat-warning{margin:0 24px 10px;padding:12px;border:1px solid #bd873f;border-radius:8px;background:#bd873f12;font-size:12px}.nsp-chat-warning p{margin:0 0 8px}.nsp-chat-warning button{font-size:12px;margin:0 8px 5px 0}.nsp-chat-composer{margin:0 24px 20px;border:1px solid var(--nsp-line,#dfe3e8);border-radius:12px;padding:12px;background:var(--nsp-bg,#fff)}.nsp-chat-composer:focus-within{border-color:var(--nsp-accent,#07875b)}.nsp-chat-input{display:block;width:100%;min-height:76px;max-height:220px;resize:vertical;border:0;outline:none!important;background:transparent;line-height:1.6;padding:0 2px}.nsp-chat-compose-footer{display:flex;align-items:center;gap:12px;margin-top:8px}.nsp-chat-compose-footer small{color:var(--nsp-muted,#77818c);font-size:11px;flex:1}.nsp-chat button.nsp-chat-send{background:var(--nsp-accent,#07875b);color:#fff;border:0;min-width:80px;padding:8px 18px}.nsp-dark .nsp-chat-mine .nsp-chat-bubble{background:color-mix(in srgb,var(--nsp-accent,#07875b) 24%,var(--nsp-bg,#171c23))}
      @media(min-width:1500px){.nsp-chat-layout{grid-template-columns:340px minmax(0,1fr)}}
      @media(max-width:700px){.nsp-chat-top{height:54px;padding:0 12px;gap:12px}.nsp-chat-note{display:none}.nsp-chat-top h2{flex:1}.nsp-chat-layout{display:block;position:relative}.nsp-chat-sidebar,.nsp-chat-main{height:100%;width:100%}.nsp-chat-main{display:none}.nsp-chat-has-peer .nsp-chat-sidebar{display:none}.nsp-chat-has-peer .nsp-chat-main{display:flex}.nsp-chat-back{display:inline-block;padding:6px!important;font-size:12px!important}.nsp-chat-heading{padding:8px 12px;min-height:58px;gap:8px}.nsp-chat-peer-name{font-size:14px}.nsp-chat-heading>button:last-child{font-size:12px;padding:6px}.nsp-chat-thread{padding:16px 12px}.nsp-chat-bubble{max-width:88%;padding:9px 12px}.nsp-chat-composer{margin:0 10px max(10px,env(safe-area-inset-bottom));padding:10px}.nsp-chat-input{min-height:64px;max-height:150px;font-size:16px}.nsp-chat-warning{margin:0 10px 8px}.nsp-chat-thread-status{padding:0 12px}.nsp-chat-searchbar{padding-top:12px}.nsp-chat-profile{font-size:11px}}
    `);
    NSP.css(`
      /* A quiet two-column inbox, matching the user's reference layout. */
      html:has(.nsp-chat[open]){overflow:hidden}
      .nsp-chat{--chat-side:#ededed;--chat-main:#f5f5f5;--chat-search:#e2e3e5;width:calc(100vw - 64px);height:calc(100dvh - 36px);max-width:1440px;max-height:1100px;margin:auto;border-radius:12px;background:var(--chat-main);font-size:15px;box-shadow:0 12px 60px #0002}
      .nsp-chat::backdrop{background:#0002}.nsp-chat svg{width:24px;height:24px;display:block}
      .nsp-chat-top{height:52px;padding:0 18px;gap:20px;border:0;box-shadow:0 1px 4px #0001;z-index:1}.nsp-chat-top h2{flex:1;font-size:17px}.nsp-chat-top .nsp-chat-native,.nsp-chat-top button{font-size:13px;color:var(--nsp-muted,#828282)}.nsp-chat-top button{background:transparent;border:0;padding:6px 0}.nsp-chat-close{margin-left:4px}.nsp-chat-layout{grid-template-columns:320px minmax(0,1fr)}.nsp-chat-sidebar{background:var(--chat-side)}
      .nsp-chat-searchbar{gap:10px;padding:12px 12px 14px}.nsp-chat-search{border:0;border-radius:8px;padding:11px 12px;background:var(--chat-search)}.nsp-chat-search::placeholder{color:#818181}.nsp-chat-searchbar .nsp-chat-refresh{border:0;background:transparent;padding:8px}.nsp-chat-contact-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.nsp-chat-contacts{flex:none;overflow:visible}.nsp-chat button.nsp-chat-contact,.nsp-chat a.nsp-chat-shortcut{display:flex;position:relative;align-items:center;gap:12px;border:0;border-radius:0;width:100%;padding:16px 14px;background:transparent;text-align:left;color:inherit;text-decoration:none}.nsp-chat a.nsp-chat-shortcut:hover,.nsp-chat button.nsp-chat-contact:hover{background:#00000006}.nsp-chat-contact[aria-pressed=true]{background:color-mix(in srgb,var(--nsp-accent,#07875b) 12%,var(--chat-side))!important}
      .nsp-chat-monogram,.nsp-chat-category-icon{display:grid;place-items:center;position:relative;overflow:hidden;flex:none;width:44px;height:44px;border-radius:8px;font-size:21px}.nsp-chat-avatar{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover}.nsp-chat-category-icon{color:#fff}.nsp-chat-category-mention{background:#5588e3;font-size:32px;font-weight:600}.nsp-chat-category-reply{background:#259d70}.nsp-chat-category-system{background:#df9e2c}.nsp-chat-category-icon svg{width:28px;height:28px}.nsp-chat-contact-details{gap:5px}.nsp-chat-contact-line{gap:7px}.nsp-chat-contact-line strong,.nsp-chat-shortcut strong{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.nsp-chat-contact-line time{font-size:11px}.nsp-chat-preview{font-size:14px}.nsp-chat-unread{top:8px;left:51px}.nsp-chat-more{margin:8px 14px;font-size:12px!important}
      .nsp-chat-main{background:var(--chat-main)}.nsp-chat-heading{min-height:60px}.nsp-chat-thread{padding:24px}.nsp-chat-message{flex-direction:row;align-items:flex-start;gap:10px;margin-bottom:22px}.nsp-chat-message .nsp-chat-monogram{width:36px;height:36px;border-radius:7px;font-size:17px}.nsp-chat-message-content{display:flex;align-items:flex-start;flex-direction:column;max-width:min(78%,720px);min-width:0}.nsp-chat-time{margin:6px 2px 0}.nsp-chat-bubble{max-width:100%;padding:10px 14px;border-radius:3px 10px 10px}.nsp-chat-mine{flex-direction:row-reverse}.nsp-chat-mine .nsp-chat-message-content{align-items:flex-end}.nsp-chat-mine .nsp-chat-bubble{border-radius:10px 3px 10px 10px;background:#b4f2cb;border-color:#b4f2cb;color:#24382c}.nsp-chat-composer{margin:0;border:0;border-top:1px solid var(--nsp-line,#e5e5e5);border-radius:0;padding:16px 24px 18px}.nsp-chat-input{min-height:82px}.nsp-chat button.nsp-chat-send{background:#269e52}
      .nsp-dark .nsp-chat{--chat-side:#252a30;--chat-main:#1c2127;--chat-search:#333a43}.nsp-dark .nsp-chat-search::placeholder{color:#9ba5b0}.nsp-dark .nsp-chat-mine .nsp-chat-bubble{background:#245f40;border-color:#30684b;color:#e1f6e8}.nsp-dark .nsp-chat a.nsp-chat-shortcut:hover,.nsp-dark .nsp-chat button.nsp-chat-contact:hover{background:#ffffff08}
      @media(min-width:1700px){.nsp-chat{max-width:1600px}.nsp-chat-layout{grid-template-columns:360px minmax(0,1fr)}}
      @media(max-width:700px){.nsp-chat{width:100vw;height:100dvh;max-height:none;border-radius:0}.nsp-chat-top{height:54px;padding:0 10px;gap:10px}.nsp-chat-top h2{font-size:16px}.nsp-chat-top button,.nsp-chat-top .nsp-chat-native{font-size:12px}.nsp-chat-thread{padding:16px 12px}.nsp-chat-message-content{max-width:calc(100% - 54px)}.nsp-chat-bubble{padding:9px 12px}.nsp-chat-composer{padding:12px 12px max(12px,env(safe-area-inset-bottom))}.nsp-chat-input{min-height:64px}}
    `);
    scheduleRoute();
  }
});


// Source: 90-main.js
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

})();
