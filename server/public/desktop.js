import RFB from '/desktop-assets/core/rfb.js';

const el = id => document.getElementById(id);
const surface = el('rfbSurface');
const workspace = el('desktopWorkspace');
let client = null;
let connected = false;
let connecting = false;
let checkingSession = true;
let redirecting = false;
let generation = 0;
let connectionTimeout = null;
let sessionTimer = null;
let sessionRequest = null;

function status(message, tone = 'idle') {
  el('connectionStatus').textContent = message;
  el('statusDot').className = 'status-dot ' + tone;
}
function placeholder(title, description, visible = true) {
  el('placeholderTitle').textContent = title;
  el('placeholderDescription').textContent = description;
  el('desktopPlaceholder').hidden = !visible;
}
function buttons() {
  el('connectButton').disabled = connecting || connected || checkingSession || redirecting;
  el('connectButton').textContent = connecting ? '正在连接…' : '连接桌面';
  el('disconnectButton').disabled = !client;
  el('fullscreenButton').disabled = !connected || typeof workspace.requestFullscreen !== 'function';
}
function stopConnection(message = '已断开，服务器 Chrome 继续运行', tone = 'idle') {
  generation++;
  clearTimeout(connectionTimeout); connectionTimeout = null;
  const previous = client;
  client = null; connected = false; connecting = false;
  try { previous?.disconnect(); } catch { /* No connection data is logged. */ }
  surface.replaceChildren();
  placeholder('远程连接已断开', '需要继续操作时，请再次点击「连接桌面」。');
  status(message, tone);
  buttons();
}
function returnToLogin() {
  redirecting = true;
  stopConnection('管理登录已失效，正在返回后台', 'error');
  window.location.replace('/');
}
async function readSession() {
  const controller = new AbortController();
  sessionRequest?.abort(); sessionRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/api/session', {
      method:'GET', credentials:'same-origin', cache:'no-store',
      redirect:'error', signal:controller.signal, headers:{Accept:'application/json'}
    });
    if (response.status === 401 || response.status === 403) {
      returnToLogin(); return false;
    }
    if (!response.ok) throw new Error('session-unavailable');
    const result = await response.json();
    if (result.authenticated !== true) { returnToLogin(); return false; }
    return true;
  } finally {
    clearTimeout(timeout);
    if (sessionRequest === controller) sessionRequest = null;
  }
}
async function connectDesktop() {
  if (client || connecting || checkingSession || redirecting) return;
  checkingSession = true;
  status('正在确认管理登录状态…', 'connecting');
  buttons();
  const ticket = ++generation;
  try {
    if (!await readSession() || ticket !== generation || redirecting) return;
    startSessionChecks();
    checkingSession = false; connecting = true;
    status('正在连接服务器桌面…', 'connecting');
    placeholder('正在连接远程桌面', '连接建立后，可直接操作服务器上的普通 Chrome。');
    buttons();
    const url = 'wss://' + window.location.host + '/api/desktop/socket';
    const rfb = new RFB(surface, url, {shared:true});
    client = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = false;
    rfb.focusOnClick = true;
    buttons();
    const current = () => client === rfb && ticket === generation;
    rfb.addEventListener('connect', () => {
      if (!current()) return;
      clearTimeout(connectionTimeout); connectionTimeout = null;
      connected = true; connecting = false;
      status('已连接 · 请自行完成登录与验证码', 'connected');
      el('desktopPlaceholder').hidden = true;
      buttons();
    });
    rfb.addEventListener('disconnect', () => {
      if (!current()) return;
      stopConnection('远程连接已结束，可以手动重新连接', 'idle');
    });
    rfb.addEventListener('securityfailure', () => {
      if (!current()) return;
      stopConnection('远程桌面认证未完成，请检查服务状态后重连', 'error');
    });
    rfb.addEventListener('credentialsrequired', () => {
      if (!current()) return;
      stopConnection('远程桌面要求额外认证，请检查服务端 VNC 设置', 'error');
    });
    connectionTimeout = setTimeout(() => {
      if (current() && !connected) stopConnection('连接超时，请检查服务状态后手动重连', 'error');
    }, 20000);
  } catch {
    if (ticket === generation && !redirecting) {
      stopConnection('暂时无法建立连接，请稍后点击重试', 'error');
    }
  } finally {
    checkingSession = false;
    buttons();
  }
}
el('connectButton').addEventListener('click', () => { void connectDesktop(); });
el('disconnectButton').addEventListener('click', () => { stopConnection(); });
el('fullscreenButton').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === workspace) await document.exitFullscreen();
    else if (connected) await workspace.requestFullscreen();
  } catch {
    status('暂时无法进入全屏，可继续使用当前画面', connected ? 'connected' : 'idle');
  }
});
document.addEventListener('fullscreenchange', () => {
  const fullscreen = document.fullscreenElement === workspace;
  el('fullscreenButton').textContent = fullscreen ? '退出全屏' : '全屏';
  el('fullscreenButton').setAttribute('aria-label', fullscreen ? '退出远程桌面全屏' : '全屏显示远程桌面');
});
async function checkActiveSession() {
  if (checkingSession || redirecting) return;
  checkingSession = true;
  buttons();
  try { await readSession(); }
  catch {
    if (redirecting) return;
    stopConnection('无法确认登录状态，连接已断开；请点击连接重新确认', 'error');
  } finally {
    checkingSession = false;
    buttons();
  }
}
function startSessionChecks() {
  if (sessionTimer !== null) return;
  sessionTimer = setInterval(() => { void checkActiveSession(); }, 30000);
}
async function initialize() {
  clearInterval(sessionTimer); sessionTimer = null;
  checkingSession = true; redirecting = false;
  status('正在确认管理登录状态…', 'connecting');
  buttons();
  try {
    if (!await readSession() || redirecting) return;
    status('登录已确认，点击按钮连接桌面', 'ready');
    placeholder('桌面等待连接', '点击「连接桌面」后，才会建立远程连接。');
    startSessionChecks();
  } catch {
    if (!redirecting) {
      status('暂时无法确认登录状态，点击连接可重试', 'error');
      placeholder('连接尚未建立', '请检查网络或服务状态，再点击「连接桌面」。');
    }
  } finally {
    checkingSession = false;
    buttons();
  }
}
window.addEventListener('pagehide', () => {
  clearInterval(sessionTimer); sessionTimer = null;
  sessionRequest?.abort(); sessionRequest = null;
  stopConnection();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) void initialize();
});
void initialize();
