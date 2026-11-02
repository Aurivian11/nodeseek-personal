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
