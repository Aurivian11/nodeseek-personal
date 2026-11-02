'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let csrf = '', authenticated = false, state = null, configDirty = false;
  let sessionVersion = 0, stateRequest = 0, stateBusy = false, stateTimer = null;
  let toastTimer = null, frameTimer = null, frameController = null, frameURL = '';
  let browserGeneration = 0, inputQueue = Promise.resolve(), scrollTimer = null, scrollAmount = 0;
  let testUnknown = false, stateOnline = false, countdownTimer = null;
  const dialog = $('browserDialog');
  const browserOpenLabel = $('openBrowserButton').textContent;
  const manualDesktopNotice = '普通 Chrome 已安装，请手动登录；通知监控尚未连接此浏览器';
  const phaseNames = {
    idle:'等待开始', paused:'已暂停', running:'监控中', monitoring:'监控中', checking:'检查中',
    disconnected:'浏览器未连接', starting:'启动中', ready:'浏览器已打开', verification_required:'安全验证未通过', logged_in:'已登录', login_submitted:'登录已提交', need_login:'需要登录', login_required:'需要登录',
    unknown:'结果待核对', uncertain:'结果待核对', paused_unknown:'结果待核对',
    schema_invalid:'站点数据结构异常', backoff:'等待重试', rate_limited:'限流等待', error:'需要处理', stopped:'已停止'
  };
  const typeNames = {message:'私信', at:'@我', reply:'回复主题', test:'连接测试', system:'系统'};
  const statusNames = {sent:'已发送', pending:'待处理', unknown:'待核对', failed:'失败', rejected:'未发送', skipped:'已跳过', rate_limited:'限流等待', error:'失败'};
  function safeText(value, limit = 300) {
    if (typeof value !== 'string') return '';
    return value.replace(/\b(?:bot)?[1-9]\d{5,15}:[A-Za-z0-9_-]{20,100}/g, '[凭据已隐藏]').slice(0, limit);
  }
  function setText(id, value) { $(id).textContent = String(value == null ? '' : value); }
  function badge(id, label, tone) { const node = $(id); node.textContent = label; node.className = 'status-badge ' + tone; }
  function enable(id, allowed) { $(id).disabled = Boolean($(id).dataset.busy) || !allowed; }
  function toast(message, kind = '') {
    const node = $('toast');
    const host = dialog.open ? dialog : document.body;
    if (node.parentElement !== host) host.append(node);
    node.textContent = safeText(message);
    node.className = 'toast' + (kind ? ' ' + kind : '');
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 6500);
  }
  async function api(path, options = {}) {
    if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('请求地址无效');
    if (state?.manualDesktop === true) {
      if (/^\/api\/browser\/(open|login|input|check)$/.test(path)) throw new Error('请通过“打开普通 Chrome”进入服务器远程桌面。');
      if (state.bridgeEnabled !== true && /^\/api\/monitor\/(start|check|resume)$/.test(path)) throw new Error(manualDesktopNotice);
    }
    if (/^\/api\/monitor\/(start|check|resume)$/.test(path) && !stateOnline) throw new Error('服务器状态尚未确认，请等待重新连接后再试。');
    const requestSession = sessionVersion;
    const method = options.method || 'GET';
    const headers = {Accept:'application/json'};
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (path !== '/api/login') {
        if (!csrf) throw new Error('登录状态已失效，请重新登录');
        headers['X-CSRF-Token'] = csrf;
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 25000);
    try {
      const response = await fetch(path, {
        method, headers, credentials:'same-origin', cache:'no-store', redirect:'error',
        signal:controller.signal,
        ...(options.body !== undefined ? {body:JSON.stringify(options.body)} : {})
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && path !== '/api/login') {
        if (requestSession === sessionVersion) showLogin('登录已过期，请重新登录');
        throw new Error('登录已过期，请重新登录');
      }
      if (!response.ok) {
        let failure = typeof (data.error || data.message) === 'string' ? (data.error || data.message) : '请求未完成（' + response.status + '）';
        for (const key of ['password','token']) {
          const secret = options.body?.[key];
          if (typeof secret === 'string' && secret) failure = failure.split(secret).join('[已隐藏]');
        }
        throw new Error(safeText(failure));
      }
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('请求超时，结果尚未确认；请先检查状态，再决定是否重试。');
      if (error instanceof TypeError) throw new Error('网络连接失败，请检查服务状态。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function post(path, body = {}, timeout) { return api(path, {method:'POST', body, timeout}); }
  async function busy(button, operation) {
    if (button.dataset.busy) return;
    button.dataset.busy = '1'; button.disabled = true; button.setAttribute('aria-busy','true');
    try { return await operation(); }
    catch (error) { toast(error.message || '操作未完成，请稍后再试', 'error'); return null; }
    finally {
      delete button.dataset.busy; button.removeAttribute('aria-busy'); button.disabled = false;
      if (state && authenticated) renderState();
    }
  }
  function clearSecrets() {
    for (const id of ['adminPassword','botToken','forumPassword','remoteText']) $(id).value = '';
  }
  function showLogin(message = '') {
    authenticated = false; csrf = ''; state = null; configDirty = false; stateOnline = false;
    sessionVersion++; stateRequest++; stateBusy = false;
    clearInterval(stateTimer); stateTimer = null;
    clearInterval(countdownTimer); countdownTimer = null;
    closeBrowser(); clearSecrets();
    $('forumUsername').value = ''; $('chatId').value = ''; $('logsBody').replaceChildren();
    $('loadingView').hidden = true; $('appView').hidden = true; $('loginView').hidden = false;
    $('loginError').hidden = !message; setText('loginError', safeText(message));
  }
  async function showApp(token) {
    csrf = token; authenticated = true; sessionVersion++; stateRequest++; stateBusy = false; stateOnline = false;
    for (const id of ['startButton','checkButton','resumeButton']) enable(id, false);
    $('loadingView').hidden = true; $('loginView').hidden = true; $('appView').hidden = false;
    $('loginError').hidden = true; clearSecrets();
    clearInterval(stateTimer);
    stateTimer = setInterval(() => { if (authenticated) void refreshState(); }, 10000);
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => { if (authenticated && !document.hidden) renderNextCheck(); }, 1000);
    await refreshState(true);
  }
  function timestamp(value) {
    if (!value) return NaN;
    if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
    return Date.parse(value);
  }
  function timeText(value) {
    const time = timestamp(value);
    if (!Number.isFinite(time)) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
    }).format(time);
  }
  function count(value) { return Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)).toLocaleString('zh-CN') : '0'; }
  function renderLogs() {
    const logs = Array.isArray(state?.logs) ? state.logs : [];
    const filter = $('logFilter').value;
    const rows = logs.filter(row => filter === 'all' || (filter === 'sent' ? row.status === 'sent' : ['unknown','failed','rejected','error','rate_limited'].includes(row.status))).slice(0, 50);
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const tr = document.createElement('tr');
      const date = document.createElement('td'); date.textContent = timeText(row.time);
      const type = document.createElement('td'); type.textContent = typeNames[row.type] || safeText(row.type, 20) || '通知';
      const result = document.createElement('td'); const status = document.createElement('span');
      status.className = 'status-badge ' + (row.status === 'sent' ? 'good' : ['unknown','pending','rate_limited'].includes(row.status) ? 'warn' : ['failed','rejected','error'].includes(row.status) ? 'bad' : 'neutral');
      status.textContent = statusNames[row.status] || safeText(row.status, 25) || '记录';
      result.append(status);
      const note = document.createElement('td'); note.textContent = safeText(row.note, 500) || '—';
      tr.append(date, type, result, note); fragment.append(tr);
    }
    $('logsBody').replaceChildren(fragment);
    $('logsEmpty').hidden = rows.length > 0;
    setText('logsCount', rows.length ? '最近 ' + rows.length + ' 条' : '');
  }
  function monitorDesired() {
    if (typeof state?.monitorDesired === 'boolean') return state.monitorDesired;
    if (typeof state?.recovery?.desired === 'boolean') return state.recovery.desired;
    return state?.running === true;
  }
  function renderNextCheck() {
    if (!state || !authenticated) return;
    const recovery = state.recovery || {};
    let label;
    if (!stateOnline) label = '等待重新连接';
    else if (state.manualDesktop === true && state.bridgeEnabled !== true) label = '尚未连接';
    else if (recovery.state === 'blocked') label = '等待处理';
    else if (monitorDesired() && ['waiting_connection','waiting_login','retrying'].includes(recovery.state)) {
      const retryAt = timestamp(recovery.nextRetryAt);
      const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      label = Number.isFinite(seconds) && seconds > 0 ? seconds + ' 秒后重试' : recovery.state === 'waiting_connection' ? '等待浏览器连接' : recovery.state === 'waiting_login' ? '等待登录恢复' : '正在尝试恢复';
    } else if (state.bridgeEnabled === true && state.browser?.connected !== true) label = '等待浏览器连接';
    else label = state.nextCheck ? timeText(state.nextCheck) : '等待安排';
    setText('nextCheck', label);
  }
  function renderState() {
    if (!state || !authenticated) return;
    const manual = state.manualDesktop === true;
    const bridge = state.bridgeEnabled === true;
    const legacyManual = manual && !bridge;
    const browser = state.browser || {};
    const connected = !bridge || (browser.connected === true && browser.phase !== 'disconnected');
    const account = legacyManual || (bridge && (!connected || browser.phase !== 'logged_in')) ? null : state.account;
    const running = !legacyManual && state.running === true;
    const desired = !legacyManual && monitorDesired();
    const pauseRequested = monitorDesired() || state.running === true;
    const recovery = state.recovery || {};
    const blocked = recovery.state === 'blocked';
    const recovering = desired && (!running || ['waiting_connection','waiting_login','retrying'].includes(recovery.state));
    const recoveryReason = safeText(recovery.reason, 300);
    const configured = state.telegram?.configured === true;
    let bridgeNotice = '', bridgeLabel = '';
    if (bridge && !connected) {
      bridgeNotice = '浏览器未连接，请在服务器 Chrome 打开 NodeSeek。';
      bridgeLabel = '浏览器未连接';
    } else if (bridge && browser.phase === 'verification_required') {
      bridgeNotice = 'NodeSeek 需要安全验证，请在普通 Chrome 中手工完成，完成后会自动更新状态。';
      bridgeLabel = '需要安全验证';
    } else if (bridge && !account) {
      const confirming = browser.phase === 'logged_in';
      bridgeNotice = confirming ? '浏览器已连接，正在确认 NodeSeek 登录状态。' : '请在服务器 Chrome 登录 NodeSeek，登录后会自动更新状态。';
      bridgeLabel = confirming ? '正在确认登录' : '需要登录';
    }
    if (manual && (dialog.open || frameTimer || frameController)) closeBrowser();
    setText('openBrowserButton', manual ? '打开普通 Chrome' : browserOpenLabel);
    const phase = typeof state.phase === 'string' ? state.phase : '';
    const unknown = Number(state.counts?.unknown) > 0 || /unknown|uncertain/.test(phase);
    setText('versionLabel', state.version ? 'v' + state.version : '');
    let title, label, description, tone = 'neutral';
    if (!stateOnline) {
      title = '暂时无法连接服务器'; label = '状态待更新'; tone = 'warn';
      description = '页面正在自动重新获取状态。服务器任务不会因页面断线停止，仍可尝试暂停监控。';
    } else if (legacyManual) {
      title = '普通 Chrome 已就绪'; label = '监控尚未连接'; description = manualDesktopNotice;
    } else if (unknown) {
      title = '有一条推送需要核对'; label = '结果待核对'; tone = 'warn';
      description = '请先在 Telegram 核对结果，恢复时跳过未确认的那条通知。' + (recoveryReason ? ' ' + recoveryReason : '');
    } else if (blocked) {
      title = '监控已暂停，需要处理'; label = '需要处理'; tone = 'bad';
      description = (recoveryReason || '自动恢复已停止。') + ' 处理原因后，可明确重新开始监控。';
    } else if (recovering) {
      const waiting = {waiting_connection:'等待浏览器重新连接',waiting_login:'等待登录恢复',retrying:'等待自动重试'};
      title = waiting[recovery.state] || '等待自动恢复'; label = '自动恢复中'; tone = 'warn';
      description = (recoveryReason || bridgeNotice || '服务器将尝试恢复监控。') + ' 可点击“暂停监控”取消自动恢复。';
    } else {
      title = bridgeNotice ? bridgeLabel : running ? '正在守候新的通知' : state.canStart ? '一切就绪，随时开始' : '完成连接后开始监控';
      label = bridgeNotice ? bridgeLabel : phaseNames[phase] || safeText(phase, 32) || (running ? '运行中' : '已暂停');
      tone = bridgeNotice ? 'warn' : running ? 'good' : 'neutral';
      description = bridgeNotice || (running ? bridge ? '请保持服务器 Chrome 中的 NodeSeek 页面打开；关闭当前后台页面不会停止监控。' : '任务在服务器继续运行，不依赖当前页面保持打开。' : !account ? '先登录 NodeSeek，再配置 Telegram 推送。' : !configured ? '论坛账号已连接，填写 Telegram 配置后即可开始。' : bridge ? '开始监控后，将建立通知基线并持续检查新通知。' : '可以手动检查一次，或开启持续监控。');
    }
    setText('monitorTitle', title);
    badge('phaseBadge', label, tone);
    $('monitorBeacon').className = 'monitor-beacon ' + (tone === 'good' ? 'running' : tone === 'warn' || tone === 'bad' ? 'warning' : 'idle');
    setText('monitorDescription', description);
    setText('lastCheck', timeText(state.lastCheck));
    renderNextCheck();
    $('monitorError').hidden = legacyManual || !state.lastError || !stateOnline;
    setText('monitorError', legacyManual ? '' : safeText(state.lastError));
    $('startButton').hidden = desired || running;
    $('pauseButton').hidden = !pauseRequested;
    $('resumeButton').hidden = !unknown;
    setText('startButton', blocked ? '重新开始监控' : '开始监控');
    enable('startButton', stateOnline && !legacyManual && !desired && state.canStart === true && !running && !unknown);
    enable('pauseButton', pauseRequested);
    enable('checkButton', stateOnline && !legacyManual && !blocked && !recovering && (!bridge || running) && connected && Boolean(account) && configured && !unknown);
    enable('resumeButton', stateOnline && !legacyManual && unknown);
    for (const key of ['Sent','Pending','Unknown','Failed']) setText('count' + key, count(state.counts?.[key.toLowerCase()]));
    setText('accountName', legacyManual ? '请在普通 Chrome 中手动登录' : account ? safeText(account.name, 70) || '已登录账号' : bridgeLabel || '尚未连接 NodeSeek');
    setText('accountDetail', legacyManual ? '此控制台尚未读取普通 Chrome 的登录状态' : account ? 'UID ' + account.id + (bridge ? ' · 普通 Chrome 桥接已连接' : ' · 登录会话保存在服务器') : bridgeNotice || '通过服务器浏览器登录你的账号');
    setText('accountMonogram', account?.name ? Array.from(String(account.name))[0] : 'N');
    badge('accountBadge', legacyManual ? '未确认登录' : account ? '已登录' : bridgeLabel || '未登录', account ? 'good' : bridge && browser.phase === 'verification_required' ? 'warn' : 'neutral');
    setText('browserStatus', legacyManual ? manualDesktopNotice : bridge ? bridgeNotice || '普通 Chrome 桥接已连接，请保持 NodeSeek 页面打开。' : browser.running ? '浏览器已运行' + (browser.phase ? ' · ' + (phaseNames[browser.phase] || safeText(browser.phase, 35)) : '') : '服务器浏览器尚未启动');
    const notice = document.querySelector('.browser-notice');
    if (notice) notice.textContent = legacyManual ? manualDesktopNotice : bridge ? bridgeNotice || '普通 Chrome 已连接通知监控，请保持 NodeSeek 页面打开。' : browser.phase === 'verification_required' ? 'NodeSeek 安全验证尚未通过，目前无法登录或获取通知。Cloudflare 不支持这类自动化浏览器；如果一直转圈，反复刷新通常无效。' : '如出现验证码，请在远程画面中手工处理。能否通过取决于网站验证，无法保证自动登录；关闭此窗口会保留服务器会话。';
    badge('telegramBadge', configured ? '已配置' : '待配置', configured ? 'good' : 'neutral');
    setText('tokenState', $('botToken').value ? '保存后替换' : configured ? '已安全保存' : '尚未设置');
    $('botToken').placeholder = configured ? '已配置，留空保留现有 Token' : '输入 BotFather 提供的 Token';
    enable('testTelegramButton', configured && !configDirty && stateOnline && !desired && !running);
    if (!configDirty) {
      $('chatId').value = state.telegram?.chatId == null ? '' : String(state.telegram.chatId);
      $('typeMessage').checked = state.types?.message !== false;
      $('typeAt').checked = state.types?.at !== false;
      $('typeReply').checked = state.types?.reply !== false;
      $('includeSummary').checked = state.includeSummary !== false;
    }
    renderLogs();
  }
  async function refreshState(notify = false) {
    if (!authenticated || stateBusy) return;
    stateBusy = true;
    const requestId = ++stateRequest, version = sessionVersion;
    try {
      const next = await api('/api/state');
      if (!authenticated || version !== sessionVersion || requestId !== stateRequest) return;
      state = next; stateOnline = true; $('connectionStatus').classList.remove('offline');
      $('connectionStatus').lastChild.textContent = '服务器已连接';
      renderState();
    } catch (error) {
      if (!authenticated || version !== sessionVersion || requestId !== stateRequest) return;
      stateOnline = false;
      $('connectionStatus').classList.add('offline');
      $('connectionStatus').lastChild.textContent = '连接暂时中断';
      if (state) renderState();
      if (notify && authenticated) toast(error.message, 'error');
    } finally { if (requestId === stateRequest) stateBusy = false; }
  }
  $('adminLogin').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('loginButton');
    if (button.dataset.busy) return;
    button.dataset.busy = '1'; button.disabled = true;
    $('loginError').hidden = true;
    const payload = {password:$('adminPassword').value};
    try {
      const result = await post('/api/login', payload);
      if (typeof result.csrf !== 'string' || !result.csrf) throw new Error('未能建立安全会话，请刷新后重试');
      await showApp(result.csrf);
    } catch (error) {
      setText('loginError', safeText(error.message) || '登录失败，请检查管理密码');
      $('loginError').hidden = false;
    } finally {
      payload.password = ''; $('adminPassword').value = '';
      delete button.dataset.busy; button.disabled = false;
    }
  });
  $('logoutButton').addEventListener('click', () => busy($('logoutButton'), async () => {
    await post('/api/logout'); showLogin();
  }));
  function markDirty() {
    configDirty = true; setText('configSaveStatus', '有未保存的修改');
    setText('tokenState', $('botToken').value ? '保存后替换' : state?.telegram?.configured ? '已安全保存' : '尚未设置');
    enable('testTelegramButton', false);
  }
  $('configForm').addEventListener('input', markDirty);
  $('configForm').addEventListener('change', markDirty);
  $('configForm').addEventListener('submit', event => {
    event.preventDefault();
    void busy($('saveConfigButton'), async () => {
      const payload = {
        token:$('botToken').value.trim(), chatId:$('chatId').value.trim(),
        types:{message:$('typeMessage').checked, at:$('typeAt').checked, reply:$('typeReply').checked},
        includeSummary:$('includeSummary').checked
      };
      try {
        if (!/^[1-9]\d*$/.test(payload.chatId) || !Number.isSafeInteger(Number(payload.chatId))) throw new Error('请填写正整数私人 Chat ID');
        if (!Object.values(payload.types).some(Boolean)) throw new Error('请至少选择一类通知');
        await post('/api/config', payload);
        configDirty = false; testUnknown = false;
        setText('configSaveStatus', '已保存'); toast('配置已保存');
        await refreshState();
      } finally { payload.token = ''; $('botToken').value = ''; }
    });
  });
  // UI chunk: configuration forms complete.
  $('testTelegramButton').addEventListener('click', () => busy($('testTelegramButton'), async () => {
    if (configDirty) throw new Error('请先保存配置，再发送测试消息');
    if (testUnknown && !window.confirm('上次测试结果未确认，请先在 Telegram 核对。仍要再次发送测试消息吗？')) return;
    const result = await post('/api/telegram/test');
    testUnknown = result.status === 'unknown';
    if (testUnknown) toast('测试结果未确认，请先在 Telegram 核对，不要立即重复发送。', 'warning');
    else if (result.status && result.status !== 'sent') toast(safeText(result.message) || '测试未确认送达，请检查配置与服务状态。', 'warning');
    else toast('测试消息请求已处理，请到 Telegram 确认。');
    await refreshState();
  }));
  for (const [id, path, message] of [
    ['startButton','/api/monitor/start','服务器监控已开始'],
    ['pauseButton','/api/monitor/pause','服务器监控已暂停'],
    ['checkButton','/api/monitor/check','已请求立即检查']
  ]) $(id).addEventListener('click', () => busy($(id), async () => {
    await post(path); toast(message); await refreshState();
  }));
  $('resumeButton').addEventListener('click', () => busy($('resumeButton'), async () => {
    if (state?.manualDesktop === true && state.bridgeEnabled !== true) throw new Error(manualDesktopNotice);
    if (!window.confirm('请先在 Telegram 核对上一条推送。恢复时将跳过结果未确认的那一条，避免重复发送。确认恢复吗？')) return;
    await post('/api/monitor/resume', {skipUnknown:true});
    toast('已请求恢复推送'); await refreshState();
  }));
  $('logFilter').addEventListener('change', renderLogs);
  function clearFrame() {
    frameController?.abort(); frameController = null;
    if (frameURL) URL.revokeObjectURL(frameURL);
    frameURL = ''; $('browserFrame').removeAttribute('src');
    $('browserFrame').hidden = true; $('framePlaceholder').hidden = false;
  }
  function closeBrowser() {
    browserGeneration++; clearInterval(frameTimer); frameTimer = null;
    clearTimeout(scrollTimer); scrollTimer = null; scrollAmount = 0;
    clearFrame();
    $('forumPassword').value = ''; $('remoteText').value = '';
    if (dialog.open) dialog.close();
    if ($('toast').parentElement === dialog) document.body.append($('toast'));
  }
  // UI chunk: monitor actions complete.
  async function refreshFrame() {
    if (!authenticated || state?.manualDesktop === true || !dialog.open || frameController || document.hidden) return;
    const generation = browserGeneration;
    const controller = new AbortController(); frameController = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('/api/browser/frame', {
        credentials:'same-origin', cache:'no-store', redirect:'error', signal:controller.signal
      });
      if (response.status === 401) { showLogin('登录已过期，请重新登录'); return; }
      if (!response.ok || !(response.headers.get('Content-Type') || '').startsWith('image/')) throw new Error('暂时没有可用画面');
      const blob = await response.blob();
      if (!dialog.open || generation !== browserGeneration) return;
      const nextURL = URL.createObjectURL(blob), previous = frameURL;
      frameURL = nextURL; $('browserFrame').src = nextURL;
      $('browserFrame').hidden = false; $('framePlaceholder').hidden = true;
      if (previous) URL.revokeObjectURL(previous);
      setText('frameStatus', '画面已更新 · ' + timeText(Date.now()));
    } catch (error) {
      if (dialog.open && generation === browserGeneration) setText('frameStatus', controller.signal.aborted ? '画面请求超时，稍后重新获取' : '画面暂不可用，请检查浏览器状态');
    } finally {
      clearTimeout(timeout);
      if (frameController === controller) frameController = null;
    }
  }
  $('openBrowserButton').addEventListener('click', () => busy($('openBrowserButton'), async () => {
    if (state?.manualDesktop === true) { closeBrowser(); location.assign('/desktop'); return; }
    closeBrowser();
    const generation = browserGeneration;
    setText('frameStatus','正在启动服务器浏览器…');
    setText('browserCheckStatus','完成验证码后，点击检查登录状态。');
    dialog.showModal();
    try {
      await post('/api/browser/open', {}, 45000);
      if (!dialog.open || generation !== browserGeneration) return;
      frameTimer = setInterval(() => { void refreshFrame(); }, 2000);
      await refreshFrame(); await refreshState();
    } catch (error) {
      setText('frameStatus','浏览器尚未就绪，请检查服务状态后重试');
      throw error;
    }
  }));
  $('closeBrowserButton').addEventListener('click', closeBrowser);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeBrowser(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    clearInterval(frameTimer); frameTimer = null;
    clearFrame(); $('forumPassword').value = ''; $('remoteText').value = '';
  });
  $('refreshFrameButton').addEventListener('click', () => { void refreshFrame(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && authenticated) { void refreshState(); void refreshFrame(); }
  });
  // UI chunk: browser frames complete.
  function sendInput(payload) {
    const generation = browserGeneration;
    const data = {...payload};
    const task = inputQueue.catch(() => {}).then(async () => {
      if (!authenticated || !dialog.open || generation !== browserGeneration) return;
      await post('/api/browser/input', data);
      if (dialog.open && generation === browserGeneration) void refreshFrame();
    }).finally(() => { if (Object.hasOwn(data, 'text')) data.text = ''; });
    inputQueue = task.catch(() => {});
    return task;
  }
  function remoteAction(payload) {
    void sendInput(payload).catch(error => toast(error.message, 'error'));
  }
  $('browserFrame').addEventListener('click', event => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.max(0, Math.min(1099, Math.round((event.clientX - rect.left) * 1100 / rect.width)));
    const y = Math.max(0, Math.min(759, Math.round((event.clientY - rect.top) * 760 / rect.height)));
    event.currentTarget.focus({preventScroll:true});
    remoteAction({type:'click', x, y});
  });
  const remoteKeys = new Set(['Enter','Tab','Backspace','Delete','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown']);
  $('browserFrame').addEventListener('keydown', event => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (remoteKeys.has(event.key)) {
      event.preventDefault(); event.stopPropagation();
      remoteAction({type:'key', key:event.key});
    } else if (event.key.length === 1) {
      event.preventDefault(); remoteAction({type:'text', text:event.key});
    }
  });
  $('browserFrame').addEventListener('wheel', event => {
    event.preventDefault();
    scrollAmount += event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? 500 : 1);
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      const deltaY = Math.max(-900, Math.min(900, Math.round(scrollAmount)));
      scrollAmount = 0;
      if (deltaY) remoteAction({type:'scroll', deltaY});
    }, 120);
  }, {passive:false});
  document.querySelectorAll('[data-remote-key]').forEach(button => {
    button.addEventListener('click', () => remoteAction({type:'key', key:button.dataset.remoteKey}));
  });
  $('remoteTextForm').addEventListener('submit', event => {
    event.preventDefault();
    void busy($('remoteTextButton'), async () => {
      const payload = {type:'text', text:$('remoteText').value};
      if (!payload.text) return;
      $('remoteText').value = '';
      try { await sendInput(payload); }
      finally { payload.text = ''; }
    });
  });
  // UI chunk: browser input complete.
  $('forumLogin').addEventListener('submit', event => {
    event.preventDefault();
    void busy($('forumLoginButton'), async () => {
      const payload = {username:$('forumUsername').value.trim(), password:$('forumPassword').value};
      try {
        if (!payload.username || !payload.password) throw new Error('请填写论坛用户名与密码');
        await post('/api/browser/login', payload, 45000);
        setText('browserCheckStatus','已提交登录，请在画面中手工完成验证码，再检查登录状态。');
        toast('已提交登录，请留意远程画面中的验证码。');
        await refreshFrame(); await refreshState();
      } finally {
        payload.password = ''; payload.username = ''; $('forumPassword').value = '';
      }
    });
  });
  $('checkLoginButton').addEventListener('click', () => busy($('checkLoginButton'), async () => {
    const result = await post('/api/browser/check');
    const account = result.account || (result.id ? result : null);
    const message = account ? '已确认登录：' + (safeText(account.name, 60) || 'UID ' + account.id) : '尚未确认登录，请完成登录或验证码后再试。';
    setText('browserCheckStatus', message);
    toast(message, account ? '' : 'warning');
    await refreshState(); await refreshFrame();
  }));
  window.addEventListener('pagehide', () => {
    clearInterval(stateTimer); clearInterval(frameTimer); clearInterval(countdownTimer); clearTimeout(scrollTimer);
    frameController?.abort();
    clearSecrets();
    if (frameURL) URL.revokeObjectURL(frameURL);
    frameURL = '';
  });
  window.addEventListener('pageshow', event => { if (event.persisted) void initialize(); });
  async function initialize() {
    closeBrowser();
    try {
      const session = await api('/api/session');
      if (session.authenticated && typeof session.csrf === 'string' && session.csrf) await showApp(session.csrf);
      else showLogin();
    } catch {
      showLogin('暂时无法连接服务器，请检查连接后重试。');
    }
  }
  void initialize();
})();
// UI chunk: application complete.
