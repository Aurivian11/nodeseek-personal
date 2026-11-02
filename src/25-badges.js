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
