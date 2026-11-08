// 业务字段来源见 ../方案.md；未知值始终保留为 null。
export const METRICS = {
  plays: ['play_count', 'play', 'vv', 'plays', 'views'],
  finish_rate: ['finish_rate', 'play_finish_rate', 'complete_rate'],
  avg_play_duration_sec: ['avg_duration_sec', 'avg_play_duration', 'avg_play_time'],
  likes: ['digg_count', 'like_count', 'digg', 'likes'],
  comments: ['comment_count', 'comment', 'comments'],
  shares: ['share_count', 'share', 'shares'],
  favorites: ['collect_count', 'favorite_count', 'collect', 'favorites'],
  follower_gain: ['fans_increment', 'follower_gain', 'new_fans'],
  finish_5s_rate: ['finish_5s_rate', 'five_sec_play_rate', 'play_5s_rate'],
  bounce_2s_rate: ['bounce_2s_rate', 'bounce_rate_2s'],
  cover_ctr: ['cover_ctr', 'cover_click_rate'],
  profile_visits: ['profile_visits', 'profile_visit_count', 'homepage_visit_count'],
};
export const CORE = ['plays', 'finish_rate', 'avg_play_duration_sec', 'likes', 'comments', 'shares', 'favorites', 'follower_gain'];
export const object = x => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
export function idOf(value) {
  const o = object(value);
  const id = o.aweme_id ?? o.item_id ?? o.id;
  return typeof id === 'string' && /^\d+$/.test(id) ? id : null;
}
export function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim() || ['-', '--', '暂无', 'None', 'null'].includes(value.trim())) return null;
  const text = value.trim().replaceAll(',', '');
  if (!/^-?\d+(?:\.\d+)?%?$/.test(text)) return null;
  const n = Number(text.replace('%', ''));
  return text.endsWith('%') ? n / 100 : n;
}
export function metricsOf(value) {
  const root = object(value);
  const layers = [root, ...['statistics', 'stats', 'metrics', 'statistics_data', 'item_data'].map(k => object(root[k]))];
  return Object.fromEntries(Object.entries(METRICS).map(([name, aliases]) => {
    let value = null;
    for (const layer of layers) for (const alias of aliases) {
      const n = number(layer[alias]);
      if (n !== null) value = n;
    }
    return [name, value];
  }));
}
export function mergeMetrics(a, b) {
  return Object.fromEntries(Object.keys(METRICS).map(k => [k, b[k] ?? a[k] ?? null]));
}
export function parseList(json) {
  const root = object(json), data = object(root.data);
  const rows = [root.aweme_list, root.item_list, data.aweme_list, data.item_list].find(Array.isArray);
  if (!rows) throw new Error('LIST_SCHEMA_UNKNOWN');
  const works = rows.map(row => {
    const aweme_id = idOf(row);
    if (!aweme_id) throw new Error('WORK_ID_INVALID');
    const video = object(row.video), time = number(row.create_time), duration = number(video.duration);
    const cover = video.cover ?? video.origin_cover ?? row.cover;
    return {
      aweme_id,
      title: String(row.title || row.item_title || String(row.desc ?? '').split(/[\r\n]/)[0].slice(0, 80)).trim(),
      description: typeof row.desc === 'string' ? row.desc : null,
      published_at: time === null ? null : new Date(time * 1000).toISOString(),
      duration_sec: duration === null ? null : duration / 1000,
      cover_url: typeof cover === 'string' ? cover : cover?.url_list?.[0] ?? null,
      work_type: row.aweme_type == null && row.type == null ? null : String(row.aweme_type ?? row.type),
      visibility: row.status == null ? null : JSON.stringify(row.status),
      metrics: metricsOf(row), raw: row,
    };
  });
  const hm = root.has_more ?? data.has_more ?? root.hasMore ?? data.hasMore;
  const hasMore = [false, 0, '0'].includes(hm) ? false : [true, 1, '1'].includes(hm) ? true : null;
  return { works, hasMore, total: number(root.total ?? data.total ?? root.total_count ?? data.total_count), maxCursor: root.max_cursor ?? data.max_cursor ?? null, minCursor: root.min_cursor ?? data.min_cursor ?? null };
}
export function parseIdentity(json) {
  const root = object(json), data = object(root.data), result = object(root.result);
  // 默认模式shape结构：SESSION根节点的user_profile。
  // secret_id用作稳定账号约束；unique_id是可修改的抖音号，不能替代它。
  const profile = object(root.user_profile);
  if (typeof profile.nick_name === 'string' && typeof profile.secret_id === 'string' && profile.secret_id.trim()) {
    return { nickname: profile.nick_name, stable: profile.secret_id };
  }
  for (const base of [root, data, result]) {
    for (const candidate of [base.user_info, base.user, base.account_info, base.account, base.profile, base]) {
      const o = object(candidate), nickname = o.nickname ?? o.name;
      const stable = o.sec_uid ?? o.sec_user_id ?? o.uid ?? o.user_id;
      if (typeof nickname === 'string' && typeof stable === 'string' && stable) return { nickname, stable };
    }
  }
  return null;
}
// 只绑定明确属于该作品的响应。不按标题合并，也不把账号汇总误作单作品值。
export function detailRecords(json, requestId = null) {
  const found = [];
  function visit(value, inheritedId, depth) {
    if (depth > 10 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      // 无逐条 ID 的时间序列不推算累计值。
      for (const row of value) if (idOf(row)) visit(row, null, depth + 1);
      return;
    }
    const ownId = idOf(value), id = ownId ?? inheritedId;
    const metrics = metricsOf(value);
    if (id && Object.values(metrics).some(v => v !== null)) found.push({ aweme_id: id, metrics });
    for (const [key, child] of Object.entries(value)) {
      if (['author', 'user', 'account', 'account_info'].includes(key)) continue;
      visit(child, id, depth + 1);
    }
  }
  visit(json, requestId, 0);
  const merged = new Map();
  for (const row of found) merged.set(row.aweme_id, mergeMetrics(merged.get(row.aweme_id) ?? {}, row.metrics));
  return [...merged].map(([aweme_id, metrics]) => ({ aweme_id, metrics }));
}
export function pageCount(text) {
  for (const re of [/(?:全部作品|作品总数|作品总计|全部投稿)\s*[（(:：]?\s*(\d[\d,]*)/, /(?:^|\n)\s*作品\s*[（(]\s*(\d[\d,]*)\s*[)）]/, /共\s*(\d[\d,]*)\s*(?:个|条|篇)?\s*作品/, /全部\s*[（(]\s*(\d[\d,]*)\s*[)）]/]) {
    const match = String(text).match(re);
    if (match) return Number(match[1].replaceAll(',', ''));
  }
  return null;
}
const SECRET = /cookie|token|authorization|session(?:id|_id|_key)?|secret|password|passport|signature|a_bogus|x_bogus|verifyfp|fingerprint/i;
export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET.test(key)).map(([key, v]) => [key, sanitize(v)]));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value); u.username = ''; u.password = ''; u.hash = '';
      for (const key of [...u.searchParams.keys()]) if (SECRET.test(key) || /sign|auth|credential|ticket|key/i.test(key)) u.searchParams.delete(key);
      return u.toString();
    } catch { return '[无效地址]'; }
  }
  if (typeof value === 'string' && /^\s*[\[{]/.test(value)) {
    try { return JSON.stringify(sanitize(JSON.parse(value))); } catch {}
  }
  return value;
}
