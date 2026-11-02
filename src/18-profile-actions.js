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
