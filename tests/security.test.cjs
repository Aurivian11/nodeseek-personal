/* Offline DOM/API regression tests. No requests reach NodeSeek. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const { version: packageVersion } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = name => fs.readFileSync(path.join(root, 'src', name), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'condition was not met') {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); }
  assert.fail(message);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function userMarkup(id = 7, name = '本机用户') {
  const encoded = Buffer.from(JSON.stringify({ user: { member_id: id, member_name: name } })).toString('base64');
  return `<script id="temp-script" type="application/octet-stream">${encoded}</script>`;
}
function fixture(t, { files = [], html = userMarkup(), sessionHTML = html, url = 'https://www.nodeseek.com/', store = new Map(), locks, fetch, settings = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, {
    url, runScripts: 'outside-only', pretendToBeVisual: true
  });
  const { window: w } = dom;
  const originalPushState = w.history.pushState.bind(w.history);
  t.after(() => w.close());
  Object.assign(w, { TextEncoder, TextDecoder, Response, Request, Headers, structuredClone });
  // jsdom has dialog elements but does not implement their modal lifecycle.
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    w.setTimeout(() => this.dispatchEvent(new w.Event('close')), 0);
  };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.GM_getValue = (key, fallback) => store.has(key) ? structuredClone(store.get(key)) : fallback;
  w.GM_setValue = (key, value) => store.set(key, structuredClone(value));
  w.GM_registerMenuCommand = () => {};
  w.fetch = async (url, options) => {
    if (new URL(url, w.location.href).pathname === '/' && sessionHTML !== null) {
      return new Response(sessionHTML, { headers: { 'Content-Type': 'text/html' } });
    }
    if (fetch) return fetch(url, options);
    throw new Error(`Unexpected network request: ${url}`);
  };
  if (locks) Object.defineProperty(w.navigator, 'locks', { value: locks });
  const dependencies = files.some(name => ['20-account.js', '25-badges.js'].includes(name))
    ? ['15-profile-model.js', '18-profile-actions.js'].filter(name => !files.includes(name)) : [];
  w.eval(`(() => {\n${source('00-core.js')}\n${[...dependencies, ...files].map(source).join('\n')}\nwindow.__NSP_TEST__ = NSP;\n})();`);
  const nsp = w.__NSP_TEST__;
  Object.assign(nsp.settings, { autoSign: false, profiles: false, ...settings });
  return { w, nsp, store, originalPushState };
}
function lockManager() {
  const held = new Set();
  return { async request(name, options, task) {
    if (held.has(name)) return task(null);
    held.add(name);
    try { return await task({ name }); } finally { held.delete(name); }
  } };
}

test('The distributable contains only the three requested features and minimum grants', () => {
  const bundle = fs.readFileSync(path.join(root, 'dist', 'nodeseek-personal.user.js'), 'utf8');
  const metadata = fs.readFileSync(path.join(root, 'dist', 'nodeseek-personal.meta.js'), 'utf8');
  const header = bundle.match(/^\/\/ ==UserScript==\n[\s\S]*?\/\/ ==\/UserScript==\n/)?.[0];
  assert.ok(header, 'the installable script must start with a complete metadata header');
  assert.equal(metadata, header, 'the update file must contain only the exact installable-script metadata');
  const field = name => [...bundle.matchAll(new RegExp(`^// @${name}\\s+(\\S+)`, 'gm'))].map(match => match[1]);
  assert.deepEqual(field('version'), [packageVersion]);
  assert.deepEqual(field('updateURL'), ['https://raw.githubusercontent.com/Aurivian11/nodeseek-personal/main/dist/nodeseek-personal.meta.js']);
  assert.deepEqual(field('downloadURL'), ['https://raw.githubusercontent.com/Aurivian11/nodeseek-personal/main/dist/nodeseek-personal.user.js']);
  const grants = [...bundle.matchAll(/^\/\/ @grant\s+(\S+)/gm)].map(match => match[1]);
  assert.deepEqual(grants.sort(), ['GM_getValue', 'GM_registerMenuCommand', 'GM_setValue']);
  assert.doesNotMatch(bundle, /^\/\/ @(?:connect|require|resource)\s/m);
  assert.doesNotMatch(bundle, /\b(?:unsafeWindow|GM_xmlhttpRequest)\b|GM\.xmlHttpRequest/);
  assert.deepEqual([...bundle.matchAll(/NSP\.modules\.push\(\{\s*id:\s*'([^']+)'/g)].map(match => match[1]), ['account', 'badges', 'inbox-entry', 'messages']);
  assert.deepEqual([...bundle.matchAll(/^\/\/ Source: (.+)$/gm)].map(match => match[1]), ['00-core.js', '15-profile-model.js', '18-profile-actions.js', '20-account.js', '25-badges.js', '28-inbox-entry.js', '30-messages.js', '90-main.js']);
});

test('The actual built script reports the package version at runtime without adding network requests', async t => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main id="nsk-body"></main></body></html>', {
    url: 'https://www.nodeseek.com/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const { window: w } = dom;
  t.after(() => w.close());
  Object.assign(w, { TextEncoder, TextDecoder, structuredClone });
  w.GM_getValue = (key, fallback) => key === 'nsp:v1:settings'
    ? { autoSign: false, profiles: false, badges: false, chat: false } : fallback;
  w.GM_setValue = () => {};
  w.GM_registerMenuCommand = () => {};
  let requests = 0;
  w.fetch = async () => { requests++; throw new Error('The version check must stay offline'); };
  w.eval(fs.readFileSync(path.join(root, 'dist', 'nodeseek-personal.user.js'), 'utf8'));
  await until(() => w.document.querySelector('.nsp-tools'));
  assert.equal(w.document.documentElement.getAttribute('data-nsp-loaded'), packageVersion);
  assert.equal(w.document.querySelector('.nsp-tools').dataset.nspVersion, packageVersion);
  assert.equal(requests, 0);
});

test('URLs and API requests cannot escape the current origin', async t => {
  const calls = [];
  const { nsp } = fixture(t, { fetch: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } });
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//evil.example/api', 'https://www.nodeseek.com.evil.example/', 'https://www.deepflood.com/api']) {
    assert.equal(nsp.safeURL(value, 'https://www.nodeseek.com/', { sameOrigin: true }), null, value);
    await assert.rejects(nsp.api(value));
  }
  assert.equal(calls.length, 0);
  await assert.rejects(nsp.api('/api/account/change-password', { method: 'POST' }));
  await nsp.api('/api/notification/message/send', { method: 'POST', body: { content: '私信正文' } });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).origin, 'https://www.nodeseek.com');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.parse(calls[0].options.body).content, '私信正文');
});

test('API rejects HTTP errors and unexpected HTML rather than treating them as success', async t => {
  const { w, nsp } = fixture(t);
  w.fetch = async () => new Response('{"message":"服务故障"}', { status: 500, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(nsp.api('/api/notification/message/list'));
  w.fetch = async () => new Response('<html>登录验证</html>', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(nsp.api('/api/notification/message/list'));
});

test('Writes require the current server session to match the displayed account', async t => {
  for (const remoteHTML of [userMarkup(99, '另一个账号'), '<main>登录验证</main>', userMarkup(null, '')]) {
    let writes = 0;
    const { nsp } = fixture(t, {
      sessionHTML: remoteHTML,
      fetch: async () => { writes++; return json({ success: true }); }
    });
    await assert.rejects(nsp.api('/api/notification/message/send', {
      method: 'POST', body: { receiverUid: 8, content: '不应发出去' }
    }), error => error.confirmedFailure === true);
    assert.equal(writes, 0);
    if (remoteHTML === userMarkup(99, '另一个账号')) assert.equal(nsp.getUser(), null, 'known account mismatch disables the stale page identity');
  }
});

test('Login parsing is data-only and never mistakes a post author for the current user', t => {
  const loggedIn = fixture(t, { html: userMarkup(73, '<img src=x onerror=alert(1)>') });
  assert.equal(loggedIn.nsp.getUser()?.id, 73);
  assert.equal(loggedIn.nsp.getUser()?.name, '<img src=x onerror=alert(1)>');
  const guest = fixture(t, { html: '<article><a href="/space/888">帖子作者</a></article><script id="temp-script">not-base64</script>' });
  assert.equal(guest.nsp.getUser(), null);
});

test('Profile names and signatures are displayed as text, without executing HTML', async t => {
  const hostile = '<img src=x onerror=alert(1)><svg onload=alert(1)>签名';
  const { w, nsp } = fixture(t, {
    files: ['20-account.js'], html: userMarkup() + '<a id="peer" href="/space/8">联系人</a>',
    settings: { profiles: true }, fetch: async () => json({ success: true, detail: { member_name: hostile, bio: hostile, rank: 3 } })
  });
  nsp.initUI(); nsp.modules.find(module => module.id === 'account').start();
  w.document.querySelector('#peer').dispatchEvent(new w.FocusEvent('focusin', { bubbles: true }));
  await until(() => w.document.querySelector('.nsp-profile-bio'));
  const card = w.document.querySelector('.nsp-profile-card');
  assert.equal(card.querySelector('.nsp-profile-name').textContent, hostile);
  assert.equal(card.querySelector('.nsp-profile-bio').textContent, hostile);
  assert.equal(card.querySelectorAll('script,iframe,[onerror],[onload]').length, 0);
  assert.ok([...card.querySelectorAll('svg')].every(node => node.classList.contains('nsp-profile-metric-icon')), 'only locally generated metric icons may be SVG');
});

test('Closing a profile card returns focus without immediately reopening it', async t => {
  const { w, nsp } = fixture(t, {
    files: ['20-account.js'], html: userMarkup() + '<a id="peer" href="/space/8">联系人</a>',
    settings: { profiles: true }, fetch: async () => json({ success: true, detail: { member_name: '联系人', rank: 3 } })
  });
  nsp.initUI(); nsp.modules.find(module => module.id === 'account').start();
  w.document.querySelector('#peer').focus();
  await until(() => !w.document.querySelector('.nsp-profile-card').hidden);
  const close = w.document.querySelector('.nsp-profile-close');
  close.focus(); close.click();
  await delay(20);
  assert.equal(w.document.querySelector('.nsp-profile-card').hidden, true);
  assert.equal(w.document.activeElement.id, 'peer');
});

test('Profiles opened from a modal stay inside it and return hidden to the body when it closes', async t => {
  const { w, nsp } = fixture(t, {
    files: ['20-account.js'], html: userMarkup() + '<dialog id="host"><a id="peer" href="/space/8">联系人</a></dialog>',
    settings: { profiles: true }, fetch: async () => json({ success: true, detail: { member_name: '联系人', rank: 3 } })
  });
  nsp.initUI(); nsp.modules.find(module => module.id === 'account').start();
  const host = w.document.querySelector('#host');
  host.showModal();
  w.document.querySelector('#peer').focus();
  const card = w.document.querySelector('.nsp-profile-card');
  await until(() => !card.hidden);
  assert.equal(card.parentElement, host, 'the profile must be in the modal top-layer subtree');
  host.close();
  await until(() => card.hidden && card.parentElement === w.document.body);
  host.remove();
  assert.equal(card.isConnected, true, 'removing a closed modal must not remove the reusable profile card');
  assert.equal(card.hidden, true);
});

function completeProfile(overrides = {}) {
  return {
    member_name: '真实用户', created_at: '2021-01-01T00:00:00Z', rank: 4,
    nPost: 123, nComment: 456, coin: 789, stardust: 42, fans: 17,
    roles: [{ display_text: '先锋会员' }, '内容贡献者'], followed: false,
    ...overrides
  };
}

test('Profile metrics keep missing data unknown and clamp complete scores to 0–100', t => {
  const { nsp } = fixture(t, { files: ['15-profile-model.js'] });
  const now = Date.parse('2026-11-02T00:00:00Z');
  const normal = nsp.profileMetrics(completeProfile({ created_at: '2026-11-01T00:00:00Z' }), now);
  assert.equal(normal.days, 1);
  assert.equal(normal.joined, '2026-11-01');
  assert.equal(normal.level, 4);
  assert.ok(Number.isInteger(normal.score) && normal.score >= 0 && normal.score <= 100);
  const missing = nsp.profileMetrics({}, now);
  assert.equal(missing.days, null);
  assert.equal(missing.joined, '未知');
  assert.equal(missing.level, null);
  assert.equal(missing.score, null);
  for (const key of ['created_at', 'nPost', 'nComment', 'fans', 'coin', 'stardust']) {
    assert.equal(nsp.profileMetrics(completeProfile({ [key]: null }), now).score, null, key);
  }
  const excessive = completeProfile(Object.fromEntries(['nPost', 'nComment', 'fans', 'coin', 'stardust'].map(key => [key, Number.MAX_SAFE_INTEGER])));
  assert.equal(nsp.profileMetrics(excessive, now).score, 100);
  assert.equal(nsp.profileMetrics(completeProfile({ rank: 7 }), now).level, null);
  assert.equal(nsp.profileMetrics(completeProfile({ coin: -1 }), now).score, null);
  assert.equal(nsp.profileMetrics(completeProfile({ created_at: '2099-01-01' }), now).days, null);
  assert.match(nsp.scoreDescription(), /非官方/);
});

test('The enhanced card shows real roles and balances plus four actions without automatic mutations', async t => {
  const requests = [];
  const { w, nsp } = fixture(t, {
    files: ['20-account.js'], html: userMarkup() + '<a id="peer" href="/space/8">联系人</a>',
    settings: { profiles: true }, fetch: async (url, options) => {
      requests.push({ path: new URL(url).pathname, method: options.method });
      return json({ success: true, detail: completeProfile() });
    }
  });
  nsp.initUI(); nsp.modules.find(module => module.id === 'account').start();
  w.document.querySelector('#peer').focus();
  await until(() => w.document.querySelector('.nsp-profile-facts'));
  const card = w.document.querySelector('.nsp-profile-card');
  const facts = Object.fromEntries([...card.querySelectorAll('.nsp-profile-facts>div')].map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]));
  assert.deepEqual(facts, { 等级: 'Lv 4', 主题帖: '123', 鸡腿: '789', 评论数: '456', 星辰: '42', 粉丝: '17' });
  assert.deepEqual([...card.querySelectorAll('.nsp-profile-role')].map(node => node.textContent), ['先锋会员', '内容贡献者']);
  assert.deepEqual([...card.querySelectorAll('.nsp-profile-actions button')].map(node => node.textContent), ['转账', '关注', '私信', '屏蔽']);
  assert.equal(card.querySelector('.nsp-profile-score small').textContent, '参考信任分');
  assert.match(card.querySelector('.nsp-profile-age').textContent, /加入 [\d,]+ 天/);
  assert.match(card.querySelector('.nsp-profile-joined').textContent, /2021-01-01/);
  assert.deepEqual(requests, [{ path: '/api/account/getInfo/8', method: 'GET' }]);
});

test('Incomplete profile responses do not fabricate balances, dates, levels or scores', async t => {
  const { w, nsp } = fixture(t, {
    files: ['20-account.js'], html: userMarkup() + '<a id="peer" href="/space/8">联系人</a>',
    settings: { profiles: true }, fetch: async () => json({ success: true, detail: { member_name: '只有用户名' } })
  });
  nsp.initUI(); nsp.modules.find(module => module.id === 'account').start();
  w.document.querySelector('#peer').focus();
  await until(() => w.document.querySelector('.nsp-profile-facts'));
  const card = w.document.querySelector('.nsp-profile-card');
  assert.ok([...card.querySelectorAll('.nsp-profile-facts dd')].every(node => node.textContent === '未知'));
  assert.equal(card.querySelector('.nsp-profile-score strong').textContent, '—');
  assert.equal(card.querySelector('.nsp-profile-roles').hidden, true);
  assert.match(card.querySelector('.nsp-profile-age').textContent, /未知/);
  assert.match(card.querySelector('.nsp-profile-joined').textContent, /未知/);
});

test('Follow and block require explicit actions; money transfers stay outside the API whitelist', async t => {
  const calls = [];
  const { w, nsp } = fixture(t, {
    files: ['18-profile-actions.js'],
    html: userMarkup() + '<div class="user-card"><button id="native-transfer">转账</button></div>',
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: options.method, body: options.body && JSON.parse(options.body) });
      if (path === '/api/account/getInfo/8') return json({ success: true, detail: { followed: false } });
      if (path === '/api/block-list/list') return json({ success: true, data: [] });
      return json({ success: true });
    }
  });
  nsp.initUI();
  const group = nsp.profileActions(8, () => '联系人', { followed: false });
  w.document.body.append(group);
  assert.equal(calls.length, 0);
  group.querySelector('[data-action=follow]').click();
  await until(() => calls.some(call => call.path === '/api/fans/add'));
  assert.deepEqual(calls.slice(0, 2).map(call => [call.path, call.method]), [['/api/account/getInfo/8', 'GET'], ['/api/fans/add', 'POST']]);
  assert.deepEqual(calls[1].body, { followed_member_id: 8 });
  await until(() => !group.querySelector('[data-action=follow]').disabled);
  w.confirm = () => false;
  group.querySelector('[data-action=block]').click();
  await until(() => calls.some(call => call.path === '/api/block-list/list') && !group.querySelector('[data-action=block]').disabled);
  assert.equal(calls.some(call => call.path === '/api/block-list/add'), false, 'cancelled block confirmation must not write');
  w.confirm = () => true;
  group.querySelector('[data-action=block]').click();
  await until(() => calls.some(call => call.path === '/api/block-list/add'));
  assert.deepEqual(calls.find(call => call.path === '/api/block-list/add').body, { block_member_name: '联系人' });
  let nativeClicks = 0;
  w.document.querySelector('#native-transfer').addEventListener('click', () => nativeClicks++);
  const beforeTransfer = calls.length;
  group.querySelector('[data-action=transfer]').click();
  assert.equal(nativeClicks, 1);
  assert.equal(calls.length, beforeTransfer, 'opening native transfer must not call an account mutation endpoint');
  await assert.rejects(nsp.api('/api/stardust/transfer', { method: 'POST', body: { member_id: 8, amount: 1 } }));
  assert.equal(calls.length, beforeTransfer);
});

function badgeFixture(t, html, fetch) {
  const f = fixture(t, { files: ['20-account.js', '25-badges.js'], html: userMarkup() + html, settings: { profiles: true, badges: true }, fetch });
  const observers = [];
  f.w.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  };
  f.nsp.initUI();
  f.nsp.modules.find(module => module.id === 'account').start();
  f.nsp.modules.find(module => module.id === 'badges').start();
  return { ...f, observers, reveal: () => observers.forEach(observer => observer.callback([...observer.targets].map(target => ({ target, isIntersecting: true })))) };
}

test('Inline badges bind only forum text authors and share requests without mixing user data', async t => {
  const calls = [];
  const profiles = { 8: deferred(), 9: deferred() };
  const f = badgeFixture(t, `
    <div class="author-info" id="first-row"><a id="author8a" href="/space/8">作者八</a></div>
    <div class="author-info"><a id="author8b" href="/space/8">作者八第二处</a></div>
    <div class="author-info"><a id="author9" href="/space/9">作者九</a></div>
    <div class="author-info"><a id="avatar-only" href="/space/10"><img alt="头像" src="/avatar/10.png"></a></div>
    <div class="author-info"><a id="external" href="https://external.example/space/12">外部作者</a></div>
    <div class="nsp-chat"><div class="author-info"><a id="own-ui" href="/space/11">聊天里的名字</a></div></div>
    <nav><div class="author-info"><a id="navigation" href="/space/13">导航账号</a></div></nav>`,
    async (url, options) => {
      assert.equal(options.method, 'GET');
      const id = Number(new URL(url).pathname.split('/').pop());
      calls.push(id);
      assert.ok(profiles[id], `an excluded author should not be requested: ${id}`);
      return profiles[id].promise;
    });
  await until(() => f.observers.some(observer => observer.targets.size === 3));
  assert.equal(calls.length, 0, 'off-screen badges must not fetch profiles before observation');
  f.reveal();
  await until(() => calls.length === 2);
  assert.deepEqual([...calls].sort(), [8, 9]);
  profiles[8].resolve(json({ success: true, detail: completeProfile({ rank: 2, member_name: '<img src=x onerror=alert(1)>' }) }));
  await until(() => f.w.document.querySelectorAll('.nsp-user-badges[data-nsp-user="8"]').length === 2);
  assert.equal(f.w.document.querySelector('#author9').nextElementSibling, null);
  profiles[9].resolve(json({ success: true, detail: completeProfile({ rank: 5, coin: null }) }));
  await until(() => f.w.document.querySelector('.nsp-user-badges[data-nsp-user="9"]'));
  const first = f.w.document.querySelector('#author8a').nextElementSibling;
  const second = f.w.document.querySelector('#author9').nextElementSibling;
  assert.equal(first.dataset.nspUser, '8');
  assert.equal(first.querySelector('.nsp-user-badge-level').textContent, 'Lv2');
  assert.equal(second.dataset.nspUser, '9');
  assert.equal(second.querySelector('.nsp-user-badge-level').textContent, 'Lv5');
  assert.equal(second.querySelector('.nsp-user-badge-score'), null, 'an incomplete profile has no invented score');
  for (const id of ['avatar-only', 'external', 'own-ui', 'navigation']) assert.equal(f.w.document.getElementById(id).nextElementSibling?.classList.contains('nsp-user-badges') || false, false, id);
  for (const wrapper of f.w.document.querySelectorAll('.nsp-user-badges')) assert.equal(wrapper.querySelectorAll('script,img,iframe,[onerror],[onload]').length, 0);

  f.w.document.querySelector('#author8a').append(f.w.document.createTextNode('更新'));
  const cloned = f.w.document.querySelector('#first-row').cloneNode(true);
  cloned.removeAttribute('id');
  cloned.querySelector('a').id = 'author8-cloned';
  f.w.document.body.append(cloned);
  await until(() => f.observers.some(observer => [...observer.targets].some(target => target.id === 'author8-cloned')));
  f.reveal();
  await until(() => f.w.document.querySelectorAll('.nsp-user-badges').length === 4);
  assert.equal(cloned.querySelectorAll('.nsp-user-badges').length, 1, 'cloned old badges must be replaced, not duplicated');
  assert.equal(f.w.document.querySelector('#first-row').querySelectorAll('.nsp-user-badges').length, 1);
  assert.deepEqual([...calls].sort(), [8, 9], 'new occurrences reuse the profile cache');
});

test('Automatic sign-in respects its setting and is unavailable without a cross-tab lock', async t => {
  let calls = 0;
  const first = fixture(t, { files: ['20-account.js'], fetch: async () => { calls++; throw new Error('must not send'); } });
  first.nsp.initUI(); first.nsp.modules.find(module => module.id === 'account').start();
  const second = fixture(t, { files: ['20-account.js'], settings: { autoSign: true }, fetch: async () => { calls++; throw new Error('must not send'); } });
  second.nsp.initUI(); second.nsp.modules.find(module => module.id === 'account').start();
  await delay(20);
  assert.equal(calls, 0);
});

test('Two tabs share one sign-in attempt; failed automatic sign-in does not loop', async t => {
  const shared = new Map(), locks = lockManager(), pending = deferred();
  let calls = 0;
  const fetch = async () => { calls++; return pending.promise; };
  const first = fixture(t, { files: ['20-account.js'], store: shared, locks, settings: { autoSign: true }, fetch });
  const second = fixture(t, { files: ['20-account.js'], store: shared, locks, settings: { autoSign: true }, fetch });
  for (const f of [first, second]) { f.nsp.initUI(); f.nsp.modules.find(module => module.id === 'account').start(); }
  await until(() => calls === 1, 'one tab should start sign-in');
  pending.resolve(new Response('{"success":false,"message":"稍后再试"}', { headers: { 'Content-Type': 'application/json' } }));
  await delay(30);
  for (let i = 0; i < 3; i++) for (const f of [first, second]) f.w.dispatchEvent(new f.w.Event('focus'));
  await delay(20);
  assert.equal(calls, 1, 'same-day automatic retries are forbidden');
});

test('Successful sign-in suppresses later attempts across tabs', async t => {
  const shared = new Map(), locks = lockManager();
  let calls = 0;
  const fetch = async () => { calls++; return new Response('{"success":true,"gain":5}', { headers: { 'Content-Type': 'application/json' } }); };
  const first = fixture(t, { files: ['20-account.js'], store: shared, locks, settings: { autoSign: true }, fetch });
  first.nsp.initUI(); first.nsp.modules.find(module => module.id === 'account').start();
  await until(() => [...shared.keys()].some(key => key.endsWith(':done')), 'sign-in should persist completion');
  const second = fixture(t, { files: ['20-account.js'], store: shared, locks, settings: { autoSign: true }, fetch });
  second.nsp.initUI(); second.nsp.modules.find(module => module.id === 'account').start();
  await delay(20);
  assert.equal(calls, 1);
});

test('Fresh installs and existing fixed-reward settings actually request random attendance', async t => {
  for (const existing of [null, { signMode: 'fixed', autoSign: true, profiles: true, chat: false }]) {
    const saved = existing ? new Map([['nsp:v1:settings', existing]]) : new Map();
    const requests = [];
    const f = fixture(t, {
      files: ['20-account.js'], store: saved, locks: lockManager(), settings: { autoSign: true },
      fetch: async (url, options) => {
        requests.push({ url: new URL(url), method: options.method });
        return json({ success: true, gain: 6 });
      }
    });
    assert.equal(f.nsp.settings.signMode, 'random');
    f.nsp.initUI(); f.nsp.modules.find(module => module.id === 'account').start();
    await until(() => requests.some(request => request.url.pathname === '/api/attendance'));
    const attendance = requests.find(request => request.url.pathname === '/api/attendance');
    assert.equal(attendance.method, 'POST');
    assert.equal(attendance.url.searchParams.get('random'), 'true');
    assert.equal(saved.get('nsp:v1:settings').signMode, 'random');
    assert.equal(saved.get('nsp:v1:migration:random-sign-v012'), true);
  }
});

test('The random-reward migration runs once and preserves a later explicit fixed-reward choice', async t => {
  const saved = new Map([['nsp:v1:settings', { signMode: 'fixed', autoSign: true }]]);
  const first = fixture(t, { store: saved });
  assert.equal(first.nsp.settings.signMode, 'random');
  first.nsp.store.set('settings', { ...first.nsp.settings, signMode: 'fixed' });
  const requests = [];
  const second = fixture(t, {
    files: ['20-account.js'], store: saved, locks: lockManager(), settings: { autoSign: true },
    fetch: async url => { requests.push(new URL(url)); return json({ success: true, gain: 5 }); }
  });
  assert.equal(second.nsp.settings.signMode, 'fixed');
  second.nsp.initUI(); second.nsp.modules.find(module => module.id === 'account').start();
  await until(() => requests.some(url => url.pathname === '/api/attendance'));
  assert.equal(requests.find(url => url.pathname === '/api/attendance').searchParams.get('random'), 'false');
  assert.equal(saved.get('nsp:v1:settings').signMode, 'fixed');
});

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function message(id, peer, content, extra = {}) {
  return { id, sender_id: peer, receiver_id: 7, sender_name: `联系人${peer}`, receiver_name: '本机用户',
    content, created_at: '2026-11-02T07:00:00Z', viewed: true, markdown: true, ...extra };
}
function chatFixture(t, handler) {
  const f = fixture(t, {
    files: ['30-messages.js'], settings: { chat: true },
    fetch: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/list')) return json({ success: true, msgArray: [] });
      return handler(pathname, options);
    }
  });
  f.nsp.initUI();
  f.nsp.modules.find(module => module.id === 'messages').start();
  return f;
}

function nativeUserCard(id = 7, name = '我的账号', extraClass = '', elementId = 'native-own-card') {
  return `<section id="${elementId}" class="user-card ${extraClass}">
    <a href="/space/${id}"><img alt="头像" src="/avatar/${id}.png"></a>
    <a href="/space/${id}">${name}</a>
    <div class="user-stat"><div class="stat-block"><a class="native-notification" href="/notification">通知 3</a></div>
    <div class="stat-block"><a href="/notification#/atMe">@我 2</a></div></div>
  </section>`;
}
function inboxEntryFixture(t, { html = userMarkup() + nativeUserCard(), chat = true } = {}) {
  const f = fixture(t, { files: ['28-inbox-entry.js'], html, settings: { chat } });
  const opens = [];
  f.nsp.openChat = (...args) => opens.push(args);
  f.nsp.modules.find(module => module.id === 'inbox-entry').start();
  return { ...f, opens };
}

test('The own-card inbox entry respects disabled chat, guests and card identity', async t => {
  const disabled = inboxEntryFixture(t, { chat: false });
  const guest = inboxEntryFixture(t, { html: userMarkup(null, '') + nativeUserCard() });
  const eligible = inboxEntryFixture(t, { html: userMarkup() + nativeUserCard()
    + nativeUserCard(7, '悬浮资料', 'hover-user-card', 'native-hover-card')
    + nativeUserCard(8, '其他用户', '', 'native-other-card')
    + `<div class="nsp-chat">${nativeUserCard(7, '聊天中的资料', '', 'nsp-card')}</div>` });
  await until(() => eligible.w.document.querySelector('.nsp-inbox-entry-button'));
  await delay(20);
  assert.equal(disabled.w.document.querySelector('.nsp-inbox-entry'), null);
  assert.equal(guest.w.document.querySelector('.nsp-inbox-entry'), null);
  assert.equal(eligible.w.document.querySelectorAll('.nsp-inbox-entry-button').length, 1);
  assert.ok(eligible.w.document.querySelector('#native-own-card .nsp-inbox-entry-button'));
  for (const id of ['native-hover-card', 'native-other-card', 'nsp-card']) assert.equal(eligible.w.document.getElementById(id).querySelector('.nsp-inbox-entry'), null, id);
});

test('The inbox entry handles late and replaced own cards without duplicates or changing notification links', async t => {
  const f = inboxEntryFixture(t, { html: userMarkup() + '<main id="native-host"></main>' });
  const host = f.w.document.querySelector('#native-host');
  assert.equal(f.w.document.querySelector('.nsp-inbox-entry'), null);
  host.innerHTML = nativeUserCard();
  const originalLink = host.querySelector('.native-notification');
  await until(() => host.querySelector('.nsp-inbox-entry-button'));
  assert.equal(originalLink.isConnected, true);
  assert.equal(originalLink.getAttribute('href'), '/notification');
  assert.equal(originalLink.textContent, '通知 3');
  assert.equal(originalLink.hidden, false);
  host.querySelector('#native-own-card').append(f.w.document.createElement('span'));
  await delay(180);
  assert.equal(host.querySelectorAll('.nsp-inbox-entry-button').length, 1);
  host.querySelector('.nsp-inbox-entry-button').click();
  assert.deepEqual(f.opens, [[]], 'the sidebar entry must open the inbox without selecting an account as a recipient');

  const copy = host.querySelector('#native-own-card').cloneNode(true);
  host.replaceChildren(copy);
  await delay(180);
  assert.equal(host.querySelectorAll('.nsp-inbox-entry-button').length, 1, 'cloned entries must not accumulate');
  host.querySelector('.nsp-inbox-entry-button').click();
  assert.deepEqual(f.opens, [[], []], 'a re-rendered entry must remain functional');
  assert.equal(host.querySelector('.native-notification').getAttribute('href'), '/notification');
});

test('Clicking the own-card inbox entry loads contacts without sending or marking unselected messages read', async t => {
  const requests = [];
  const f = fixture(t, {
    files: ['28-inbox-entry.js', '30-messages.js'], html: userMarkup() + nativeUserCard(), settings: { chat: true },
    fetch: async (url, options) => {
      const pathname = new URL(url).pathname;
      requests.push({ pathname, method: options.method });
      assert.equal(pathname, '/api/notification/message/list', 'opening the inbox must not load a selected conversation or mark it read');
      assert.equal(options.method, 'GET');
      return json({ success: true, msgArray: [message(101, 8, '还未选中的未读私信', { viewed: false })] });
    }
  });
  f.nsp.initUI();
  for (const module of f.nsp.modules) module.start();
  await until(() => f.w.document.querySelector('.nsp-inbox-entry-button'));
  assert.equal(requests.length, 0);
  f.w.document.querySelector('.nsp-inbox-entry-button').click();
  await until(() => f.w.document.querySelector('.nsp-chat')?.open && f.w.document.querySelector('.nsp-chat-contact'));
  assert.deepEqual(requests, [{ pathname: '/api/notification/message/list', method: 'GET' }]);
  assert.equal(f.w.document.querySelector('.nsp-chat-contact').getAttribute('aria-pressed'), 'false');
  assert.ok(f.w.document.querySelector('.nsp-chat-unread'));
  assert.equal(f.w.document.querySelector('.nsp-chat-send').disabled, true);
});

function unreadInboxFixture(t, { failMarkAll = false } = {}) {
  const requests = [];
  let allViewed = false;
  const f = fixture(t, {
    files: ['30-messages.js'], settings: { chat: true },
    fetch: async (url, options) => {
      const target = new URL(url);
      requests.push({ pathname: target.pathname, search: target.search, method: options.method, body: options.body });
      if (target.pathname.endsWith('/list')) return json({ success: true, msgArray: [
        message(201, 8, '预算核对完成', { viewed: allViewed, sender_name: '小林', sender_avatar: 'https://untrusted.example/avatar.png' }),
        message(202, 9, '明天讨论新服务器', { viewed: allViewed, sender_name: '小周', avatar: 'javascript:alert(1)' })
      ] });
      if (target.pathname.endsWith('/markViewed') && target.searchParams.get('all') === 'true') {
        if (failMarkAll) return json({ success: false, message: '站点拒绝本次标记' }, 400);
        allViewed = true;
        return json({ success: true });
      }
      throw new Error(`Unexpected inbox request: ${target.pathname}`);
    }
  });
  f.nsp.initUI();
  f.nsp.modules.find(module => module.id === 'messages').start();
  [...f.w.document.querySelectorAll('.nsp-tools button')].find(button => button.textContent === '私信').click();
  return { ...f, requests };
}

test('Inbox search includes recent message text, avatars remain same-origin and notification shortcuts stay native', async t => {
  const f = unreadInboxFixture(t);
  await until(() => f.w.document.querySelectorAll('.nsp-chat-contact').length === 2);
  const avatars = [...f.w.document.querySelectorAll('.nsp-chat-contact img')];
  assert.equal(avatars.length, 2);
  assert.deepEqual(avatars.map(image => image.src).sort(), ['https://www.nodeseek.com/avatar/8.png', 'https://www.nodeseek.com/avatar/9.png']);
  assert.ok(avatars.every(image => image.referrerPolicy === 'no-referrer'));
  for (const route of ['atMe', 'reply']) {
    const link = f.w.document.querySelector(`.nsp-chat a[href="/notification#/${route}"]`);
    assert.ok(link, route);
    assert.equal(link.target, '_blank');
    assert.match(link.rel, /noopener/);
  }
  const search = f.w.document.querySelector('.nsp-chat-search');
  search.value = '预算核对';
  search.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  assert.equal(f.w.document.querySelectorAll('.nsp-chat-contact').length, 1);
  assert.match(f.w.document.querySelector('.nsp-chat-contact').textContent, /小林/);
  assert.equal(f.requests.length, 1, 'search and rendering do not fetch notification APIs or mark messages read');
  assert.equal(f.requests[0].method, 'GET');
});

test('Mark-all-read requires confirmation and clears unread state only after explicit success', async t => {
  const f = unreadInboxFixture(t);
  await until(() => f.w.document.querySelectorAll('.nsp-chat-unread').length === 2);
  const button = f.w.document.querySelector('.nsp-chat-mark-all');
  assert.match(button.title, /全部私信/);
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
  f.w.confirm = text => { assert.match(text, /全部私信/); return false; };
  button.click();
  await delay(10);
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
  assert.equal(f.w.document.querySelectorAll('.nsp-chat-unread').length, 2);
  f.w.confirm = () => true;
  button.click();
  await until(() => f.requests.some(request => request.method === 'POST') && !button.disabled && f.w.document.querySelectorAll('.nsp-chat-unread').length === 0);
  const writes = f.requests.filter(request => request.method === 'POST');
  assert.deepEqual(writes.map(request => [request.pathname, request.search]), [['/api/notification/message/markViewed', '?all=true']]);
  assert.equal(writes[0].body, undefined);
});

test('A rejected mark-all-read request preserves unread badges and reports failure', async t => {
  const f = unreadInboxFixture(t, { failMarkAll: true });
  await until(() => f.w.document.querySelectorAll('.nsp-chat-unread').length === 2);
  f.w.confirm = () => true;
  const button = f.w.document.querySelector('.nsp-chat-mark-all');
  button.click();
  await until(() => !button.disabled && f.w.document.querySelector('.nsp-chat-sidebar').textContent.includes('标记未完成'));
  assert.equal(f.w.document.querySelectorAll('.nsp-chat-unread').length, 2);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  assert.match(f.w.document.querySelector('.nsp-chat-sidebar').textContent, /站点拒绝本次标记/);
});

test('Mark-all-read invalidates an older in-flight thread before refreshing the inbox', async t => {
  const oldThread = deferred();
  const writes = [];
  let lists = 0, threads = 0, oldSignal;
  const f = fixture(t, {
    files: ['30-messages.js'], settings: { chat: true },
    fetch: async (url, options) => {
      const target = new URL(url);
      if (target.pathname.endsWith('/list')) {
        lists++;
        return json({ success: true, msgArray: [lists === 1
          ? message(10, 8, '旧列表预览', { viewed: false })
          : message(20, 8, '全读之后新到的未读消息', { viewed: false, created_at: '2026-11-02T07:02:00Z' })] });
      }
      if (target.pathname.endsWith('/with/8')) {
        threads++;
        if (threads === 1) { oldSignal = options.signal; return oldThread.promise; }
        return json({ success: true, msgArray: [], talkTo: { member_name: '联系人8' } });
      }
      assert.equal(options.method, 'POST');
      writes.push({ path: target.pathname, search: target.search, body: options.body });
      return json({ success: true });
    }
  });
  f.nsp.initUI(); f.nsp.modules.find(module => module.id === 'messages').start();
  f.nsp.openChat(8, '联系人8');
  await until(() => threads === 1 && f.w.document.querySelector('.nsp-chat-contact .nsp-chat-preview')?.textContent.includes('旧列表预览'));
  f.w.confirm = () => true;
  f.w.document.querySelector('.nsp-chat-mark-all').click();
  await until(() => threads === 2 && lists === 2 && f.w.document.querySelector('.nsp-chat-contact .nsp-chat-preview')?.textContent.includes('全读之后新到'));
  assert.equal(oldSignal.aborted, true);
  // The mock deliberately ignores cancellation to emulate a response already
  // delivered to the browser before its abort was processed.
  oldThread.resolve(json({ success: true, msgArray: [message(11, 8, '过期会话响应不得恢复', { viewed: false, created_at: '2026-11-02T07:01:00Z' })], talkTo: { member_name: '联系人8' } }));
  await delay(20);
  assert.match(f.w.document.querySelector('.nsp-chat-contact .nsp-chat-preview').textContent, /全读之后新到/);
  assert.ok(f.w.document.querySelector('.nsp-chat-contact .nsp-chat-unread'));
  assert.doesNotMatch(f.w.document.querySelector('.nsp-chat-thread').textContent, /过期会话响应不得恢复/);
  assert.deepEqual(writes.map(write => [write.path, write.search]), [['/api/notification/message/markViewed', '?all=true']]);
});

test('An older thread and its read acknowledgement cannot overwrite a newer list preview or unread badge', async t => {
  const oldThread = deferred(), markedOldMessages = deferred();
  const writes = [];
  let lists = 0;
  const f = fixture(t, {
    files: ['30-messages.js'], settings: { chat: true },
    fetch: async (url, options) => {
      const target = new URL(url);
      if (target.pathname.endsWith('/list')) {
        lists++;
        return json({ success: true, msgArray: [lists === 1
          ? message(101, 8, '旧列表消息', { viewed: false })
          : message(undefined, 8, '较新的消息仍未读', { max_id: 202, viewed: false })] });
      }
      if (target.pathname.endsWith('/with/8')) return oldThread.promise;
      assert.equal(target.pathname, '/api/notification/message/markViewed');
      writes.push(JSON.parse(options.body));
      return markedOldMessages.promise;
    }
  });
  f.nsp.initUI(); f.nsp.modules.find(module => module.id === 'messages').start();
  f.nsp.openChat(8, '联系人8');
  await until(() => f.w.document.querySelector('.nsp-chat-contact .nsp-chat-preview')?.textContent.includes('旧列表消息') && !f.w.document.querySelector('.nsp-chat-refresh').disabled);
  f.w.document.querySelector('.nsp-chat-refresh').click();
  await until(() => f.w.document.querySelector('.nsp-chat-contact .nsp-chat-preview')?.textContent.includes('较新的消息'));
  // Same timestamp, but the new list row's max_id is newer than this thread row.
  oldThread.resolve(json({ success: true, msgArray: [message(101, 8, '只读到的较旧消息', { viewed: false })], talkTo: { member_name: '联系人8' } }));
  await until(() => writes.length === 1);
  assert.deepEqual(writes[0], { messages: [101] });
  markedOldMessages.resolve(json({ success: true }));
  await until(() => !f.w.document.querySelector('.nsp-chat-heading button:last-child').disabled);
  assert.match(f.w.document.querySelector('.nsp-chat-contact .nsp-chat-preview').textContent, /较新的消息仍未读/);
  assert.ok(f.w.document.querySelector('.nsp-chat-contact .nsp-chat-unread'), 'marking ID 101 read must not clear the unread state of max_id 202');
});

test('An unconfirmed direct recipient cannot receive messages before the server identifies it as a system account', async t => {
  const pending = deferred();
  let sends = 0;
  const f = chatFixture(t, async pathname => {
    if (pathname.endsWith('/send')) { sends++; return json({ success: true }); }
    return pending.promise;
  });
  f.nsp.openChat(8, '调用方提供的普通用户名');
  const input = writeMessage(f, '系统会话不应收到这条消息');
  const send = f.w.document.querySelector('.nsp-chat-send');
  assert.equal(input.disabled, false, 'draft entry can remain available while identity is loading');
  assert.equal(send.disabled, true);
  send.click();
  input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await delay(10);
  assert.equal(sends, 0, 'a caller-provided name must not authorize sending');
  pending.resolve(json({ success: true, msgArray: [], talkTo: { member_name: '系统通知' } }));
  await until(() => f.w.document.querySelector('.nsp-chat-peer-name').textContent === '系统消息');
  assert.equal(f.w.document.querySelector('.nsp-chat-composer').hidden, true);
  assert.equal(send.disabled, true);
  input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  assert.equal(sends, 0);
});

test('A successful thread can use the server-confirmed list identity when talkTo is absent', async t => {
  const pending = deferred();
  const f = fixture(t, {
    files: ['30-messages.js'], settings: { chat: true },
    fetch: async url => new URL(url).pathname.endsWith('/list')
      ? json({ success: true, msgArray: [message(301, 8, '已读的旧消息', { sender_name: '列表确认的真实用户名' })] })
      : pending.promise
  });
  f.nsp.initUI(); f.nsp.modules.find(module => module.id === 'messages').start();
  f.nsp.openChat(8, '未经确认的名称');
  writeMessage(f, '普通联系人可以发送');
  await until(() => f.w.document.querySelector('.nsp-chat-peer-name').textContent === '列表确认的真实用户名');
  assert.equal(f.w.document.querySelector('.nsp-chat-send').disabled, true, 'a list identity alone is insufficient before the thread loads');
  pending.resolve(json({ success: true, msgArray: [] }));
  await until(() => !f.w.document.querySelector('.nsp-chat-send').disabled);
});

function writeMessage(f, value) {
  const input = f.w.document.querySelector('.nsp-chat-input');
  input.value = value;
  input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  return input;
}

test('Chat treats hostile HTML as text and requires a click before loading external images', async t => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(1)</script> [坏链接](javascript:alert(1)) ![预览](https://images.example/private.png)';
  const f = chatFixture(t, async () => json({ success: true, msgArray: [message(1, 8, hostile)], talkTo: { member_name: '<img onerror=alert(1)>' } }));
  f.nsp.openChat(8, '联系人');
  await until(() => f.w.document.querySelector('.nsp-chat-bubble'));
  const bubble = f.w.document.querySelector('.nsp-chat-bubble');
  assert.match(bubble.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(bubble.querySelectorAll('script,img,iframe,svg').length, 0);
  assert.equal(f.w.document.querySelector('.nsp-chat-peer-name img'), null);
  const imageButton = bubble.querySelector('.nsp-chat-load-image');
  assert.ok(imageButton);
  imageButton.click();
  assert.equal(bubble.querySelector('img').src, 'https://images.example/private.png');
  assert.equal(bubble.querySelector('img').referrerPolicy, 'no-referrer');
  assert.equal(bubble.querySelector('img').getAttribute('onerror'), null);
});

test('A late conversation response cannot overwrite the currently selected conversation', async t => {
  const older = deferred();
  const f = chatFixture(t, async pathname => {
    if (pathname.endsWith('/8')) return older.promise;
    return json({ success: true, msgArray: [message(2, 9, '九号联系人正文')], talkTo: { member_name: '九号联系人' } });
  });
  f.nsp.openChat(8, '八号联系人');
  f.nsp.openChat(9, '九号联系人');
  await until(() => f.w.document.querySelector('.nsp-chat-thread').textContent.includes('九号联系人正文'));
  older.resolve(json({ success: true, msgArray: [message(1, 8, '不该显示的旧响应')], talkTo: { member_name: '八号联系人' } }));
  await delay(20);
  assert.equal(f.w.document.querySelector('.nsp-chat-peer-name').textContent, '九号联系人');
  assert.doesNotMatch(f.w.document.querySelector('.nsp-chat-thread').textContent, /不该显示的旧响应/);
});

test('Uncertain send failures preserve the draft, block duplicate sends and require a fresh record check', async t => {
  let sends = 0;
  const f = chatFixture(t, async pathname => {
    if (pathname.endsWith('/send')) { sends++; throw new Error('connection interrupted'); }
    return json({ success: true, msgArray: [], talkTo: { member_name: '联系人' } });
  });
  f.nsp.openChat(8, '联系人');
  await until(() => !f.w.document.querySelector('.nsp-chat-heading button:last-child').disabled);
  const input = writeMessage(f, '不能丢失的秘密草稿');
  const send = f.w.document.querySelector('.nsp-chat-send');
  send.click();
  await until(() => !f.w.document.querySelector('.nsp-chat-warning').hidden);
  assert.equal(input.value, '不能丢失的秘密草稿');
  assert.equal(send.disabled, true);
  input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  assert.equal(sends, 1);
  const unlock = [...f.w.document.querySelectorAll('.nsp-chat-warning button')].find(button => button.textContent.includes('解除防重'));
  assert.equal(unlock.disabled, true);
  f.w.document.querySelector('.nsp-chat-heading button:last-child').click();
  await until(() => !unlock.disabled);
  assert.doesNotMatch(JSON.stringify([...f.store.values()]), /不能丢失的秘密草稿/);
});

test('Definite send refusal preserves the draft and allows an intentional retry', async t => {
  const f = chatFixture(t, async pathname => pathname.endsWith('/send')
    ? json({ success: false, message: '内容未通过' }, 400)
    : json({ success: true, msgArray: [], talkTo: { member_name: '联系人' } }));
  f.nsp.openChat(8, '联系人');
  const input = writeMessage(f, '仍保留我的原文');
  const send = f.w.document.querySelector('.nsp-chat-send');
  await until(() => !send.disabled);
  send.click();
  await until(() => f.w.document.querySelector('.nsp-chat-thread-status').textContent.includes('发送被拒绝'));
  assert.equal(input.value, '仍保留我的原文');
  assert.equal(send.disabled, false);
});

test('A completed send in another conversation cannot erase the current draft', async t => {
  const pending = deferred();
  let sends = 0;
  const f = chatFixture(t, async pathname => {
    if (pathname.endsWith('/send')) { sends++; return pending.promise; }
    return json({ success: true, msgArray: [], talkTo: { member_name: pathname.endsWith('/9') ? '九号联系人' : '八号联系人' } });
  });
  f.nsp.openChat(8, '八号联系人');
  writeMessage(f, '给八号的消息');
  await until(() => !f.w.document.querySelector('.nsp-chat-send').disabled);
  f.w.document.querySelector('.nsp-chat-send').click();
  await until(() => sends === 1);
  f.nsp.openChat(9, '九号联系人');
  const input = writeMessage(f, '给九号的新草稿');
  pending.resolve(json({ success: true }));
  await delay(20);
  assert.equal(f.w.document.querySelector('.nsp-chat-peer-name').textContent, '九号联系人');
  assert.equal(input.value, '给九号的新草稿');
  assert.equal(f.w.document.querySelector('.nsp-chat-send').disabled, false);
});

test('A queued close event cannot tear down an immediately reopened chat session', async t => {
  const f = chatFixture(t, async () => json({ success: true, msgArray: [], talkTo: { member_name: '联系人' } }));
  f.nsp.openChat(8, '联系人');
  writeMessage(f, '关窗后应保留的草稿');
  f.w.document.querySelector('.nsp-chat-close').click();
  f.nsp.openChat(8, '联系人');
  await delay(20);
  assert.equal(f.w.document.querySelector('.nsp-chat').open, true);
  assert.equal(f.w.document.querySelector('.nsp-chat-input').value, '关窗后应保留的草稿');
  assert.equal(f.w.document.querySelector('.nsp-chat-send').disabled, false);
});

// Exercise the installed entry point and browser routes, rather than opening the
// panel through NSP.openChat, so a disconnected route cannot pass these tests.
function routeFixture(t, {
  hash = '#/message?mode=talk&to=8',
  html = userMarkup() + '<main id="nsk-body"><div id="native-router">原版通知页面</div></main>'
} = {}) {
  const requests = [];
  const notices = [];
  const f = fixture(t, {
    url: `https://www.nodeseek.com/notification${hash}`,
    files: ['30-messages.js', '90-main.js'], html,
    fetch: async (url, options) => {
      requests.push({ url: String(url), method: options.method });
      assert.equal(options.method, 'GET', 'route navigation must never send messages or sign in');
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/list')) return json({ success: true, msgArray: [] });
      const peer = Number(pathname.match(/\/with\/(\d+)$/)?.[1]);
      assert.ok(peer, `unexpected route request: ${pathname}`);
      return json({ success: true, msgArray: [message(peer, peer, `会话${peer}正文`)], talkTo: { member_name: `联系人${peer}` } });
    }
  });
  f.nsp.toast = text => notices.push(text);
  return { ...f, requests, notices };
}
const chatOpen = f => !!f.w.document.querySelector('.nsp-chat')?.open;
const currentPeer = f => f.w.document.querySelector('.nsp-chat-peer-name')?.textContent;

test('Opening a native private-message URL starts the chat panel for that conversation', async t => {
  const f = routeFixture(t);
  await until(() => chatOpen(f) && currentPeer(f) === '联系人8', 'direct private-message URLs must open the replacement panel');
  assert.match(f.w.document.querySelector('.nsp-chat-thread').textContent, /会话8正文/);
  assert.equal(f.w.document.querySelectorAll('.nsp-chat').length, 1);
});

test('Hash navigation, leaving the message route and browser history update the chat panel', async t => {
  const f = routeFixture(t, { hash: '#/atMe' });
  await until(() => f.w.document.querySelector('.nsp-chat'));
  assert.equal(chatOpen(f), false);
  f.w.location.hash = '#/message?mode=talk&to=8';
  await until(() => chatOpen(f) && currentPeer(f) === '联系人8');
  f.w.location.hash = '#/message?mode=talk&to=9';
  await until(() => currentPeer(f) === '联系人9');
  f.w.location.hash = '#/reply';
  await until(() => !chatOpen(f), 'leaving private messages closes a route-opened panel');
  f.w.history.back();
  await until(() => chatOpen(f) && currentPeer(f) === '联系人9', 'history traversal must restore the message conversation');
});

test('Vue-style pushState plus DOM rendering enters a private-message conversation', async t => {
  const f = routeFixture(t, { hash: '#/atMe' });
  await until(() => f.w.document.querySelector('.nsp-chat'));
  // Bypass the userscript's history wrapper, as a router in another JS realm can.
  f.originalPushState({}, '', '/notification#/message?mode=talk&to=11');
  const native = f.w.document.querySelector('#native-router');
  native.replaceChildren(f.w.document.createElement('section'));
  await until(() => chatOpen(f) && currentPeer(f) === '联系人11', 'SPA navigation must open chat even without an anchor click');
});

test('The native=1 route bypass remains native, including after DOM updates', async t => {
  const f = routeFixture(t, { hash: '#/message?mode=talk&to=8&native=1' });
  await until(() => f.w.document.querySelector('.nsp-chat'));
  f.w.document.querySelector('#native-router').append(f.w.document.createElement('section'));
  await delay(220);
  assert.equal(chatOpen(f), false);
  assert.equal(f.requests.length, 0);
  f.w.location.hash = '#/message?mode=talk&to=8';
  await until(() => chatOpen(f) && currentPeer(f) === '联系人8');
});

test('Malformed or ambiguous conversation IDs never trigger automatic requests', async t => {
  for (const query of ['to=0', 'to=-1', 'to=1e2', 'to=8.0', 'to=8&to=9', 'to=9007199254740992']) {
    const f = routeFixture(t, { hash: `#/message?mode=talk&${query}` });
    await until(() => f.w.document.querySelector('.nsp-chat'));
    await delay(10);
    assert.equal(chatOpen(f), false, query);
    assert.equal(f.requests.length, 0, query);
  }
});

test('An explicitly opened toolbar chat is not dismissed by unrelated page navigation', async t => {
  const f = routeFixture(t, { hash: '#/atMe' });
  await until(() => f.w.document.querySelector('.nsp-chat'));
  const launcher = [...f.w.document.querySelectorAll('.nsp-tools button')].find(button => button.textContent === '私信');
  launcher.click();
  await until(() => chatOpen(f));
  f.w.location.hash = '#/reply';
  await delay(20);
  assert.equal(chatOpen(f), true);
});

test('Manually closing a route-opened panel stays closed when unrelated DOM changes', async t => {
  const f = routeFixture(t);
  await until(() => chatOpen(f) && currentPeer(f) === '联系人8');
  f.w.document.querySelector('.nsp-chat-close').click();
  await until(() => !chatOpen(f));
  const count = f.requests.length;
  f.w.document.querySelector('#native-router').append(f.w.document.createElement('section'));
  await delay(220);
  assert.equal(chatOpen(f), false, 'a dismissed route must not reopen itself');
  assert.equal(f.requests.length, count);
  f.w.location.hash = '#/message?mode=talk&to=9';
  await until(() => chatOpen(f) && currentPeer(f) === '联系人9');
});

test('A message route waits quietly for delayed login data, then opens automatically', async t => {
  const f = routeFixture(t, { html: '<main id="nsk-body"><div id="native-router">等待账号资料</div></main>' });
  await until(() => f.w.document.querySelector('.nsp-chat'));
  for (let i = 0; i < 3; i++) {
    f.w.document.querySelector('#native-router').append(f.w.document.createElement('span'));
    await delay(60);
  }
  await delay(180);
  assert.equal(chatOpen(f), false);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.notices, [], 'no repeated login toasts while awaiting the account');
  const identity = f.w.document.createElement('script');
  identity.id = 'temp-script';
  identity.type = 'application/octet-stream';
  identity.textContent = Buffer.from(JSON.stringify({ user: { member_id: 7, member_name: '本机用户' } })).toString('base64');
  f.w.document.body.append(identity);
  await until(() => chatOpen(f) && currentPeer(f) === '联系人8', 'late login data should complete route initialization');
});

test('The installed entry point starts when the forum DOM appears after initial load', async t => {
  const f = routeFixture(t, { html: userMarkup() });
  await delay(20);
  assert.equal(f.w.document.querySelector('.nsp-chat'), null);
  const forum = f.w.document.createElement('main');
  forum.id = 'nsk-body';
  f.w.document.body.append(forum);
  await until(() => chatOpen(f) && currentPeer(f) === '联系人8', 'late forum markup must not leave the script permanently inactive');
});

test('The settings cache button preserves persistent values and invalidates late profile responses', async t => {
  const old = deferred();
  let calls = 0, oldSignal;
  const saved = new Map([
    ['nsp:v1:settings', { autoSign: false, profiles: true, chat: true }],
    ['nsp:v1:migration:random-sign-v012', true],
    ['nsp:v1:account:www.nodeseek.com:7:note:8', '保留备注'],
    ['nsp:v1:account:www.nodeseek.com:7:sign:done', '2026-11-02']
  ]);
  const f = fixture(t, { files: ['20-account.js'], store: saved, settings: { profiles: true }, fetch: async (url, options) => {
    calls++;
    if (calls === 1) { oldSignal = options.signal; return old.promise; }
    return json({ success: true, detail: completeProfile({ member_name: '新资料' }) });
  } });
  f.nsp.initUI(); f.nsp.modules.find(m => m.id === 'account').start();
  const pending = f.nsp.getProfile(8).catch(error => error.message);
  await until(() => calls === 1);
  const before = structuredClone([...saved]);
  f.nsp.openSettings();
  f.w.document.querySelector('.nsp-clear-cache').click();
  assert.equal(oldSignal.aborted, true);
  assert.deepEqual([...saved], before);
  assert.equal(f.w.document.querySelector('.nsp-settings').open, false);
  assert.equal((await f.nsp.getProfile(8)).member_name, '新资料');
  old.resolve(json({ success: true, detail: completeProfile({ member_name: '旧响应' }) }));
  assert.match(await pending, /清理/);
  assert.equal((await f.nsp.getProfile(8)).member_name, '新资料');
  assert.equal(calls, 2, 'a cancelled old request cannot refill or evict the new cache');
});

test('Clearing private caches closes the panel, preserves drafts and rejects late threads without new requests', async t => {
  const old = deferred();
  let reads = 0, signal;
  const f = chatFixture(t, async (pathname, options) => {
    reads++;
    assert.match(pathname, /\/with\/8$/);
    if (reads === 1) { signal = options.signal; return old.promise; }
    return json({ success: true, msgArray: [], talkTo: { member_name: '联系人8' } });
  });
  f.nsp.openChat(8, '联系人8');
  await until(() => reads === 1);
  writeMessage(f, '保留我的草稿');
  const saved = structuredClone([...f.store]);
  f.w.document.querySelector('.nsp-chat-clear-cache').click();
  assert.equal(signal.aborted, true);
  assert.equal(f.w.document.querySelector('.nsp-chat').open, false);
  assert.equal(f.w.document.querySelectorAll('.nsp-chat-message,.nsp-chat-contact').length, 0);
  old.resolve(json({ success: true, msgArray: [message(1, 8, '迟到消息不得恢复缓存')], talkTo: { member_name: '联系人8' } }));
  await delay(20);
  assert.equal(reads, 1, 'clearing must not fetch, send or mark messages read');
  assert.deepEqual([...f.store], saved);
  f.nsp.openChat(8);
  assert.equal(f.w.document.querySelector('.nsp-chat-input').value, '保留我的草稿');
  assert.doesNotMatch(f.w.document.querySelector('.nsp-chat-thread').textContent, /迟到消息/);
  await until(() => reads === 2);
});

test('Cache clearing cannot interrupt an in-flight send or erase an unresolved-send guard', async t => {
  const pending = deferred(); let sends = 0;
  const f = chatFixture(t, async pathname => {
    if (pathname.endsWith('/send')) { sends++; return pending.promise; }
    return json({ success: true, msgArray: [], talkTo: { member_name: '联系人8' } });
  });
  f.nsp.openChat(8);
  writeMessage(f, '发送结果待确认的草稿');
  const send = f.w.document.querySelector('.nsp-chat-send');
  await until(() => !send.disabled);
  send.click();
  await until(() => sends === 1);
  assert.equal(f.nsp.clearCaches(), false);
  assert.equal(f.w.document.querySelector('.nsp-chat').open, true);
  pending.reject(new Error('网络中断'));
  await until(() => !f.w.document.querySelector('.nsp-chat-warning').hidden);
  assert.equal(f.nsp.clearCaches(), true);
  f.nsp.openChat(8);
  await until(() => !f.w.document.querySelector('.nsp-chat-heading button:last-child').disabled);
  assert.equal(f.w.document.querySelector('.nsp-chat-input').value, '发送结果待确认的草稿');
  assert.equal(send.disabled, true);
  send.click();
  assert.equal(sends, 1);
});

test('Conversation history keeps the newest 200 messages and marks only retained visible messages read', async t => {
  const marked = []; let tail = 500;
  const f = chatFixture(t, async (pathname, options) => {
    if (pathname.endsWith('/markViewed')) { marked.push(JSON.parse(options.body).messages); return json({ success: true }); }
    return json({ success: true, msgArray: Array.from({ length: tail }, (_, i) => message(i + 1, 8, `消息${i + 1}`, { viewed: false })), talkTo: { member_name: '联系人8' } });
  });
  f.nsp.openChat(8);
  await until(() => marked.length === 1 && !f.w.document.querySelector('.nsp-chat-heading button:last-child').disabled);
  assert.equal(f.w.document.querySelectorAll('.nsp-chat-message').length, 200);
  assert.equal(f.w.document.querySelector('.nsp-chat-bubble').textContent, '消息301');
  assert.deepEqual(marked[0], Array.from({ length: 200 }, (_, i) => i + 301));
  tail = 501;
  f.w.document.querySelector('.nsp-chat-heading button:last-child').click();
  await until(() => marked.length === 2);
  assert.equal(f.w.document.querySelectorAll('.nsp-chat-message').length, 200);
  assert.equal(f.w.document.querySelector('.nsp-chat-bubble').textContent, '消息302');
  assert.equal(f.w.document.querySelectorAll('.nsp-chat-bubble')[199].textContent, '消息501');
});

async function visitCachedPeers(f, count, rows) {
  for (let i = 0; i < count; i++) {
    f.nsp.openChat(100 + i);
    await until(() => f.w.document.querySelectorAll('.nsp-chat-message').length === rows && !f.w.document.querySelector('.nsp-chat-heading button:last-child').disabled);
  }
}

test('Private caches evict old conversations at both the total-message and conversation limits', async t => {
  for (const [count, rows] of [[7, 200], [22, 1]]) {
    let stalled = false;
    const never = deferred();
    const f = chatFixture(t, async pathname => {
      if (stalled) return never.promise;
      const peer = Number(pathname.split('/').pop());
      return json({ success: true, msgArray: Array.from({ length: rows }, (_, i) => message(i + 1, peer, `会话${peer}消息${i}`)), talkTo: { member_name: `联系人${peer}` } });
    });
    await visitCachedPeers(f, count, rows);
    stalled = true;
    f.nsp.openChat(100);
    assert.equal(f.w.document.querySelectorAll('.nsp-chat-message').length, 0, 'the oldest conversation must be evicted');
    f.nsp.openChat(100 + count - 1);
    assert.equal(f.w.document.querySelectorAll('.nsp-chat-message').length, rows, 'the recently used conversation remains cached');
    f.nsp.clearCaches();
    never.resolve(json({ success: true, msgArray: [], talkTo: { member_name: '迟到响应' } }));
  }
});

test('The contact list has a fixed cap and cannot fetch unbounded older pages', async t => {
  let lists = 0;
  const f = fixture(t, { files: ['30-messages.js'], settings: { chat: true }, fetch: async url => {
    assert.match(new URL(url).pathname, /\/list$/);
    lists++;
    return json({ success: true, msgArray: Array.from({ length: 250 }, (_, i) => message(i + 1, i + 100, '摘'.repeat(5000))) });
  } });
  f.nsp.initUI(); f.nsp.modules.find(m => m.id === 'messages').start(); f.nsp.openChat();
  await until(() => f.w.document.querySelectorAll('.nsp-chat-contact').length === 200);
  assert.equal(f.w.document.querySelector('.nsp-chat-contact .nsp-chat-preview').textContent.length, 300);
  const more = f.w.document.querySelector('.nsp-chat-more');
  assert.equal(more.disabled, true);
  assert.match(more.textContent, /200/);
  more.click();
  await delay(10);
  assert.equal(lists, 1);
});
