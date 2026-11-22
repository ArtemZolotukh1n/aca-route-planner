'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { solve } = require('../dist/favor-core.js');

function crate(id, favor = 5, bundles = [{ item: id + 1000, count: 1 }], extra = {}) {
  return { id, name: `Ящик ${id}`, tier: 'Apprentice', level: 1, favor, returnCopper: 0,
    quest: id + 10000, source: 'https://example.com/', bundles, ...extra };
}

function cost(levels = [], count) {
  const units = levels.flatMap(([price, quantity]) => new Array(quantity).fill(price)).sort((a, b) => a - b);
  return count <= units.length ? units.slice(0, count).reduce((sum, price) => sum + price, 0) : Infinity;
}

function oracle(input) {
  const deficit = Math.max(0, input.target - input.balance), level = input.level ?? 60;
  const choices = input.crates.filter(crate => crate.level <= level).map(crate => {
    const variants = [];
    const stock = (input.items[crate.id] || []).reduce((sum, [, quantity]) => sum + quantity, 0);
    function allocate(index, count, fillCost) {
      if (index === crate.bundles.length) {
        variants.push({ favor: count * crate.favor, net: cost(input.items[crate.id], count) + fillCost - count * (crate.returnCopper ?? 0), maximum: count ? crate.favor : 0 });
        return;
      }
      const bundle = crate.bundles[index];
      for (let amount = 0; amount <= stock - count; amount += 1) {
        const price = cost(input.items[bundle.item], amount * bundle.count);
        if (price === Infinity) break;
        allocate(index + 1, count + amount, fillCost + price);
      }
    }
    allocate(0, 0, 0);
    return variants;
  });
  const availableFavor = choices.reduce((sum, options) => sum + Math.max(...options.map(option => option.favor)), 0);
  if (!deficit) return { status: 'alreadyEnough', net: 0, availableFavor };
  if (availableFavor < deficit) return { status: 'insufficientData', net: 0, availableFavor };
  let best = Infinity;
  function combine(index, favor, net, maximum) {
    if (index === choices.length) {
      if (favor >= deficit && favor - maximum < deficit) best = Math.min(best, net);
      return;
    }
    for (const option of choices[index]) combine(index + 1, favor + option.favor, net + option.net, Math.max(maximum, option.maximum));
  }
  combine(0, 0, 0, 0);
  return { status: 'ready', net: best, availableFavor };
}

function verifyPlan(input, result) {
  assert.equal(result.deficit, Math.max(0, input.target - input.balance));
  if (result.status !== 'ready') {
    assert.deepEqual(result.lines, []);
    for (const key of ['totalFavor', 'totalReturnCopper', 'grossCopper', 'netCopper', 'crateCount', 'unknownReturnCount']) assert.equal(result[key], 0);
    return;
  }
  const purchases = new Map();
  let favor = 0, returns = 0, crates = 0, unknown = 0, maximum = 0;
  for (const line of result.lines) {
    const definition = input.crates.find(crate => crate.id === line.crateId);
    const bundle = definition.bundles.find(bundle => bundle.item === line.item);
    assert.equal(line.countPerCrate, bundle.count);
    assert.equal(line.itemCount, line.crates * bundle.count);
    assert.equal(line.favor, line.crates * definition.favor);
    assert.equal(line.returnCopper, line.crates * (definition.returnCopper ?? 0));
    assert.equal(line.netCopper, line.grossCopper - line.returnCopper);
    purchases.set(line.crateId, (purchases.get(line.crateId) || 0) + line.crates);
    purchases.set(line.item, (purchases.get(line.item) || 0) + line.itemCount);
    favor += line.favor; returns += line.returnCopper; crates += line.crates;
    unknown += definition.returnCopper === null ? line.crates : 0;
    maximum = Math.max(maximum, definition.favor);
  }
  const gross = [...purchases].reduce((sum, [id, count]) => sum + cost(input.items[id], count), 0);
  assert.notEqual(gross, Infinity);
  assert.equal(result.grossCopper, gross);
  assert.equal(result.totalReturnCopper, returns);
  assert.equal(result.netCopper, gross - returns);
  assert.equal(result.totalFavor, favor);
  assert.equal(result.crateCount, crates);
  assert.equal(result.unknownReturnCount, unknown);
  assert.ok(favor >= result.deficit && favor - maximum < result.deficit, 'План должен заканчиваться при первом достижении цели');
  const last = result.lines.at(-1);
  assert.equal(last.favor / last.crates, maximum, 'Последняя строка должна оставлять крупный ящик на последнюю сдачу');
}

test('экспортирует API для браузера и CommonJS', () => {
  const source = fs.readFileSync(path.join(__dirname, '../dist/favor-core.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(typeof context.ACAFavor.solve, 'function');
  assert.ok(Object.isFrozen(context.ACAFavor));
});

test('жадный выбор стоимости за Favor проигрывает точному плану на остатке', () => {
  const input = { crates: [crate(1, 10), crate(2, 15)], items: {
    1: [[1, 2]], 1001: [[5, 2]], 2: [[1, 1]], 1002: [[9, 1]]
  }, balance: 0, target: 15 };
  const result = solve(input);
  assert.equal(result.netCopper, 10);
  assert.equal(result.lines[0].crateId, 2);
  verifyPlan(input, result);
});

test('наполнения расходуют один общий запас пустых ящиков', () => {
  const input = { crates: [crate(1, 5, [{ item: 11, count: 1 }, { item: 12, count: 1 }])],
    items: { 1: [[1, 1]], 11: [[1, 10]], 12: [[1, 10]] }, balance: 0, target: 10 };
  const result = solve(input);
  assert.equal(result.status, 'insufficientData');
  assert.equal(result.availableFavor, 5);
  verifyPlan(input, result);
});

test('учитывает каждый уровень цены и полное количество предметов', () => {
  const input = { crates: [crate(1, 5, [{ item: 11, count: 2 }], { returnCopper: 10 })],
    items: { 1: [[100, 2], [1, 1]], 11: [[10, 5], [2, 3]] }, balance: 0, target: 15 };
  const result = solve(input);
  assert.equal(result.grossCopper, 237);
  assert.equal(result.totalReturnCopper, 30);
  assert.equal(result.netCopper, 207);
  verifyPlan(input, result);
});

test('переключает наполнение после исчерпания дешёвых единиц', () => {
  const input = { crates: [crate(1, 5, [{ item: 11, count: 1 }, { item: 12, count: 1 }])],
    items: { 1: [[1, 3]], 11: [[1, 1], [100, 2]], 12: [[5, 3]] }, balance: 0, target: 15 };
  const result = solve(input);
  assert.equal(result.netCopper, 14);
  assert.deepEqual(result.lines.map(line => [line.item, line.crates]), [[11, 1], [12, 2]]);
  verifyPlan(input, result);
});

test('объединяет одинаковую Favor по предельным затратам разных типов', () => {
  const input = { crates: [crate(1), crate(2)], items: {
    1: [[1, 1], [10, 2]], 1001: [[1, 3]], 2: [[2, 3]], 1002: [[2, 3]]
  }, balance: 0, target: 15 };
  const result = solve(input);
  assert.equal(result.netCopper, 10);
  assert.deepEqual(result.lines.map(line => [line.crateId, line.crates]), [[1, 1], [2, 2]]);
  verifyPlan(input, result);
});

test('отрицательная стоимость не разрешает лишний фарм после достижения цели', () => {
  const input = { crates: [crate(1, 5, undefined, { returnCopper: 10 }), crate(2, 40)],
    items: { 1: [[1, 20]], 1001: [[1, 20]], 2: [[100, 1]], 1002: [[100, 1]] }, balance: 0, target: 5 };
  const result = solve(input);
  assert.equal(result.netCopper, -8);
  assert.equal(result.crateCount, 1);
  assert.equal(result.totalFavor, 5);
  verifyPlan(input, result);
});

test('отрицательный крупный ящик можно взять дважды только если цель ещё не достигнута', () => {
  const input = { crates: [crate(1, 5, undefined, { returnCopper: 7 }), crate(2, 10, undefined, { returnCopper: 102 })],
    items: { 1: [[1, 10]], 1001: [[1, 10]], 2: [[1, 10]], 1002: [[1, 10]] }, balance: 0, target: 11 };
  const result = solve(input);
  assert.equal(result.netCopper, -200);
  assert.equal(result.crateCount, 2);
  assert.equal(result.totalFavor, 20);
  verifyPlan(input, result);
});

test('разрешает переполнение цели последним крупным ящиком', () => {
  const input = { crates: [crate(1, 40, undefined, { returnCopper: 20 })],
    items: { 1: [[1, 10]], 1001: [[1, 10]] }, balance: 0, target: 1 };
  const result = solve(input);
  assert.equal(result.totalFavor, 40);
  assert.equal(result.crateCount, 1);
  assert.equal(result.netCopper, -18);
  verifyPlan(input, result);
});

test('нулевая и достигнутая цели не создают покупок даже при отрицательной цене', () => {
  const base = { crates: [crate(1, 5, undefined, { returnCopper: 20 })], items: { 1: [[1, 2]], 1001: [[1, 2]] }, balance: 10 };
  for (const target of [0, 10]) {
    const input = { ...base, target }, result = solve(input);
    assert.equal(result.status, 'alreadyEnough');
    assert.equal(result.availableFavor, 10);
    verifyPlan(input, result);
  }
});

test('неизвестный возврат учитывается как ноль и отмечается числом ящиков', () => {
  const input = { crates: [crate(1, 20, undefined, { returnCopper: null })],
    items: { 1: [[3, 2]], 1001: [[4, 2]] }, balance: 5, target: 30 };
  const result = solve(input);
  assert.equal(result.deficit, 25);
  assert.equal(result.unknownReturnCount, 2);
  assert.equal(result.totalReturnCopper, 0);
  assert.equal(result.netCopper, 14);
  verifyPlan(input, result);
});

test('учитывает уровень персонажа и значение по умолчанию 60', () => {
  const input = { crates: [crate(1, 20, undefined, { level: 60 })],
    items: { 1: [[1, 1]], 1001: [[1, 1]] }, balance: 0, target: 10 };
  assert.equal(solve({ ...input, level: 59 }).availableFavor, 0);
  assert.equal(solve({ ...input, level: 59 }).status, 'insufficientData');
  assert.equal(solve(input).status, 'ready');
});

test('пустые или отсутствующие цены означают недоступность, а не нулевую цену', () => {
  for (const items of [{}, { 1: [] }, { 1: [[1, 2]], 1001: [] }, { 1001: [[1, 2]] }]) {
    const input = { crates: [crate(1)], items, balance: 0, target: 1 }, result = solve(input);
    assert.equal(result.status, 'insufficientData');
    assert.equal(result.availableFavor, 0);
    verifyPlan(input, result);
  }
});

test('при нехватке снимка не выделяет массив по огромной ручной цели', () => {
  const input = { crates: [crate(1)], items: { 1: [[1, 2]], 1001: [[1, 2]] }, balance: 0, target: Number.MAX_SAFE_INTEGER };
  const result = solve(input);
  assert.equal(result.status, 'insufficientData');
  assert.equal(result.availableFavor, 10);
  verifyPlan(input, result);
});

test('запрещает общие itemID, повторяющиеся ящики и совпадение ящика с наполнением', () => {
  const invalid = [
    [crate(1, 5, [{ item: 11, count: 1 }]), crate(2, 10, [{ item: 11, count: 2 }])],
    [crate(1), crate(1)],
    [crate(1, 5, [{ item: 2, count: 1 }]), crate(2)],
    [crate(1, 5, [{ item: 1, count: 1 }])]
  ];
  for (const crates of invalid) assert.throws(() => solve({ crates, items: {}, balance: 0, target: 1 }), /повторяется/);
});

test('проверяет числовые данные и выдаёт русские ошибки', () => {
  const base = { crates: [crate(1)], items: { 1: [[1, 1]], 1001: [[1, 1]] }, balance: 0, target: 1 };
  for (const patch of [{ balance: -1 }, { balance: NaN }, { target: 1.5 }, { target: Infinity }, { level: 0 }, { level: 61 }, { items: null }, { crates: null }]) {
    assert.throws(() => solve({ ...base, ...patch }), /[А-Яа-я]/);
  }
  for (const patch of [{ favor: 7 }, { returnCopper: -1 }, { level: 61 }, { bundles: [{ item: 11, count: 0 }] }]) {
    assert.throws(() => solve({ ...base, crates: [crate(1, 5, undefined, patch)] }), /[А-Яа-я]/);
  }
  for (const levels of [null, [[0, 1]], [[1, 0]], [[1.1, 1]], [[1, 1, 1]]]) {
    assert.throws(() => solve({ ...base, items: { ...base.items, 1: levels } }), /[А-Яа-я]/);
  }
});

test('останавливается до потери точности целой меди и количества', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const base = { crates: [crate(1)], balance: 0, target: 5 };
  assert.throws(() => solve({ ...base, items: { 1: [[maximum, 1]], 1001: [[1, 1]] } }), /слишком велики/);
  assert.throws(() => solve({ ...base, items: { 1: [[1, maximum]], 1001: [[1, maximum]] } }), /слишком велики/);
  assert.throws(() => solve({ ...base, crates: [crate(1, 5, [{ item: 11, count: 2 }])], items: { 1: [[1, 1]], 11: [[maximum, 2]] } }), /слишком велики/);
  assert.throws(() => solve({ ...base, target: 10, crates: [crate(1, 5, undefined, { returnCopper: maximum })], items: { 1: [[1, 2]], 1001: [[1, 2]] } }), /слишком велики/);
});

test('не изменяет входные массивы цен и каталог', () => {
  const input = { crates: [crate(1, 5, [{ item: 11, count: 2 }, { item: 12, count: 1 }])],
    items: { 1: [[9, 2], [1, 1]], 11: [[7, 4], [2, 2]], 12: [[4, 3]] }, balance: 0, target: 10 };
  const before = JSON.stringify(input);
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(input);
  verifyPlan(input, solve(input));
  assert.equal(JSON.stringify(input), before);
});

test('1000 случайных случаев совпадают с полным перебором всех наполнений и первого достижения', () => {
  let seed = 629133;
  function random(limit) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * limit); }
  function levels(units) {
    const rows = [];
    while (units) { const amount = 1 + random(units); rows.push([1 + random(20), amount]); units -= amount; }
    return rows;
  }
  for (let trial = 0; trial < 1000; trial += 1) {
    const input = { crates: [], items: {}, balance: random(20), target: random(100), level: 1 + random(60) };
    for (let index = 0, count = 1 + random(3); index < count; index += 1) {
      const id = 100 + index, bundles = [];
      for (let variant = 0, count = 1 + random(2); variant < count; variant += 1) {
        const item = 1000 + index * 10 + variant;
        bundles.push({ item, count: 1 + random(3) });
        input.items[item] = levels(random(7));
      }
      input.crates.push(crate(id, [5, 10, 15, 20, 30, 40][random(6)], bundles,
        { returnCopper: random(7) ? random(60) : null, level: 1 + random(60) }));
      input.items[id] = levels(random(4));
    }
    const expected = oracle(input), actual = solve(input);
    assert.equal(actual.status, expected.status, `Статус, пример ${trial}`);
    assert.equal(actual.availableFavor, expected.availableFavor, `Запас, пример ${trial}`);
    assert.equal(actual.netCopper, expected.net, `Минимум, пример ${trial}: ${JSON.stringify(input)}`);
    verifyPlan(input, actual);
  }
});

test('точно рассчитывает цель 30000 Favor без низкого ограничения', () => {
  const input = { crates: [], items: {}, balance: 0, target: 30000 };
  for (const [index, favor] of [5, 10, 15, 20, 30, 40].entries()) {
    const id = 100 + index;
    input.crates.push(crate(id, favor));
    input.items[id] = [[1, 6000]]; input.items[id + 1000] = [[1, 6000]];
  }
  const result = solve(input);
  assert.equal(result.totalFavor, 30000);
  assert.equal(result.netCopper, 1500);
  assert.equal(result.crateCount, 750);
});

test('использует фактический опубликованный запас, а не жёсткий предел 1500', () => {
  const input = { crates: [crate(1)], items: { 1: [[1, 1600]], 1001: [[1, 1600]] }, balance: 0, target: 8000 };
  const result = solve(input);
  assert.equal(result.crateCount, 1600);
  assert.equal(result.totalFavor, 8000);
  assert.equal(result.netCopper, 3200);
});
