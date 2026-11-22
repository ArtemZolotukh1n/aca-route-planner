(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ACAFavor = api;
})(globalThis, function () {
  'use strict';

  const FAVORS = [5, 10, 15, 20, 30, 40];

  function fail(message) { throw new Error(message); }
  function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function exact(value) {
    if (!Number.isSafeInteger(value)) fail('Числа слишком велики для точного расчёта стоимости и количества.');
    return value;
  }
  function array(Type, size, fill = 0) {
    try { return new Type(size).fill(fill); }
    catch (error) {
      if (error instanceof RangeError) fail('Для такой цели браузеру не хватает памяти для точного расчёта.');
      throw error;
    }
  }

  class Heap {
    constructor(compare) { this.values = []; this.compare = compare; }
    push(value) {
      const values = this.values;
      let index = values.length;
      values.push(value);
      while (index) {
        const parent = (index - 1) >> 1;
        if (this.compare(values[parent], value) <= 0) break;
        values[index] = values[parent]; index = parent;
      }
      values[index] = value;
    }
    pop() {
      const values = this.values;
      if (!values.length) return null;
      const first = values[0], last = values.pop();
      if (values.length) {
        let index = 0;
        while (index * 2 + 1 < values.length) {
          let child = index * 2 + 1;
          if (child + 1 < values.length && this.compare(values[child + 1], values[child]) < 0) child += 1;
          if (this.compare(last, values[child]) <= 0) break;
          values[index] = values[child]; index = child;
        }
        values[index] = last;
      }
      return first;
    }
  }

  function priceLevels(value) {
    if (value === undefined) return { levels: [], units: 0 };
    if (!Array.isArray(value)) fail('Некорректные уровни цен предмета.');
    let units = 0;
    const levels = value.map(level => {
      if (!Array.isArray(level) || level.length !== 2 || !integer(level[0], 1) || !integer(level[1], 1)) {
        fail('Цена и количество предмета должны быть положительными целыми числами.');
      }
      units = exact(units + level[1]);
      return [...level];
    }).sort((a, b) => a[0] - b[0]);
    return { levels, units };
  }

  function prepare(crates, items, level) {
    const owners = new Map();
    for (const crate of crates) {
      if (!object(crate) || !integer(crate.id, 1) || !integer(crate.level, 1) || crate.level > 60 ||
          !FAVORS.includes(crate.favor) || !Array.isArray(crate.bundles) ||
          (crate.returnCopper !== null && !integer(crate.returnCopper))) {
        fail('Некорректные данные ящика, награды или требуемого уровня.');
      }
      for (const id of [crate.id, ...crate.bundles.map(bundle => {
        if (!object(bundle) || !integer(bundle.item, 1) || !integer(bundle.count, 1)) {
          fail('Некорректный предмет или количество для наполнения ящика.');
        }
        return bundle.item;
      })]) {
        if (owners.has(id)) fail('Предмет повторяется в каталоге ящиков: независимый расчёт запасов невозможен.');
        owners.set(id, crate.id);
      }
    }
    const models = [];
    let availableFavor = 0;
    for (const crate of crates) {
      if (crate.level > level) continue;
      const empty = priceLevels(items[crate.id]);
      const bundles = crate.bundles.map(bundle => ({ ...bundle, ...priceLevels(items[bundle.item]) }));
      let fillCapacity = 0;
      for (const bundle of bundles) {
        const capacity = Math.floor(bundle.units / bundle.count);
        fillCapacity = capacity >= empty.units - fillCapacity ? empty.units : fillCapacity + capacity;
      }
      const capacity = Math.min(empty.units, fillCapacity);
      availableFavor = exact(availableFavor + exact(capacity * crate.favor));
      if (capacity) models.push({ ...crate, empty, bundles, capacity });
    }
    return { models, availableFavor };
  }

  function cursor(levels) {
    let index = 0, used = 0;
    return count => {
      let cost = 0;
      while (count) {
        const [unit, quantity] = levels[index];
        const take = Math.min(count, quantity - used);
        cost = exact(cost + exact(unit * take));
        count -= take; used += take;
        if (used === quantity) { index += 1; used = 0; }
      }
      return cost;
    };
  }

  function crateGenerator(crate) {
    const fills = new Heap((a, b) => a.cost - b.cost || a.bundle.item - b.bundle.item);
    const emptyCost = cursor(crate.empty.levels);
    let generated = 0;
    function nextFill(bundle) {
      if (!bundle.remaining) return;
      bundle.remaining -= 1;
      fills.push({ bundle, cost: bundle.cost(bundle.count) });
    }
    for (const bundle of crate.bundles) {
      nextFill({ ...bundle, remaining: Math.floor(bundle.units / bundle.count), cost: cursor(bundle.levels) });
    }
    return {
      next() {
        if (generated === crate.capacity) return null;
        const fill = fills.pop();
        const grossCopper = exact(emptyCost(1) + fill.cost);
        const returnCopper = crate.returnCopper ?? 0;
        const event = {
          crateId: crate.id, item: fill.bundle.item, countPerCrate: fill.bundle.count,
          grossCopper, returnCopper, netCopper: exact(grossCopper - returnCopper),
          favor: crate.favor, unknown: crate.returnCopper === null
        };
        generated += 1;
        if (generated < crate.capacity) nextFill(fill.bundle);
        return event;
      }
    };
  }

  function groupsFor(models, target) {
    const groups = [];
    for (const favor of FAVORS) {
      const relevant = models.filter(crate => crate.favor === favor);
      if (!relevant.length) continue;
      const weight = favor / 5;
      const heap = new Heap((a, b) => a.event.netCopper - b.event.netCopper ||
        a.event.crateId - b.event.crateId || a.event.item - b.event.item);
      let capacity = 0;
      for (const crate of relevant) {
        capacity = exact(capacity + crate.capacity);
        const generator = crateGenerator(crate);
        heap.push({ generator, event: generator.next() });
      }
      // Even with negative costs, first attainment never needs more than this many of one yield.
      const limit = Math.min(capacity, Math.ceil(target / weight));
      const costs = array(Float64Array, limit + 1), events = [];
      for (let count = 1; count <= limit; count += 1) {
        const entry = heap.pop();
        events.push(entry.event);
        costs[count] = exact(costs[count - 1] + entry.event.netCopper);
        if (count < limit) {
          const event = entry.generator.next();
          if (event) heap.push({ generator: entry.generator, event });
        }
      }
      groups.push({ weight, costs, events });
    }
    return groups;
  }

  function lowerBound(values, target) {
    let left = 0, right = values.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (values[mid] < target) left = mid + 1; else right = mid;
    }
    return left;
  }

  function upperBound(values, target) {
    let left = 0, right = values.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (values[mid] <= target) left = mid + 1; else right = mid;
    }
    return left;
  }

  function convolve(previous, costs, weight) {
    const target = previous.length, capacity = costs.length - 1;
    const result = array(Float64Array, target + weight, Infinity);
    const choices = array(Float64Array, target + weight, -1);
    for (let residue = 0; residue < weight; residue += 1) {
      const columns = [], rows = [];
      for (let index = 0; residue + weight * index < target; index += 1) {
        if (Number.isFinite(previous[residue + weight * index])) columns.push(index);
      }
      if (!columns.length) continue;
      for (let index = 0; residue + weight * index < result.length; index += 1) {
        const low = lowerBound(columns, index - capacity), high = upperBound(columns, index) - 1;
        if (low <= high) rows.push({ index, low, high });
      }
      // Convex costs make this banded matrix Monge; its leftmost minima are monotone.
      function search(left, right, optionLeft, optionRight) {
        if (left > right) return;
        const middle = Math.floor((left + right) / 2), row = rows[middle];
        const low = Math.max(optionLeft, row.low), high = Math.min(optionRight, row.high);
        let best = Infinity, chosen = -1;
        for (let option = low; option <= high; option += 1) {
          const column = columns[option];
          const cost = exact(previous[residue + weight * column] + costs[row.index - column]);
          if (cost < best) { best = cost; chosen = option; }
        }
        if (chosen < 0) fail('Не удалось восстановить точный расчёт доступных ящиков.');
        const position = residue + weight * row.index;
        result[position] = best; choices[position] = row.index - columns[chosen];
        search(left, middle - 1, optionLeft, chosen);
        search(middle + 1, right, chosen, optionRight);
      }
      search(0, rows.length - 1, 0, columns.length - 1);
    }
    return { costs: result, choices };
  }

  function emptyResult(status, deficit, availableFavor) {
    return {
      status, deficit, availableFavor, totalFavor: 0, totalReturnCopper: 0,
      grossCopper: 0, netCopper: 0, crateCount: 0, unknownReturnCount: 0, lines: []
    };
  }

  function solve(input) {
    if (!object(input)) fail('Не заданы данные для расчёта Merchant’s Favor.');
    const { crates, items, balance, target, level = 60 } = input;
    if (!Array.isArray(crates) || !object(items)) fail('Нужны каталог ящиков и уровни цен предметов.');
    if (!integer(balance) || !integer(target)) fail('Баланс и цель должны быть неотрицательными целыми числами.');
    if (!integer(level, 1) || level > 60) fail('Уровень персонажа должен быть целым числом от 1 до 60.');
    const deficit = Math.max(0, target - balance);
    const { models, availableFavor } = prepare(crates, items, level);
    if (!deficit) return emptyResult('alreadyEnough', deficit, availableFavor);
    // Check the complete retained supply before allocating arrays proportional to the goal.
    if (availableFavor < deficit) return emptyResult('insufficientData', deficit, availableFavor);
    const goal = Math.ceil(deficit / 5), groups = groupsFor(models, goal);
    let previous = array(Float64Array, goal, Infinity);
    previous[0] = 0;
    const history = [];
    let best = Infinity, bestPosition = Infinity, bestStage = -1;
    for (let stage = 0; stage < groups.length; stage += 1) {
      const group = groups[stage];
      const next = convolve(previous, group.costs, group.weight);
      history.push(next.choices);
      for (let position = goal; position < next.costs.length; position += 1) {
        const cost = next.costs[position];
        if (cost < best || (cost === best && Number.isFinite(cost) && position < bestPosition)) {
          best = cost; bestPosition = position; bestStage = stage;
        }
      }
      // A terminal plan cannot buy another crate, even when its net cost would be negative.
      previous = next.costs.slice(0, goal);
    }
    if (bestStage < 0) fail('Не удалось составить план по доступным данным снимка.');
    const counts = new Array(groups.length).fill(0);
    let position = bestPosition;
    for (let stage = bestStage; stage >= 0; stage -= 1) {
      const count = history[stage][position];
      if (count < 0) fail('Не удалось восстановить точный план покупок.');
      counts[stage] = count; position -= count * groups[stage].weight;
    }
    const result = emptyResult('ready', deficit, availableFavor), lines = new Map();
    for (let stage = 0; stage < groups.length; stage += 1) {
      for (let index = 0; index < counts[stage]; index += 1) {
        const event = groups[stage].events[index], key = `${event.crateId}:${event.item}`;
        if (!lines.has(key)) lines.set(key, {
          crateId: event.crateId, item: event.item, countPerCrate: event.countPerCrate,
          crates: 0, itemCount: 0, grossCopper: 0, returnCopper: 0, netCopper: 0, favor: 0
        });
        const line = lines.get(key);
        line.crates += 1;
        line.itemCount = exact(line.itemCount + event.countPerCrate);
        for (const field of ['grossCopper', 'returnCopper', 'netCopper', 'favor']) {
          line[field] = exact(line[field] + event[field]);
        }
        result.unknownReturnCount += event.unknown ? 1 : 0;
      }
    }
    // Completing rows in this order leaves a maximum-yield crate for the final turn-in.
    result.lines = [...lines.values()].sort((a, b) => a.favor / a.crates - b.favor / b.crates ||
      a.crateId - b.crateId || a.item - b.item);
    for (const line of result.lines) {
      result.crateCount = exact(result.crateCount + line.crates);
      result.totalFavor = exact(result.totalFavor + line.favor);
      result.totalReturnCopper = exact(result.totalReturnCopper + line.returnCopper);
      result.grossCopper = exact(result.grossCopper + line.grossCopper);
      result.netCopper = exact(result.netCopper + line.netCopper);
    }
    return result;
  }

  return Object.freeze({ solve });
});
