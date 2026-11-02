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
