const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const prices = require('../dist/prices.js');
const writs = require('../dist/data.json').writs;

function feed() {
  return {
    updated: '2026-11-21T15:30:00Z', region: 'EU', ruleset: { id: 1 },
    factions: { alliance: {
      house: { id: 110 }, lastModified: 'Sat, 21 Nov 2026 15:00:00 GMT',
      items: { 264037: [[4998, 2]], 8069: [[5, 120], [3, 50], [4, 80]] }
    } }
  };
}

function snapshot(date = '2026-11-21T15:00:00Z') {
  return {
    source: prices.SOURCE_URL,
    meta: { region: 'EU', ruleset: { id: 1 }, house: { id: 110 },
      faction: 'Alliance', snapshot: date, currency: 'copper' },
    pairs: { 94237: [4998, 820, 5818] }
  };
}

test('browser export works without document or window', () => {
  const context = vm.createContext({ Intl });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/prices.js'), 'utf8'), context);
  assert.equal(context.ACAPrices.SOURCE_URL, prices.SOURCE_URL);
});

test('200 shots cost the exact quantity across the cheapest tiers without mutating the feed', () => {
  const levels = [[5, 120], [3, 50], [4, 80]];
  assert.equal(prices.buyCost(levels, 200), 820);
  assert.deepEqual(levels, [[5, 120], [3, 50], [4, 80]]);
  assert.equal(prices.buyCost(levels, 251), null);
  assert.equal(prices.buyCost([], 1), null);
  assert.equal(prices.buyCost(undefined, 1), null);
});

test('feed uses the faction snapshot time, preserves the source update time, and includes all 150 quests', () => {
  const result = prices.fromFeed(feed(), writs);
  assert.equal(Object.keys(result.pairs).length, 150);
  assert.deepEqual(result.pairs[94237], [4998, 820, 5818]);
  assert.deepEqual(result.pairs[94228], [null, null, null]);
  assert.equal(result.meta.snapshot, '2026-11-21T15:00:00.000Z');
  assert.equal(result.meta.sourceUpdated, '2026-11-21T15:30:00.000Z');
  assert.match(result.meta.snapshotLabel, /21\.11\.2026, 18:00 МСК/);
});

test('insufficient stock keeps the known component and leaves the total null', () => {
  const data = feed();
  data.factions.alliance.items[8069] = [[4, 199]];
  assert.deepEqual(prices.fromFeed(data, writs).pairs[94237], [4998, null, null]);
});

test('wrong market, invalid dates and malformed price tiers reject the whole feed', () => {
  const changes = [
    data => { data.region = 'US'; },
    data => { data.ruleset.id = 2; },
    data => { data.factions.alliance.house.id = 111; },
    data => { data.updated = 'yesterday'; },
    data => { data.updated = '2026-02-30T15:30:00Z'; },
    data => { data.factions.alliance.lastModified = 'not a date'; },
    data => { data.factions.alliance.items[999] = [[NaN, 1]]; },
    data => { data.factions.alliance.items[999] = [[Infinity, 1]]; },
    data => { data.factions.alliance.items[999] = [[0, 1]]; },
    data => { data.factions.alliance.items[999] = [[1, -1]]; },
    data => { data.factions.alliance.items[999] = [[1, 1.5]]; },
    data => { data.factions.alliance.items[999] = [[1, 1, 1]]; },
    data => { data.factions.alliance.items[999] = null; }
  ];
  for (const change of changes) {
    const data = feed();
    change(data);
    assert.throws(() => prices.fromFeed(data, writs));
  }
});

test('snapshot normalization validates totals and regenerates all market labels', () => {
  const input = snapshot();
  input.meta.snapshotLabel = '<script>untrusted</script>';
  input.meta.house.name = 'Horde';
  const result = prices.normalizeSnapshot(input);
  assert.equal(result.meta.house.name, 'Alliance Auction House');
  assert.match(result.meta.snapshotLabel, /18:00 МСК/);
  assert.notStrictEqual(result.pairs[94237], input.pairs[94237]);
  const wrongTotal = snapshot();
  wrongTotal.pairs[94237][2] = 0;
  assert.throws(() => prices.normalizeSnapshot(wrongTotal));
  const partial = snapshot();
  partial.pairs[94237] = [4998, null, null];
  assert.deepEqual(prices.normalizeSnapshot(partial).pairs[94237], [4998, null, null]);
});

test('item books preserve exact price depth and empty stock without aliasing the input', () => {
  const input = snapshot();
  input.items = { 8069: [[5, 120], [3, 50], [4, 80]], 999: [] };
  const result = prices.normalizeSnapshot(input);
  assert.deepEqual(result.items, { 8069: [[3, 50], [4, 80], [5, 120]], 999: [] });
  assert.equal(prices.buyCost(result.items[8069], 200), 820);
  assert.equal(prices.buyCost(result.items[8069], 251), null);
  result.items[8069][0][1] = 1;
  assert.deepEqual(input.items[8069], [[5, 120], [3, 50], [4, 80]]);
  assert.equal(Object.hasOwn(prices.normalizeSnapshot(snapshot()), 'items'), false);
  for (const items of [null, [], { 0: [] }, { '01': [] }, { '9007199254740992': [] }, { 999: [[1, 0]] }, { 999: [[Infinity, 1]] }, { 999: [[1, 1, 1]] }]) {
    assert.throws(() => prices.normalizeSnapshot({ ...snapshot(), items }));
  }
});

test('a requested book distinguishes no listed stock from an unobserved item', () => {
  const input = feed();
  const before = structuredClone(input);
  const result = prices.fromFeed(input, writs, { itemIds: [8069, 999, 8069] });
  assert.deepEqual(result.items, { 8069: [[3, 50], [4, 80], [5, 120]], 999: [] });
  assert.deepEqual(input, before);
  assert.equal(prices.hasItems(result, [8069, 999]), true);
  assert.equal(prices.hasItems(result, [8069, 1000]), false);
  assert.equal(prices.hasItems(snapshot(), [8069]), false);
  assert.equal(prices.hasItems(snapshot(), []), true);
  assert.equal(prices.hasItems({ items: { 8069: [[NaN, 1]] } }, [8069]), false);
  assert.equal(prices.hasItems({ items: Object.create({ 8069: [] }) }, [8069]), false);
  assert.throws(() => prices.fromFeed(input, writs, { itemIds: [0] }));
  assert.throws(() => prices.fromFeed(input, writs, { itemIds: ['8069'] }));
});

test('cached snapshot cannot replace embedded prices with older, equal or invalid data', () => {
  const embedded = snapshot();
  const older = snapshot('2026-11-21T14:00:00Z');
  const equal = snapshot();
  const newer = snapshot('2026-11-21T16:00:00Z');
  equal.pairs[94237] = [1, 2, 3];
  newer.pairs[94237] = [1, 2, 3];
  assert.deepEqual(prices.chooseSnapshot(embedded, older).pairs, embedded.pairs);
  assert.deepEqual(prices.chooseSnapshot(embedded, equal).pairs, embedded.pairs);
  assert.deepEqual(prices.chooseSnapshot(embedded, newer).pairs, newer.pairs);
  assert.deepEqual(prices.chooseSnapshot(embedded, null).pairs, embedded.pairs);
  newer.meta.faction = 'Horde';
  assert.deepEqual(prices.chooseSnapshot(embedded, newer).pairs, embedded.pairs);
  newer.meta.faction = 'Alliance';
  newer.meta.snapshot = 'invalid';
  assert.deepEqual(prices.chooseSnapshot(embedded, newer).pairs, embedded.pairs);
});

test('newer cache must contain the same quest set while complete null prices remain valid', () => {
  const embedded = snapshot();
  embedded.pairs[94228] = [100, 200, 300];
  const newer = structuredClone(embedded);
  newer.meta.snapshot = '2026-11-21T16:00:00Z';
  newer.pairs = {};
  assert.deepEqual(prices.chooseSnapshot(embedded, newer).pairs, embedded.pairs);
  newer.pairs = { 94237: [1, 2, 3] };
  assert.deepEqual(prices.chooseSnapshot(embedded, newer).pairs, embedded.pairs);
  newer.pairs = { 94237: [1, 2, 3], 99999: [null, null, null] };
  assert.deepEqual(prices.chooseSnapshot(embedded, newer).pairs, embedded.pairs);
  newer.pairs = { 94237: [null, null, null], 94228: [null, null, null] };
  const selected = prices.chooseSnapshot(embedded, newer);
  assert.deepEqual(selected.pairs, newer.pairs);
  assert.equal(selected.meta.snapshot, '2026-11-21T16:00:00.000Z');
});

test('equal-date books upgrade old snapshots without downgrading a complete baseline', () => {
  const embedded = snapshot();
  const cached = snapshot();
  cached.items = { 8069: [[4, 200]], 999: [] };
  cached.pairs[94237] = [10, 800, 810];
  const options = { itemIds: [8069, 999] };
  assert.deepEqual(prices.chooseSnapshot(embedded, cached, options).items, cached.items);
  const incomplete = snapshot();
  incomplete.items = { 8069: [[1, 1]] };
  assert.deepEqual(prices.chooseSnapshot(cached, incomplete, options).items, cached.items);
  assert.deepEqual(prices.chooseSnapshot(cached, embedded, options).items, cached.items);
  const invalid = snapshot('2026-11-21T16:00:00Z');
  invalid.items = { 8069: [[0, 1]], 999: [] };
  assert.deepEqual(prices.chooseSnapshot(cached, invalid, options).items, cached.items);
});

test('newer route prices remain usable without carrying an old item book across time', () => {
  const embedded = snapshot();
  embedded.items = { 8069: [[4, 200]], 999: [] };
  const cached = snapshot('2026-11-21T16:00:00Z');
  cached.pairs[94237] = [10, 800, 810];
  const selected = prices.chooseSnapshot(embedded, cached, { itemIds: [8069, 999] });
  assert.deepEqual(selected.pairs, cached.pairs);
  assert.equal(Object.hasOwn(selected, 'items'), false);
  const olderBook = { ...embedded, meta: { ...embedded.meta, snapshot: '2026-11-21T14:00:00Z' } };
  assert.equal(Object.hasOwn(prices.chooseSnapshot(cached, olderBook, { itemIds: [8069, 999] }), 'items'), false);
});

test('auto refresh requires a snapshot older than one hour and a check older than 15 minutes', () => {
  const data = snapshot();
  const at = Date.parse(data.meta.snapshot);
  const hour = 3600000;
  const interval = 900000;
  assert.equal(prices.shouldAutoRefresh(data, 0, at + hour), false);
  assert.equal(prices.shouldAutoRefresh(data, 0, at + hour + 1), true);
  assert.equal(prices.shouldAutoRefresh(data, at + hour, at + hour + interval), false);
  assert.equal(prices.shouldAutoRefresh(data, at + hour, at + hour + interval + 1), true);
  assert.equal(prices.shouldAutoRefresh(data, at + hour * 3, at + hour * 2), false);
});

test('the first item-book upgrade bypasses freshness and refresh throttling', () => {
  const data = snapshot();
  const now = Date.parse(data.meta.snapshot) + 1;
  const options = { itemIds: [8069, 999] };
  assert.equal(prices.shouldAutoRefresh(data, now, now, options), true);
  data.items = { 8069: [] };
  assert.equal(prices.shouldAutoRefresh(data, now, now, options), true);
  data.items[999] = [];
  assert.equal(prices.shouldAutoRefresh(data, now, now, options), false);
});

test('fetch uses only the fixed public URL with no credentials or cache', async t => {
  let received;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    received = { url, options };
    return { ok: true, json: async () => feed() };
  });
  const result = await prices.fetchLatest(writs, { itemIds: [8069, 999] });
  assert.equal(received.url, prices.SOURCE_URL);
  assert.equal(received.options.credentials, 'omit');
  assert.equal(received.options.cache, 'no-store');
  assert.equal(received.options.signal.aborted, false);
  assert.equal(result.meta.snapshot, '2026-11-21T15:00:00.000Z');
  assert.equal(prices.hasItems(result, [8069, 999]), true);
  assert.deepEqual(result.items[999], []);
});

test('HTTP and JSON failures reject without returning a partial snapshot', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(prices.fetchLatest(writs), /HTTP 503/);
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('JSON'); } });
  await assert.rejects(prices.fetchLatest(writs), SyntaxError);
});

test('caller cancellation and the 15 second timeout abort the request', async t => {
  let requestSignal;
  t.mock.method(globalThis, 'fetch', async (_, { signal }) => {
    requestSignal = signal;
    if (signal.aborted) throw signal.reason;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const caller = new AbortController();
  const pending = prices.fetchLatest(writs, { signal: caller.signal });
  caller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  assert.equal(requestSignal.aborted, true);
  await assert.rejects(prices.fetchLatest(writs, { signal: caller.signal }), /cancelled/);

  let timeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 15000);
    timeout = callback;
    return 1;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const timed = prices.fetchLatest(writs);
  timeout();
  await assert.rejects(timed, /15 секунд/);
  assert.equal(requestSignal.aborted, true);
});
