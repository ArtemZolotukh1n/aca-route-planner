'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const catalog = require('../dist/favor-data.json');
const rawPrices = require('../dist/prices.json');
const prices = require('../dist/prices.js');
const favor = require('../dist/favor-core.js');

const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const requiredItems = catalog.crates.flatMap(crate => [crate.id, ...crate.bundles.map(bundle => bundle.item)]);
const snapshot = prices.normalizeSnapshot(rawPrices);
const rewards = new Map([
  [91899, ['APPRENTICE', 10, 5, 250]],
  [91900, ['JOURNEYMAN', 10, 10, 500]],
  [91901, ['EXPERT', 20, 15, 750]],
  [91902, ['ARTISAN', 35, 20, null]],
  [91904, ['APPRENTICE', 10, 10, 500]],
  [91905, ['JOURNEYMAN', 10, 20, 1000]],
  [91906, ['EXPERT', 20, 30, 1500]],
  [91907, ['ARTISAN', 35, 40, null]],
]);
const professions = {
  ALCHEMY: ['Recipe:', 256729],
  BLACKSMITHING: ['Plans:', 256730],
  COOKING: ['Recipe:', 256731],
  ENCHANTING: ['Formula:', 256732],
  ENGINEERING: ['Schematic:', 256733],
  LEATHERWORKING: ['Pattern:', 256734],
  TAILORING: ['Pattern:', 256735],
};

function units(id) {
  return snapshot.items[id].reduce((sum, [, quantity]) => sum + quantity, 0);
}

// Reconstruct the purchase from the published stock, independently of solve's cursors.
function purchaseCost(id, quantity) {
  let remaining = quantity;
  let total = 0;
  for (const [price, available] of [...snapshot.items[id]].sort((a, b) => a[0] - b[0])) {
    const taken = Math.min(available, remaining);
    total += price * taken;
    remaining -= taken;
    if (!remaining) break;
  }
  assert.equal(remaining, 0, `Недостаточно опубликованного запаса предмета ${id}`);
  return total;
}

function checkPlan(target) {
  const input = { crates: catalog.crates, items: snapshot.items, balance: 0, target, level: 60 };
  const original = JSON.stringify(input);
  const plan = favor.solve(input);
  assert.equal(JSON.stringify(input), original, 'Расчёт не должен менять каталог или снимок');
  const capacity = catalog.crates.reduce((sum, crate) => {
    const filled = crate.bundles.reduce((count, bundle) => count + Math.floor(units(bundle.item) / bundle.count), 0);
    return sum + Math.min(units(crate.id), filled) * crate.favor;
  }, 0);
  assert.equal(plan.availableFavor, capacity);
  assert.equal(plan.deficit, target);
  if (capacity < target) {
    assert.equal(plan.status, 'insufficientData');
    assert.deepEqual(plan.lines, []);
    assert.equal(plan.crateCount, 0);
    return;
  }
  assert.equal(plan.status, 'ready');
  assert.ok(plan.totalFavor >= target);
  const bought = new Map();
  const usedLines = new Set();
  const sums = { totalFavor: 0, totalReturnCopper: 0, grossCopper: 0, netCopper: 0, crateCount: 0, unknownReturnCount: 0 };
  for (const line of plan.lines) {
    const crate = catalog.crates.find(candidate => candidate.id === line.crateId);
    assert.ok(crate, `Неизвестный ящик в результате: ${line.crateId}`);
    const bundle = crate.bundles.find(candidate => candidate.item === line.item);
    assert.ok(bundle, `Неверное наполнение ящика ${line.crateId}: ${line.item}`);
    const key = `${line.crateId}:${line.item}`;
    assert.equal(usedLines.has(key), false, `Повторная строка ${key}`);
    usedLines.add(key);
    assert.ok(positive(line.crates));
    assert.equal(line.countPerCrate, bundle.count);
    assert.equal(line.itemCount, line.crates * bundle.count);
    assert.equal(line.favor, line.crates * crate.favor);
    assert.equal(line.returnCopper, line.crates * (crate.returnCopper ?? 0));
    assert.ok(nonnegative(line.grossCopper));
    assert.equal(line.netCopper, line.grossCopper - line.returnCopper);
    bought.set(crate.id, (bought.get(crate.id) || 0) + line.crates);
    bought.set(line.item, (bought.get(line.item) || 0) + line.itemCount);
    sums.totalFavor += line.favor;
    sums.totalReturnCopper += line.returnCopper;
    sums.grossCopper += line.grossCopper;
    sums.netCopper += line.netCopper;
    sums.crateCount += line.crates;
    sums.unknownReturnCount += crate.returnCopper === null ? line.crates : 0;
  }
  const cost = [...bought].reduce((sum, [id, quantity]) => sum + purchaseCost(id, quantity), 0);
  assert.equal(plan.grossCopper, cost);
  assert.equal(plan.netCopper, cost - sums.totalReturnCopper);
  for (const [key, value] of Object.entries(sums)) assert.equal(plan[key], value, key);
}

test('каталог ящиков не содержит общих запасов, неподтверждённых названий и неверных источников', () => {
  assert.equal(catalog.version, 1);
  assert.deepEqual(catalog.currency, { id: 3402, name: "Merchant's Favor" });
  assert.match(catalog.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(catalog.checkedAt).toISOString().slice(0, 10), catalog.checkedAt);
  assert.equal(new Set(requiredItems).size, requiredItems.length, 'Ящики и наполнения не должны делить один запас itemID');
  assert.deepEqual(new Set(catalog.crates.map(crate => crate.quest)), new Set(rewards.keys()));
  for (const crate of catalog.crates) {
    assert.ok(positive(crate.id));
    const tierName = crate.tier[0] + crate.tier.slice(1).toLowerCase();
    assert.ok(crate.name.startsWith('Waylaid Crate: ') && crate.name.includes(`${tierName} `), crate.name);
    assert.ok(crate.bundles.length > 0, crate.name);
    assert.deepEqual([crate.tier, crate.level, crate.favor, crate.returnCopper], rewards.get(crate.quest), crate.name);
    const source = new URL(crate.source);
    assert.equal(source.origin, 'https://db.icy-veins.com');
    assert.equal(source.pathname, `/wow-forever/items/${crate.id}`);
    assert.equal(catalog.items[crate.id], crate.name);
    for (const bundle of crate.bundles) {
      assert.ok(positive(bundle.item) && positive(bundle.count), crate.name);
      assert.equal(typeof catalog.items[bundle.item], 'string', `Нет имени наполнения ${bundle.item}`);
      assert.ok(catalog.items[bundle.item].trim());
    }
  }
});

test('рецепты имеют собственные ID, корректного торговца и ссылку на тот же предмет Forever', () => {
  assert.equal(new Set(catalog.recipes.map(recipe => recipe.id)).size, catalog.recipes.length);
  const disputed = catalog.recipes.filter(recipe => !recipe.available);
  assert.deepEqual(disputed.map(recipe => recipe.id).sort(), [264221, 264222], 'Доступность спорных Gnomish Army Knife и Loot-A-Rang требует повторной проверки');
  assert.deepEqual(new Set(catalog.recipes.map(recipe => recipe.profession)), new Set(Object.keys(professions)));
  for (const recipe of catalog.recipes) {
    assert.ok(positive(recipe.id), recipe.name);
    assert.ok(Object.hasOwn(professions, recipe.profession), recipe.name);
    const [prefix, vendor] = professions[recipe.profession];
    assert.ok(recipe.name.startsWith(prefix), recipe.name);
    assert.ok(positive(recipe.cost), recipe.name);
    assert.ok(positive(recipe.skill) && recipe.skill <= 300, recipe.name);
    assert.ok([null, 0, 3000, 9000, 21000, 42000].includes(recipe.reputation), recipe.name);
    assert.equal(recipe.vendor.id, vendor, recipe.name);
    assert.ok(typeof recipe.vendor.name === 'string' && recipe.vendor.name.trim(), recipe.name);
    assert.equal(typeof recipe.available, 'boolean', recipe.name);
    if (!recipe.available) assert.ok(typeof recipe.note === 'string' && recipe.note.trim(), recipe.name);
    const source = new URL(recipe.source);
    assert.equal(source.origin, 'https://www.wowhead.com');
    assert.match(source.pathname, new RegExp(`^/forever/item=${recipe.id}(?:/|$)`), recipe.name);
  }
});

test('встроенный снимок содержит наблюдение каждого ящика и материала, включая отсутствие лотов', () => {
  assert.equal(prices.hasItems(snapshot, requiredItems), true, 'Обновить книгу цен при добавлении предметов в каталог');
  const missing = { ...snapshot, items: { ...snapshot.items } };
  delete missing.items[requiredItems[0]];
  assert.equal(prices.hasItems(missing, requiredItems), false);
  missing.items[requiredItems[0]] = [];
  assert.equal(prices.hasItems(missing, requiredItems), true, 'Проверенное отсутствие лотов отличается от отсутствия данных');
});

test('реальный каталог и снимок восстанавливают запас, закупку и возврат для цели 120 Favor', () => {
  checkPlan(120);
});

test('полная корзина доступных рецептов и цель 30000 обрабатывают реальный запас без обещания недостающих лотов', () => {
  const target = catalog.recipes.filter(recipe => recipe.available).reduce((sum, recipe) => sum + recipe.cost, 0);
  checkPlan(target);
  checkPlan(Math.max(30000, target));
});
