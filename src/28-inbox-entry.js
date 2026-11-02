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
