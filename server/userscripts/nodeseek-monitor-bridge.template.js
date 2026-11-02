// ==UserScript==
// @name         NodeSeek 私有通知桥接
// @namespace    nodeseek-private-monitor-bridge
// @version      1.1.0
// @description  仅在本机已登录的论坛页面读取通知，交给你的私有服务器处理。
// @match        https://www.nodeseek.com/*
// @noframes
// @grant        GM_xmlhttpRequest
// @connect      __BRIDGE_HOST__
// @run-at       document-end
// ==/UserScript==
(() => {
  'use strict';
  if (window.top !== window.self || location.origin !== 'https://www.nodeseek.com') return;
  const SERVER = '__BRIDGE_ORIGIN__';
  const FORUM = 'https://www.nodeseek.com';
  const TOKEN = '__BRIDGE_TOKEN__';
  const MAX_PAYLOAD = 512 * 1024, MAX_HTML = 2 * 1024 * 1024;
  const clientId = crypto.randomUUID();
  const errors = new Set(['verification_required', 'login_required', 'request_failed', 'schema_invalid']);
  const encoder = new TextEncoder();
  let running = false, terminal = false, generation = 0;
  let account = null, pageState = 'unknown', identityAttempt = 0, accountEpoch = 0;
  let identityPending = null, identityTimer = null, mutationTimer = null;
  let lastDOMState = 'unknown', badgeNode = null, lastIdentityError = null;
  const requests = new Set(), forumRequests = new Set(), sleeps = new Map();
  class BridgeError extends Error { constructor(code) { super(code); this.code = code; } }
  const fail = code => { throw new BridgeError(code); };
  function validId(value, allowZero = false) {
    if (!['number', 'string'].includes(typeof value) || !(allowZero ? /^\d+$/ : /^[1-9]\d*$/).test(String(value))) return null;
    const n = Number(value); return Number.isSafeInteger(n) ? n : null;
  }
  function status(text, bad = false) {
    if (!document.body) return;
    if (!badgeNode) {
      badgeNode = document.createElement('div');
      badgeNode.id = 'nsp-private-monitor-bridge';
      badgeNode.setAttribute('role', 'status');
      badgeNode.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147481000;max-width:280px;padding:6px 9px;border:1px solid #7b8d8355;border-radius:7px;background:#f4faf6;color:#335844;font:11px/1.5 system-ui,sans-serif;box-shadow:0 2px 8px #0001;pointer-events:none';
    }
    if (!badgeNode.isConnected) document.body.append(badgeNode);
    badgeNode.textContent = text;
    badgeNode.style.color = bad ? '#9d3535' : '#335844';
  }
  function inertHTML(html) {
    // Template contents stay inert: no scripts, frames or remote images are activated.
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
  }
  function plain(value, maximum = MAX_PAYLOAD) {
    if (typeof value !== 'string') return '';
    if (value.length > MAX_HTML) fail('schema_invalid');
    const root = inertHTML(value);
    root.querySelectorAll('script,style,noscript,iframe,object,embed,template').forEach(node => node.remove());
    const text = (root.textContent || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > maximum) fail('schema_invalid');
    return text;
  }
  function challenge(root) {
    const title = root.querySelector('title')?.textContent || '';
    return !!root.querySelector('#challenge-form,#cf-challenge-running') || /just a moment|安全验证|验证您是真人/i.test(title);
  }
  function identityName(value) {
    let text = plain(String(value), 2000).slice(0, 100);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return text;
  }
  function domState() {
    if (challenge(document)) return 'verification';
    const loginVisible = Array.from(document.querySelectorAll('form input[type="password"]')).some(input => {
      if (!input.getClientRects().length || input.closest('[hidden],[aria-hidden="true"]')) return false;
      const style = getComputedStyle(input);
      return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none' && style.opacity !== '0';
    });
    if (/^\/(?:login|signin)(?:\/|$)/.test(location.pathname) || loginVisible) return 'login';
    return 'forum';
  }
  function setAccount(next, nextState) {
    if (nextState !== 'unknown') lastIdentityError = null;
    if (account?.id !== next?.id || pageState !== nextState) accountEpoch++;
    account = next; pageState = nextState;
  }
  function applyDOMState() {
    const next = domState(), previous = lastDOMState; lastDOMState = next;
    if (next === 'verification') { setAccount(null, next); status('通知桥接等待：请手动完成站点验证'); }
    else if (next === 'login') { setAccount(null, next); status('通知桥接等待：请手动登录论坛'); }
    else if (running && ['verification', 'login'].includes(previous) && Date.now() - identityAttempt >= 5000) {
      void refreshIdentity(false, generation).catch(() => {});
    }
  }
  async function boundedText(response, maximum) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) fail('schema_invalid');
    if (!response.body?.getReader) {
      const text = await response.text(); if (encoder.encode(text).byteLength > maximum) fail('schema_invalid'); return text;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let total = 0, text = '';
    try { while (true) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength;
      if (total > maximum) { await reader.cancel(); fail('schema_invalid'); } text += decoder.decode(part.value, {stream:true});
    } return text + decoder.decode(); } finally { reader.releaseLock(); }
  }
  function allowedAPI(path) {
    if (typeof path !== 'string' || path.length > 180) return false;
    const match = /^\/api\/notification\/(?:message\/(?:list|with\/([1-9]\d*))|at-me\/list|reply-to-me\/list)(?:\?page=([1-9]\d*))?$/.exec(path);
    return !!match && (!match[1] || validId(match[1])) && (!match[2] || validId(match[2]) && Number(match[2]) <= 1000);
  }
  async function forumGet(path, maximum = MAX_PAYLOAD) {
    if (!(path === '/' || allowedAPI(path) || /^\/post-[1-9]\d*-[1-9]\d*$/.test(path))) fail('schema_invalid');
    const controller = new AbortController(); forumRequests.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(new URL(path, FORUM).href, {
        method:'GET', credentials:'same-origin', cache:'no-store', redirect:'error',
        headers:{Accept:'application/json, text/html;q=0.9'}, signal:controller.signal
      });
      const text = await boundedText(response, maximum);
      if (!response.ok) {
        if (response.status === 401) fail('login_required');
        if (challenge(inertHTML(text)) || response.status === 403) fail('verification_required');
        fail('request_failed');
      }
      return text;
    } catch (error) { if (errors.has(error?.code)) throw error; fail('request_failed'); }
    finally { clearTimeout(timer); forumRequests.delete(controller); }
  }
  function identityFromHTML(html) {
    const root = inertHTML(html);
    if (challenge(root)) fail('verification_required');
    const encoded = root.querySelector('#temp-script')?.textContent?.trim();
    if (encoded) {
      let config;
      try {
        if (encoded.length > MAX_HTML) fail('schema_invalid');
        config = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))));
      } catch { fail('schema_invalid'); }
      if (!config || typeof config !== 'object' || Array.isArray(config) || !Object.hasOwn(config, 'user')) fail('schema_invalid');
      if (Object.hasOwn(config, 'user')) {
        if (config.user === null || config.user === false) return null;
        const id = validId(config.user?.member_id ?? config.user?.id);
        if (!id) fail('schema_invalid');
        const name = config.user.member_name ?? config.user.name;
        if (name !== undefined && name !== null && typeof name !== 'string') fail('schema_invalid');
        return {id, name:identityName(config.user.member_name ?? config.user.name ?? id)};
      }
    }
    for (const card of root.querySelectorAll('.user-card:not(.hover-user-card)')) {
      if (!card.querySelector('a[href^="/notification"]')) continue;
      const people = new Map();
      for (const link of card.querySelectorAll('a[href]')) {
        const match = /^\/space\/([1-9]\d*)\/?$/.exec(link.getAttribute('href') || '');
        const id = match && validId(match[1]);
        if (id) people.set(id, identityName(link.textContent?.trim() || link.querySelector('img')?.alt || String(id)));
      }
      if (people.size === 1) { const [id, name] = people.entries().next().value; return {id, name}; }
    }
    if (root.querySelector('form input[type="password"]') || root.querySelector('a[href="/login"],a[href="/signin"]')) return null;
    fail('schema_invalid');
  }
  async function refreshIdentity(force, g) {
    if (identityPending) {
      if (!force) return identityPending;
      await identityPending.catch(() => {});
    }
    if (!running || g !== generation) fail('request_failed');
    identityAttempt = Date.now();
    const task = (async () => {
      try {
        const result = identityFromHTML(await forumGet('/', MAX_HTML));
        if (!running || g !== generation) fail('request_failed');
        const visible = domState();
        if (visible === 'verification') fail('verification_required');
        const next = visible === 'login' ? null : result;
        setAccount(next, next ? 'forum' : 'login');
        status(account ? '通知桥接等待任务…' : '通知桥接等待：请手动登录论坛');
        return account;
      } catch (error) {
        if (running && g === generation) {
          if (error?.code === 'schema_invalid') lastIdentityError = 'schema_invalid';
          setAccount(null, error?.code === 'verification_required' ? 'verification' : error?.code === 'login_required' ? 'login' : 'unknown');
          status(pageState === 'verification' ? '通知桥接等待：请手动完成站点验证' : pageState === 'login' ? '通知桥接等待：请手动登录论坛' : '通知桥接暂未确认登录状态');
        }
        throw error;
      }
    })();
    identityPending = task;
    try { return await task; } finally { if (identityPending === task) identityPending = null; }
  }
  function optionalFields(target, row, names) {
    for (const key of names) if (typeof row[key] === 'string') target[key] = plain(row[key], key === 'content' ? MAX_PAYLOAD : 2000);
    if ([true, false, 0, 1, '0', '1'].includes(row.viewed)) target.viewed = row.viewed;
  }
  function projectAPI(path, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('schema_invalid');
    if (data.success !== true) {
      if (typeof data.message === 'string' && /登录|login|sign.?in|unauth/i.test(data.message)) fail('login_required');
      fail('schema_invalid');
    }
    if (path.startsWith('/api/notification/message/')) {
      if (!Array.isArray(data.msgArray)) fail('schema_invalid');
      const rows = data.msgArray.map(row => {
        if (!row || typeof row !== 'object' || typeof row.content !== 'string') fail('schema_invalid');
        const sender = validId(row.sender_id, true), receiver = validId(row.receiver_id, true);
        const messageId = validId(row.id), maximumId = validId(row.max_id);
        if (sender === null || receiver === null || (!messageId && !maximumId)) fail('schema_invalid');
        const out = {sender_id:sender, receiver_id:receiver};
        if (messageId) out.id = messageId; if (maximumId) out.max_id = maximumId;
        optionalFields(out, row, ['sender_name','receiver_name','content','created_at']);
        if (typeof row.markdown === 'boolean') out.markdown = row.markdown;
        return out;
      });
      const result = {success:true, msgArray:rows};
      if (typeof data.talkTo?.member_name === 'string') result.talkTo = {member_name:plain(data.talkTo.member_name, 200)};
      return result;
    }
    const at = path.startsWith('/api/notification/at-me/');
    const nested = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : {};
    const rows = [at ? data.atList : data.replyList, data.msgArray, data.notifications, data.list, data.data, nested.atList, nested.replyList, nested.msgArray, nested.list].find(Array.isArray);
    if (!Array.isArray(rows)) fail('schema_invalid');
    return {success:true, [at ? 'atList' : 'replyList']:rows.map(row => {
      const id = validId(row?.id), post = validId(row?.post_id); if (!id || !post) fail('schema_invalid');
      const out = {id, post_id:post};
      optionalFields(out, row, ['commenter_name','post_title','title','content','created_at']);
      for (const name of ['commenter_id','member_id']) { const value = validId(row[name]); if (value) out[name] = value; }
      if (row.floor_id !== undefined && row.floor_id !== null) {
        const value = validId(String(row.floor_id).replace(/^#/, ''), true);
        if (value !== null && value <= 1000000) out.floor_id = value;
      }
      return out;
    })};
  }
  async function apiTask(args) {
    if (!allowedAPI(args.path) || Object.keys(args).some(key => key !== 'path')) fail('schema_invalid');
    const text = await forumGet(args.path); let data;
    try { data = JSON.parse(text); } catch { if (challenge(inertHTML(text))) fail('verification_required'); fail('schema_invalid'); }
    const result = projectAPI(args.path, data);
    if (encoder.encode(JSON.stringify(result)).byteLength > MAX_PAYLOAD - 1024) fail('schema_invalid');
    return result;
  }
  async function postTask(args) {
    if (Object.keys(args).some(key => !['postId','floor'].includes(key))) fail('schema_invalid');
    const post = validId(args.postId); if (!post) fail('schema_invalid');
    if (args.floor === null || args.floor === undefined) return '';
    const floor = validId(String(args.floor).replace(/^#/, ''), true);
    if (floor === null || floor > 1000000) fail('schema_invalid');
    const path = `/post-${post}-${Math.max(1, Math.ceil(floor / 10))}`;
    const root = inertHTML(await forumGet(path, MAX_HTML));
    if (challenge(root)) fail('verification_required');
    const node = root.querySelector(`[id="${floor}"]`) || root.querySelector(`#comment-${floor}`);
    const byLink = Array.from(root.querySelectorAll('a.floor-link')).find(link => {
      const url = new URL(link.getAttribute('href') || '', FORUM + path);
      return url.hash === `#${floor}` || link.textContent?.trim() === `#${floor}`;
    });
    const host = floor === 0 ? root.querySelector('.post-content,.nsk-post .nsk-content') : node || byLink?.closest('li,.comment-container');
    const content = host?.querySelector('.comment-content,.post-content,.content,.markdown-body') || host;
    if (!content) return '';
    content.querySelectorAll('script,style,noscript,iframe,object,embed,template').forEach(el => el.remove());
    return (content.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  }
  function bridge(path, payload) {
    if (!['/api/bridge/poll','/api/bridge/reply'].includes(path)) return Promise.reject(new BridgeError('schema_invalid'));
    const data = JSON.stringify(payload);
    if (encoder.encode(data).byteLength > MAX_PAYLOAD) return Promise.reject(new BridgeError('schema_invalid'));
    return new Promise((resolve, reject) => {
      let handle, settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true; requests.delete(cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = (code = 'request_failed') => { finish(new BridgeError(code)); try { handle?.abort(); } catch {} };
      requests.add(cancel);
      try {
        handle = GM_xmlhttpRequest({
          method:'POST', url:SERVER + path, anonymous:true, redirect:'error', responseType:'text',
          timeout:35000, headers:{'Content-Type':'application/json', Accept:'application/json', Authorization:`Bearer ${TOKEN}`}, data,
          onprogress:event => { if (Number(event.loaded) > MAX_PAYLOAD) cancel('schema_invalid'); },
          onload:response => {
            try {
              if ([401,403].includes(response.status)) { finish(new BridgeError('authorization_expired')); return; }
              if (response.status < 200 || response.status >= 300) fail('request_failed');
              if (response.finalUrl && new URL(response.finalUrl).href !== SERVER + path) fail('schema_invalid');
              const text = response.responseText;
              if (typeof text !== 'string' || encoder.encode(text).byteLength > MAX_PAYLOAD) fail('schema_invalid');
              const parsed = JSON.parse(text);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('schema_invalid');
              finish(null, parsed);
            } catch (error) { finish(new BridgeError(errors.has(error?.code) ? error.code : 'schema_invalid')); }
          },
          onerror:() => finish(new BridgeError('request_failed')),
          ontimeout:() => finish(new BridgeError('request_failed')),
          onabort:() => finish(new BridgeError('request_failed'))
        });
      } catch { finish(new BridgeError('request_failed')); }
    });
  }
  function sleep(milliseconds) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { sleeps.delete(timer); resolve(); }, milliseconds);
      sleeps.set(timer, resolve);
    });
  }
  async function execute(job, g, expectedAccountEpoch = accountEpoch) {
    if (!job || typeof job !== 'object' || typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(job.id)) fail('schema_invalid');
    const args = job.args ?? {};
    let reply = {clientId, id:job.id, ok:false, error:'request_failed'};
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args)) fail('schema_invalid');
      if (!running || generation !== g) fail('request_failed');
      let result;
      if (job.op === 'identity') {
        if (Object.keys(args).length) fail('schema_invalid');
        result = await refreshIdentity(true, g);
      } else if (job.op === 'api' || job.op === 'postText') {
        if (accountEpoch !== expectedAccountEpoch) fail('request_failed');
        const visible = domState();
        if (visible === 'verification') fail('verification_required');
        if (visible === 'login' || !account) fail('login_required');
        result = job.op === 'api' ? await apiTask(args) : await postTask(args);
        if (accountEpoch !== expectedAccountEpoch || !account || pageState !== 'forum') fail('request_failed');
      } else fail('schema_invalid');
      if (!running || generation !== g) return;
      reply = {clientId, id:job.id, ok:true, result};
      if (encoder.encode(JSON.stringify(reply)).byteLength > MAX_PAYLOAD) fail('schema_invalid');
    } catch (error) {
      reply = {clientId, id:job.id, ok:false, error:errors.has(error?.code) ? error.code : 'request_failed'};
      if (running && generation === g && accountEpoch === expectedAccountEpoch && ['verification_required','login_required'].includes(reply.error)) {
        setAccount(null, reply.error === 'verification_required' ? 'verification' : 'login');
      }
    }
    if (running && generation === g) await bridge('/api/bridge/reply', reply);
  }
  // Backend retryAfter is milliseconds, including standby=5000 and idle=250.
  function pollDelay(retryAfter, elapsed) {
    // A completed long poll already provides pacing; avoid a throttled background timer.
    if (elapsed >= 20000 && (!Number.isFinite(retryAfter) || retryAfter <= 1000)) return 0;
    return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(30000, Math.max(250, retryAfter)) : elapsed >= 20000 ? 0 : 1000;
  }
  async function loop(g) {
    let failures = 0;
    while (running && generation === g) {
      try {
        applyDOMState(); const began = Date.now(), pollAccountEpoch = accountEpoch;
        const result = await bridge('/api/bridge/poll', {clientId, account, pageState, ...(lastIdentityError ? {error:lastIdentityError} : {})});
        if (!running || generation !== g) break;
        failures = 0;
        if (result.job) { status('通知桥接已连接'); await execute(result.job, g, pollAccountEpoch); }
        else {
          const retry = Number(result.retryAfter);
          if (account) status(retry > 0 ? '通知桥接等待任务…' : '通知桥接已连接');
          const delay = pollDelay(retry, Date.now() - began);
          if (delay) await sleep(delay);
        }
      } catch (error) {
        if (!running || generation !== g) break;
        if (error?.code === 'authorization_expired') {
          terminal = true; stop(); status('通知桥接已停用：凭据失效，请重新安装私有脚本', true); break;
        }
        if (error?.code === 'schema_invalid') {
          terminal = true; stop(); status('通知桥接协议不兼容，请检查服务器与脚本版本', true); break;
        }
        failures = Math.min(failures + 1, 6);
        status('通知桥接连接暂不可用，稍后重试');
        await sleep(Math.min(60000, 1000 * 2 ** failures + Math.floor(Math.random() * 500)));
      }
    }
  }
  function stop() {
    running = false; generation++;
    clearInterval(identityTimer); identityTimer = null;
    clearTimeout(mutationTimer); mutationTimer = null;
    observer.disconnect();
    for (const controller of forumRequests) controller.abort();
    for (const cancel of [...requests]) cancel();
    for (const [timer, resolve] of sleeps) { clearTimeout(timer); resolve(); }
    sleeps.clear(); identityPending = null; setAccount(null, 'unknown');
  }
  async function start() {
    if (running || terminal) return;
    if (!/^[A-Za-z0-9_-]{24,256}$/.test(TOKEN)) {
      terminal = true; status('通知桥接尚未配对，请安装服务器提供的私有脚本', true); return;
    }
    if (typeof GM_xmlhttpRequest !== 'function') {
      terminal = true; status('通知桥接需要 Tampermonkey 的跨域请求权限', true); return;
    }
    running = true; const g = ++generation;
    status('通知桥接正在确认登录…');
    lastDOMState = domState();
    observer.observe(document.documentElement || document, {childList:true, subtree:true});
    try { await refreshIdentity(false, g); } catch {}
    if (!running || generation !== g) return;
    identityTimer = setInterval(() => {
      if (running && generation === g && Date.now() - identityAttempt >= 60000) void refreshIdentity(false, g).catch(() => {});
    }, 60000);
    void loop(g);
  }
  const observer = new MutationObserver(changes => {
    if (!running || changes.every(change => badgeNode?.contains(change.target))) return;
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => { mutationTimer = null; if (running) applyDOMState(); }, 300);
  });
  window.addEventListener('hashchange', () => { if (running) applyDOMState(); });
  window.addEventListener('popstate', () => { if (running) applyDOMState(); });
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', () => { void start(); });
  void start();
})();
