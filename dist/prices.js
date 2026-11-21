(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ACAPrices = api;
})(globalThis, function () {
  'use strict';

  const SOURCE_URL = 'https://raw.githubusercontent.com/AidVir/wow-forever-favor/main/data/prices.json';
  const SOURCE_PATTERN = /^https:\/\/raw\.githubusercontent\.com\/AidVir\/wow-forever-favor\/(?:main|[a-f0-9]{40})\/data\/prices\.json$/;
  const HOUR = 60 * 60 * 1000;
  const CHECK_INTERVAL = 15 * 60 * 1000;
  const dateFormat = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });

  function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function positiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function invalid() {
    throw new Error('Некорректные данные цен EU PvP, Альянс.');
  }

  function isoDate(value, allowHTTPDate = false) {
    if (typeof value !== 'string') invalid();
    const time = Date.parse(value);
    if (!Number.isFinite(time)) invalid();
    const date = new Date(time);
    const iso = date.toISOString();
    if (allowHTTPDate && date.toUTCString() === value) return iso;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) invalid();
    const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => `.${(fraction || '').padEnd(3, '0')}Z`);
    if (canonical !== iso) invalid();
    return iso;
  }

  function marketMeta(snapshot, sourceUpdated) {
    const meta = {
      region: 'EU', ruleset: { id: 1, name: 'PvP' },
      house: { id: 110, name: 'Alliance Auction House' }, faction: 'Alliance',
      snapshot, currency: 'copper', snapshotLabel: `${dateFormat.format(new Date(snapshot))} МСК`
    };
    if (sourceUpdated !== undefined) meta.sourceUpdated = sourceUpdated;
    return meta;
  }

  function normalizeSnapshot(raw) {
    if (!object(raw) || typeof raw.source !== 'string' || !SOURCE_PATTERN.test(raw.source)) invalid();
    const meta = raw.meta;
    if (!object(meta) || meta.region !== 'EU' || meta.ruleset?.id !== 1 ||
        meta.house?.id !== 110 || meta.faction !== 'Alliance' || meta.currency !== 'copper' ||
        !object(raw.pairs)) invalid();
    const snapshot = isoDate(meta.snapshot);
    const sourceUpdated = meta.sourceUpdated === undefined ? undefined : isoDate(meta.sourceUpdated);
    const pairs = {};
    for (const [quest, pair] of Object.entries(raw.pairs)) {
      if (!/^[1-9]\d*$/.test(quest) || !positiveInteger(Number(quest)) ||
          !Array.isArray(pair) || pair.length !== 3 ||
          !pair.every(value => value === null || positiveInteger(value))) invalid();
      const [writ, item, total] = pair;
      const expected = writ === null || item === null ? null : writ + item;
      if (total !== expected || (expected !== null && !positiveInteger(expected))) invalid();
      pairs[quest] = [...pair];
    }
    return { source: raw.source, meta: marketMeta(snapshot, sourceUpdated), pairs };
  }

  function validateLevels(levels) {
    if (!Array.isArray(levels) || !levels.every(level => Array.isArray(level) &&
        level.length === 2 && positiveInteger(level[0]) && positiveInteger(level[1]))) invalid();
  }

  function buyCost(levels, count) {
    if (!positiveInteger(count)) invalid();
    if (levels === undefined) return null;
    validateLevels(levels);
    let remaining = count;
    let total = 0;
    for (const [unit, quantity] of [...levels].sort((a, b) => a[0] - b[0])) {
      const amount = Math.min(quantity, remaining);
      total += unit * amount;
      if (!positiveInteger(total)) invalid();
      remaining -= amount;
      if (!remaining) return total;
    }
    return null;
  }

  function fromFeed(feed, writs) {
    if (!object(feed) || feed.region !== 'EU' || feed.ruleset?.id !== 1 ||
        !object(feed.factions) || !object(feed.factions.alliance)) invalid();
    const house = feed.factions.alliance;
    if (house.house?.id !== 110 || !object(house.items) || !Array.isArray(writs)) invalid();
    const sourceUpdated = isoDate(feed.updated);
    const snapshot = isoDate(house.lastModified, true);
    for (const [id, levels] of Object.entries(house.items)) {
      if (!/^[1-9]\d*$/.test(id) || !positiveInteger(Number(id))) invalid();
      validateLevels(levels);
    }
    const pairs = {};
    for (const writ of writs) {
      if (!object(writ) || ![writ.quest, writ.writ, writ.item, writ.count].every(positiveInteger) ||
          Object.hasOwn(pairs, writ.quest)) invalid();
      const writCost = buyCost(house.items[writ.writ], 1);
      const itemCost = buyCost(house.items[writ.item], writ.count);
      const total = writCost === null || itemCost === null ? null : writCost + itemCost;
      if (total !== null && !positiveInteger(total)) invalid();
      pairs[writ.quest] = [writCost, itemCost, total];
    }
    return { source: SOURCE_URL, meta: marketMeta(snapshot, sourceUpdated), pairs };
  }

  function chooseSnapshot(embedded, cached) {
    const baseline = normalizeSnapshot(embedded);
    try {
      const candidate = normalizeSnapshot(cached);
      const quests = Object.keys(baseline.pairs);
      if (Object.keys(candidate.pairs).length !== quests.length ||
          !quests.every(quest => Object.hasOwn(candidate.pairs, quest))) return baseline;
      return Date.parse(candidate.meta.snapshot) > Date.parse(baseline.meta.snapshot) ? candidate : baseline;
    } catch {
      return baseline;
    }
  }

  function shouldAutoRefresh(snapshot, lastCheckedAt, now = Date.now()) {
    const snapshotTime = Date.parse(isoDate(snapshot.meta.snapshot));
    const checked = typeof lastCheckedAt === 'number' && Number.isFinite(lastCheckedAt) ? lastCheckedAt : 0;
    return Number.isFinite(now) && now - snapshotTime > HOUR && now - checked > CHECK_INTERVAL;
  }

  async function fetchLatest(writs, { signal } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('Источник цен не ответил за 15 секунд.')), 15000);
    try {
      const response = await fetch(SOURCE_URL, {
        credentials: 'omit', cache: 'no-store', signal: controller.signal
      });
      if (!response.ok) throw new Error(`Источник цен вернул HTTP ${response.status}.`);
      return fromFeed(await response.json(), writs);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  return Object.freeze({ SOURCE_URL, normalizeSnapshot, fromFeed, buyCost, fetchLatest, chooseSnapshot, shouldAutoRefresh });
});
