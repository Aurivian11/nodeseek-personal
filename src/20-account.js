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
    let activeRequests = 0;
    function pump() {
      while (activeRequests < 2 && queue.length) {
        const job = queue.shift();
        activeRequests++;
        (async () => {
          try {
            const data = await NSP.api(`/api/account/getInfo/${job.id}`);
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
            pending.delete(job.id);
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
      const job = { id, priority, promise, resolve, reject };
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
