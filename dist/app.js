'use strict';

(async () => {
  const $ = selector => document.querySelector(selector);
  const STORAGE_KEY = 'aca-local-profiles-v2';
  const LEGACY_KEY = 'aca-local-planner-v1';
  const PRICE_KEY = 'aca-local-prices-v1';
  const REP = { JOURNEYMAN: 75, EXPERT: 125, ARTISAN: 200 };
  const RANKS = [
    { start: 0, end: 3000, name: 'Нейтрально', english: 'Neutral' },
    { start: 3000, end: 9000, name: 'Дружелюбие', english: 'Friendly' },
    { start: 9000, end: 21000, name: 'Уважение', english: 'Honored' },
    { start: 21000, end: 42000, name: 'Почтение', english: 'Revered' },
    { start: 42000, end: 43000, name: 'Превознесение', english: 'Exalted' },
  ];
  const ESCAPE = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const FORMAT = value => Math.round(value).toLocaleString('ru-RU');
  const GOLD = copper => `${(copper / 10000).toFixed(2).replace('.', ',')}g`;
  const COORDS = point => `${point.x.toFixed(1)}, ${point.y.toFixed(1)}`;
  const ordersText = count => `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'заказ' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'заказа' : 'заказов'}`;
  const counted = (count, forms) => `${FORMAT(count)} ${forms[count % 10 === 1 && count % 100 !== 11 ? 0 : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 1 : 2]}`;
  const POUCH_COPPER = { JOURNEYMAN: 1200, EXPERT: 3600, ARTISAN: 7456 };
  let toastTimer;

  function toast(message) {
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3200);
  }

  try {
    const files = ['data.json', 'maps.json', 'routes.json', 'geography.json', 'overview-maps.json', 'route-audits.json', 'prices.json'];
    const [data, maps, routeData, geography, overviewMaps, audits, embeddedPrices] = await Promise.all(files.map(async name => {
      if (window.ACA_ASSETS) return window.ACA_ASSETS[name];
      const response = await fetch(name);
      if (!response.ok) throw new Error(`Не удалось загрузить ${name}`);
      return response.json();
    }));
    const routes = routeData.routes;
    const routesById = new Map(routes.map(route => [route.id, route]));
    const mapConfigs = new Map();
    function readSaved(key) {
      try { return JSON.parse(localStorage.getItem(key)); }
      catch { return null; }
    }
    function saveValue(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); }
      catch { $('#storage-warning').hidden = false; }
    }
    const planner = window.ACAPlanner.createContext({ writs: data.writs, routes });
    const store = planner.restoreStore(readSaved(STORAGE_KEY), readSaved(LEGACY_KEY));
    let state = store.profiles.find(profile => profile.id === store.activeProfileId);
    const priceCache = readSaved(PRICE_KEY);
    let prices = window.ACAPrices.chooseSnapshot(embeddedPrices, priceCache?.snapshot);
    let lastCheckedAt = Number.isFinite(priceCache?.lastCheckedAt) && priceCache.lastCheckedAt <= Date.now() ? priceCache.lastCheckedAt : 0;
    let refreshingPrices = false;
    let priceStatus = '';
    if (location.hash && ['route', 'shopping', 'catalog'].includes(location.hash.slice(1))) state.view = location.hash.slice(1);

    function persist() {
      saveValue(STORAGE_KEY, store);
    }

    function renderProfiles() {
      $('#profile-picker').innerHTML = store.profiles.map(profile => `<option value="${ESCAPE(profile.id)}">${ESCAPE(profile.name)}</option>`).join('');
      $('#profile-picker').value = state.id;
    }

    function renderAll() {
      renderProfiles();
      $('#catalog-search').value = state.query;
      renderRoute(); renderShopping(); renderCatalog(); showView(state.view);
    }

    function activateProfile(profile) {
      state = profile;
      store.activeProfileId = profile.id;
      renderAll();
      persist();
    }

    function confirmAction(title, message, label) {
      const dialog = $('#confirm-dialog');
      $('#confirm-title').textContent = title;
      $('#confirm-message').textContent = message;
      $('#confirm-action').textContent = label;
      dialog.returnValue = 'cancel';
      return new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
        dialog.showModal();
      });
    }

    function renderPriceStatus() {
      const age = Math.max(0, Math.floor((Date.now() - Date.parse(prices.meta.snapshot)) / 3600000));
      $('#price-snapshot').textContent = `Снимок: ${prices.meta.snapshotLabel}${age >= 1 ? ` · ${counted(age, ['час', 'часа', 'часов'])} назад` : ''}`;
      $('#price-snapshot').classList.toggle('stale-price', age >= 24);
      $('#price-checked').textContent = lastCheckedAt ? `Проверено: ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(lastCheckedAt)} МСК` : 'Сохранённый снимок. Интернет нужен только для обновления цен.';
      $('#price-status').textContent = priceStatus;
      $('#refresh-prices').disabled = refreshingPrices;
      $('#refresh-prices').textContent = refreshingPrices ? 'Проверяю цены…' : 'Обновить цены';
      $('#price-source').href = window.ACAPrices.SOURCE_URL;
    }

    async function refreshPrices(manual = false) {
      if (refreshingPrices) return;
      refreshingPrices = true;
      priceStatus = 'Проверяю опубликованный снимок аукциона…';
      renderPriceStatus();
      try {
        const next = await window.ACAPrices.fetchLatest(data.writs);
        const difference = Date.parse(next.meta.snapshot) - Date.parse(prices.meta.snapshot);
        lastCheckedAt = Date.now();
        if (difference > 0) {
          prices = next;
          const available = data.writs.filter(writ => prices.pairs[writ.quest]?.[2] != null).length;
          priceStatus = `Цены обновлены. Полная цена есть для ${available} из ${data.writs.length} заказов.`;
          renderAll();
        } else priceStatus = difference === 0 ? 'Новых данных пока нет: источник публикует снимки примерно раз в час.' : 'Источник вернул более старый снимок. Сохранил действующие цены.';
        saveValue(PRICE_KEY, { snapshot: prices, lastCheckedAt });
        if (manual) toast(difference > 0 ? 'Цены обновлены' : 'Проверка цен завершена');
      } catch (error) {
        priceStatus = `Обновить цены не удалось. Сохранённый снимок продолжает работать. ${error.message || 'Проверь подключение к интернету.'}`;
      } finally {
        refreshingPrices = false;
        renderPriceStatus();
      }
    }

    function currentRoute() { return routesById.get(state.routeId); }

    function selectedBranches(route = currentRoute()) { return new Set(state.branches[route.id] || []); }

    function activeSteps(route = currentRoute()) {
      const selected = selectedBranches(route);
      return route.steps.filter(step => {
        if (step.branch && !selected.has(step.branch)) return false;
        if (step.unless && selected.has(step.unless)) return false;
        const definition = route.branches.find(branch => branch.id === step.branch);
        return !definition?.requires || selected.has(definition.requires);
      });
    }

    function stopKeys(route = currentRoute()) {
      return [...new Set(activeSteps(route).filter(step => step.stop).map(step => step.stop))];
    }

    function activeOrders(route = currentRoute()) {
      const keys = new Set(stopKeys(route));
      return data.writs.filter(writ => keys.has(writ.turnIn));
    }

    function routeEconomy(rows) {
      let copper = 0;
      let priced = 0;
      const counts = { JOURNEYMAN: 0, EXPERT: 0, ARTISAN: 0 };
      for (const writ of rows) {
        counts[writ.tier] += 1;
        const pair = prices.pairs[String(writ.quest)];
        if (pair?.[2] != null) { copper += pair[2]; priced += 1; }
      }
      const returnCopper = Object.entries(counts).reduce((sum, [tier, count]) => sum + count * POUCH_COPPER[tier], 0);
      return { copper, priced, counts, returnCopper };
    }

    function roundRep() {
      return planner.earnedRep(state);
    }

    function estimatedRep() { return planner.totalRep(state); }

    function currentRank(total = estimatedRep() ?? Math.max(0, state.baseline + state.bankedRep + roundRep())) { return RANKS.find(rank => total < rank.end) || RANKS.at(-1); }

    function updateSummary() {
      const total = estimatedRep();
      const remaining = total === null ? null : Math.max(0, state.goal - total);
      const rank = currentRank();
      const goal = RANKS.find(rank => rank.start === state.goal);
      const route = currentRoute();
      const rows = activeOrders(route);
      const routeRep = rows.reduce((sum, writ) => sum + REP[writ.tier], 0);
      $('#goal-name').textContent = goal.english;
      $('#standing').textContent = total === null ? 'Репутация не задана' : `${rank.name} · ${rank.english} · ${FORMAT(total - rank.start)} / ${FORMAT(rank.end - rank.start)}`;
      $('#remaining').textContent = remaining === null ? '—' : FORMAT(remaining);
      $('#goal-caption').textContent = remaining === null ? 'Укажи репутацию из игры' : remaining ? `${counted(Math.ceil(remaining / routeRep), ['круг', 'круга', 'кругов'])} по ${ordersText(rows.length)} · ${FORMAT(routeRep)} реп. за круг` : `${goal.english} достигнут по расчёту`;
      $('#rep-progress').max = state.goal;
      $('#rep-progress').value = Math.min(state.goal, total ?? 0);
      $('#rep-progress').setAttribute('aria-label', `Расчётный прогресс до ${goal.english}`);
      $('#reputation-notice').hidden = state.reputationConfirmed;
      $('#reputation-notice').textContent = state.needsReputationReview ? 'Старое сохранение перенесено. Проверь имя и репутацию в настройках персонажа.' : 'Настрой персонажа, чтобы считать оставшуюся репутацию.';
      $('#round-status').textContent = `Набор ${state.round} · ${counted(state.delivered.length, ['сдача', 'сдачи', 'сдач'])} · +${FORMAT(roundRep())} реп.`;
      $('#next-round').disabled = state.delivered.length === 0;
      const economics = routeEconomy(rows);
      $('#shopping-status').innerHTML = `<span>Заказы: ${rows.filter(w => state.writReady.includes(w.quest)).length}/${rows.length}</span><span>Предметы: ${rows.filter(w => state.itemReady.includes(w.quest)).length}/${rows.length}</span><span>Сдано в этом наборе: ${state.delivered.length}</span><span class="price-chip">Оценка закупки: ${economics.priced === rows.length ? GOLD(economics.copper) : 'неполная'}</span>`;
    }

    function table(rows) {
      return `<div class="table-wrap"><table class="orders-table"><thead><tr><th scope="col">Заказ</th><th scope="col">Готовый предмет</th><th scope="col" class="price-cell">Аукцион*</th><th scope="col" class="check-cell">Заказ куплен</th><th scope="col" class="check-cell">Предмет готов</th><th scope="col" class="check-cell">Сдано</th></tr></thead><tbody>${rows.map(writ => {
        const point = data.turns[writ.turnIn];
        const pair = prices.pairs[String(writ.quest)];
        const cost = pair?.[2] == null ? '—' : GOLD(pair[2]);
        const labels = { writReady: 'Заказ куплен', itemReady: 'Предмет готов', delivered: 'Сдано' };
        const questUrl = `https://db.icy-veins.com/wow-forever/quests/${writ.quest}`;
        return `<tr class="${state.delivered.includes(writ.quest) ? 'delivered' : ''}"><td class="order-name"><a href="${questUrl}" target="_blank" rel="noopener noreferrer">${ESCAPE(`Craftsman's Writ: ${writ.name}`)}</a><small>${point ? `${ESCAPE(point.name)} · ${ESCAPE(data.maps[point.map][1])} · ${COORDS(point)}` : 'Получатель не подтверждён'} · +${REP[writ.tier]}</small></td><td class="item-name">${ESCAPE(writ.name)} × ${FORMAT(writ.count)}<small>${writ.tier === 'JOURNEYMAN' ? 'Journeyman' : writ.tier === 'EXPERT' ? 'Expert' : 'Artisan'}</small></td><td class="price-cell">${cost}<small>writ + предмет</small></td>${Object.entries(labels).map(([kind, label]) => `<td class="check-cell"><label class="check-label"><input type="checkbox" data-kind="${kind}" data-quest="${writ.quest}" ${state[kind].includes(writ.quest) ? 'checked' : ''} aria-label="${label}: ${ESCAPE(writ.name)}"><span class="check-caption">${label}</span></label></td>`).join('')}</tr>`;
      }).join('')}</tbody></table></div>`;
    }

    function renderRoutePicker() {
      $('#route-picker').innerHTML = routes.map(route => `<option value="${route.id}">${ESCAPE(route.choice)}</option>`).join('');
      $('#route-picker').value = state.routeId;
      const route = currentRoute();
      $('#route-options').innerHTML = route.branches.map(branch => {
        const selected = selectedBranches(route).has(branch.id);
        const disabled = branch.requires && !selectedBranches(route).has(branch.requires);
        const without = new Set(state.branches[route.id] || []);
        without.delete(branch.id);
        if (branch.requires) without.add(branch.requires);
        const prior = routeEconomyForBranches(route, without);
        const withBranch = new Set(state.branches[route.id] || []);
        withBranch.add(branch.id);
        if (branch.requires) withBranch.add(branch.requires);
        const after = routeEconomyForBranches(route, withBranch);
        const deltaRep = after.rep - prior.rep;
        const previousQuests = new Set(prior.rows.map(writ => writ.quest));
        const addedRows = after.rows.filter(writ => !previousQuests.has(writ.quest));
        const addedCost = routeEconomy(addedRows);
        const delta = addedRows.length ? `+${FORMAT(Math.max(0, deltaRep))} реп. · ${addedCost.priced === addedRows.length ? GOLD(addedCost.copper) : 'цена неполная'} по снимку` : 'Без новых заказов';
        return `<label class="route-option"><input type="checkbox" data-branch="${ESCAPE(branch.id)}" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span><strong>${ESCAPE(branch.label)}</strong><small>${ESCAPE(branch.description)}<br><b>${delta}</b></small></span></label>`;
      }).join('');
    }

    function routeEconomyForBranches(route, branches) {
      const steps = route.steps.filter(step => {
        if (step.branch && !branches.has(step.branch)) return false;
        if (step.unless && branches.has(step.unless)) return false;
        const definition = route.branches.find(branch => branch.id === step.branch);
        return !definition?.requires || branches.has(definition.requires);
      });
      const keys = new Set(steps.filter(step => step.stop).map(step => step.stop));
      const rows = data.writs.filter(writ => keys.has(writ.turnIn));
      return { rows, rep: rows.reduce((sum, writ) => sum + REP[writ.tier], 0), economy: routeEconomy(rows) };
    }

    function rowsInOrder(rows, keys) {
      const position = new Map(keys.map((key, index) => [key, index]));
      return [...rows].sort((a, b) => position.get(a.turnIn) - position.get(b.turnIn) || a.quest - b.quest);
    }

    function renderStops() {
      const route = currentRoute();
      const keys = stopKeys(route);
      const rows = activeOrders(route);
      $('#route-stops').innerHTML = keys.map((key, index) => {
        const point = data.turns[key];
        const orders = rows.filter(writ => writ.turnIn === key);
        const done = orders.filter(writ => state.delivered.includes(writ.quest)).length;
        return `<li><button type="button" class="stop-button ${done === orders.length ? 'is-done' : ''}" data-stop="${ESCAPE(key)}" aria-pressed="${state.selectedStop === key}"><span class="stop-number">${done === orders.length ? '✓' : index + 1}</span><span class="stop-text"><strong>${ESCAPE(point.name)}</strong><small>${ESCAPE(data.maps[point.map][1])} · ${done}/${orders.length}</small></span></button></li>`;
      }).join('');
      $('#route-stop-select').innerHTML = keys.map((key, index) => {
        const point = data.turns[key];
        return `<option value="${ESCAPE(key)}">${index + 1}. ${ESCAPE(point.name)} · ${ESCAPE(data.maps[point.map][1])}</option>`;
      }).join('');
      $('#route-stop-select').value = state.selectedStop;
    }

    function pointForStep(step) {
      if (step.stop) return data.turns[step.stop] ? { ...data.turns[step.stop], kind: 'stop', key: step.stop, label: data.turns[step.stop].name } : null;
      if (step.hub) {
        const point = geography.hubs[step.hub];
        return point ? { ...point, kind: 'hub', key: step.hub, label: point.name } : null;
      }
      if (step.at) return { map: step.at[0], x: step.at[1], y: step.at[2], kind: 'pass', label: step.label || 'Переход' };
      return null;
    }

    function toContinent(point) {
      const zone = geography.zones[String(point.map)];
      if (!zone) return null;
      const [left, top, right, bottom] = zone.box;
      return { x: left + point.x / 100 * (right - left), y: top + point.y / 100 * (bottom - top) };
    }

    function groupsForZone(zoneId, rows, keys) {
      const groups = new Map();
      for (const writ of rows) {
        const point = data.turns[writ.turnIn];
        if (point?.map !== zoneId) continue;
        if (!groups.has(writ.turnIn)) groups.set(writ.turnIn, { ...point, key: writ.turnIn, rows: [] });
        groups.get(writ.turnIn).rows.push(writ);
      }
      const result = [...groups.values()];
      result.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
      result.forEach((group, index) => { group.number = keys.indexOf(group.key) >= 0 ? keys.indexOf(group.key) + 1 : index + 1; });
      return result;
    }

    function routePath(route, isOverview) {
      const sequence = activeSteps(route).map(step => ({ step, point: pointForStep(step) })).filter(entry => entry.point);
      if (!isOverview) return [];
      return sequence.map(({ step, point }) => {
        const world = toContinent(point);
        if (!world) return null;
        return { ...world, kind: point.kind, label: point.label, mode: step.mode || 'ride', map: point.map };
      }).filter(Boolean);
    }

    function layoutPins(element) {
      const config = mapConfigs.get(element);
      if (!config || !element.clientWidth || element.hidden) return;
      element.querySelectorAll('button').forEach(button => button.remove());
      const svg = element.querySelector('svg');
      svg.replaceChildren();
      const width = element.clientWidth;
      const height = element.clientHeight;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const placed = [];
      const offsets = [];
      for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) offsets.push({ dx: dx * 43, dy: dy * 43 });
      offsets.sort((a, b) => a.dx * a.dx + a.dy * a.dy - b.dx * b.dx - b.dy * b.dy);
      const namespace = 'http://www.w3.org/2000/svg';
      if (config.path?.length > 1) {
        for (let index = 1; index < config.path.length; index++) {
          const from = config.path[index - 1];
          const to = config.path[index];
          const line = document.createElementNS(namespace, 'line');
          line.classList.add('route-segment');
          if (to.mode === 'flight') line.classList.add('flight');
          line.setAttribute('x1', from.x / 100 * width); line.setAttribute('y1', from.y / 100 * height);
          line.setAttribute('x2', to.x / 100 * width); line.setAttribute('y2', to.y / 100 * height);
          svg.append(line);
        }
        for (const point of config.path.filter(point => point.kind !== 'stop' && point.kind !== 'hub')) {
          const marker = document.createElementNS(namespace, 'circle');
          marker.classList.add('route-waypoint');
          if (point.mode === 'flight') marker.classList.add('flight');
          marker.setAttribute('cx', point.x / 100 * width); marker.setAttribute('cy', point.y / 100 * height); marker.setAttribute('r', '3.1');
          marker.setAttribute('aria-label', point.label); svg.append(marker);
        }
      }
      for (const group of config.groups) {
        const actual = { x: group.x / 100 * width, y: group.y / 100 * height };
        let label = actual;
        for (const offset of offsets) {
          const candidate = { x: Math.max(20, Math.min(width - 20, actual.x + offset.dx)), y: Math.max(20, Math.min(height - 20, actual.y + offset.dy)) };
          if (!placed.some(point => Math.abs(point.x - candidate.x) < 38 && Math.abs(point.y - candidate.y) < 38)) { label = candidate; break; }
        }
        placed.push(label);
        if (Math.abs(label.x - actual.x) > 2 || Math.abs(label.y - actual.y) > 2) {
          const line = document.createElementNS(namespace, 'line');
          line.setAttribute('x1', actual.x); line.setAttribute('y1', actual.y); line.setAttribute('x2', label.x); line.setAttribute('y2', label.y); svg.append(line);
        }
        const circle = document.createElementNS(namespace, 'circle');
        circle.setAttribute('cx', actual.x); circle.setAttribute('cy', actual.y); circle.setAttribute('r', config.overview ? '3.4' : '4'); svg.append(circle);
        const button = document.createElement('button');
        const completed = group.rows.every(writ => state.delivered.includes(writ.quest));
        button.type = 'button'; button.className = `map-pin ${config.overview ? 'route-pin overview' : ''} ${completed ? 'is-done' : ''}`;
        button.textContent = group.number; button.dataset.point = group.key;
        button.style.left = `${label.x / width * 100}%`; button.style.top = `${label.y / height * 100}%`;
        button.setAttribute('aria-pressed', String(group.key === config.selected));
        button.setAttribute('aria-label', `${group.number}. ${group.name}, ${group.original ? `${group.original.x.toFixed(1)}, ${group.original.y.toFixed(1)}` : COORDS(group)}`);
        button.addEventListener('click', () => config.select(group.key));
        element.append(button);
      }
    }

    function drawMap(element, image, groups, selected, select, options = {}) {
      element.hidden = false;
      element.classList.toggle('route-overview', Boolean(options.overview));
      element.innerHTML = `<img src="${image}" alt="${ESCAPE(options.alt || 'Карта маршрута')}"><svg aria-hidden="true"></svg>`;
      mapConfigs.set(element, { groups, selected, select, overview: Boolean(options.overview), path: options.path || [] });
      layoutPins(element);
    }

    const mapObserver = new ResizeObserver(entries => {
      for (const entry of entries) if (entry.contentRect.width > 0) layoutPins(entry.target);
    });
    mapObserver.observe($('#route-map'));
    mapObserver.observe($('#catalog-map'));

    function routeRouteHeader(route, rows, keys) {
      const rep = rows.reduce((sum, writ) => sum + REP[writ.tier], 0);
      const cost = routeEconomy(rows);
      const firstBranch = route.branches.find(branch => selectedBranches(route).has(branch.id) && branch.start);
      $('#route-title').textContent = route.title;
      $('#route-stats').textContent = `${ordersText(rows.length)} · ${FORMAT(rep)} репутации · ${cost.priced === rows.length ? GOLD(cost.copper) : 'цена неполная'} по снимку`;
      $('#route-start').textContent = firstBranch?.start || route.start;
      $('#route-finish').textContent = route.finish;
      $('#route-cost').textContent = `Снимок цен: ${prices.meta.snapshotLabel}. Покупка всех writ и готовых предметов: ${cost.priced === rows.length ? GOLD(cost.copper) : 'есть позиции без цены'}. Coin Pouch не гарантирует возврат.`;
      $('#shopping-title').textContent = `Покупки: ${route.title}`;
      $('#route-zone').innerHTML = [...new Set(rows.map(writ => data.turns[writ.turnIn]?.map).filter(Boolean))].map(id => `<option value="${id}">${ESCAPE(data.maps[id][0])} · ${ESCAPE(data.maps[id][1])}</option>`).join('');
      if (!keys.includes(state.selectedStop)) state.selectedStop = keys[0];
      const selectedPoint = data.turns[state.selectedStop];
      state.routeZone = selectedPoint?.map || Number(route.layers[0]);
      $('#route-zone').value = String(state.routeZone);
      $('#route-map').setAttribute('aria-label', `Карта ${route.title}`);
    }

    function renderRouteOptions() {
      renderRoutePicker();
      document.querySelectorAll('[data-map-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mapMode === state.mapMode)));
    }

    function renderLegList(route) {
      const details = activeSteps(route).filter(step => step.hub || step.at || step.instruction);
      $('#route-leg-list').innerHTML = details.map(step => {
        const point = pointForStep(step);
        const mode = step.mode === 'flight' ? 'Перелёт' : step.mode === 'ride' ? 'Дорога' : '';
        const text = step.instruction || step.label || point?.label || 'Переезд';
        return `<li>${mode ? `<strong>${mode}:</strong> ` : ''}${ESCAPE(text)}</li>`;
      }).join('');
    }

    function renderAudit(route, rows, keys) {
      const audit = audits[route.id];
      const economics = routeEconomy(rows);
      const rep = rows.reduce((sum, writ) => sum + REP[writ.tier], 0);
      const returnCopper = economics.returnCopper;
      const complete = economics.priced === rows.length;
      const netCopper = economics.copper - returnCopper;
      const high = rows.map(writ => ({ writ, pair: prices.pairs[String(writ.quest)] })).filter(entry => entry.pair?.[2] != null).sort((a, b) => b.pair[2] - a.pair[2]).slice(0, 5);
      const costText = complete ? `Выбранный состав: ${ordersText(rows.length)} / ${FORMAT(rep)} репутации / ${GOLD(economics.copper)} за writ и готовые предметы.` : `Цена известна для ${economics.priced} из ${rows.length} заказов: ${GOLD(economics.copper)} за известные позиции. Полная стоимость пока не определена.`;
      const netText = complete ? (netCopper >= 0 ? `Условные расходы после такого возврата — около ${GOLD(netCopper)}.` : `В этой условной оценке возврат превышает закупку на ${GOLD(-netCopper)}; фактическая выплата случайна.`) : 'Остаточные расходы не рассчитаны: для части заказов нет цены.';
      const pouch = `Исторический ориентир Wowhead для Coin Pouch: Journeyman 5–19с (для расчёта середина 12с, не измеренное среднее), Expert около 36с, Artisan около 74.56с. Для выбранного состава это около ${GOLD(returnCopper)} возврата. ${netText} Это не гарантия окупаемости.`;
      const sources = audit.sources.map(source => `<a href="${ESCAPE(source.url)}" target="_blank" rel="noopener noreferrer">${ESCAPE(source.title)}</a>`).join(' · ');
      $('#route-audit-content').innerHTML = `<p><strong>Проверка географии.</strong> ${ESCAPE(audit.verdict)}</p><p><strong>Порядок.</strong> ${ESCAPE(audit.path)}</p><p><strong>Переходы.</strong> ${ESCAPE(audit.terrain)}</p><p><strong class="audit-cost">Стоимость.</strong> ${ESCAPE(costText)} Снимок: ${ESCAPE(prices.meta.snapshotLabel)}.</p><p>${ESCAPE(audit.economy)}</p><p>${ESCAPE(pouch)}</p><div class="audit-highlights">${high.map(({ writ, pair }) => `<div class="audit-card"><strong>${GOLD(pair[2])} · +${REP[writ.tier]} реп.</strong><small>${ESCAPE(writ.name)} — writ и предмет по снимку</small></div>`).join('')}</div><p><strong>Что пишут игроки.</strong></p><ul>${audit.playerAdvice.map(note => `<li>${ESCAPE(note)}</li>`).join('')}</ul><ul>${audit.cautions.map(note => `<li class="audit-warning">${ESCAPE(note)}</li>`).join('')}</ul><p><strong>Источники:</strong> ${sources}</p><p class="cost-footnote">Всего ${ordersText(rows.length)} · ${FORMAT(rep)} репутации · ${economics.priced}/${rows.length} заказов с ценой. Снимок показывает выставленные лоты; наличие и размер стека проверь при покупке. Предметы из сумок, собственный крафт и перелёты в стоимость не входят.</p>`;
    }

    function renderRoute() {
      const route = currentRoute();
      const keys = stopKeys(route);
      const rows = rowsInOrder(activeOrders(route), keys);
      renderRouteOptions();
      routeRouteHeader(route, rows, keys);
      renderStops();
      renderLegList(route);
      renderAudit(route, rows, keys);
      const point = data.turns[state.selectedStop];
      $('#stop-orders').innerHTML = table(rows.filter(writ => writ.turnIn === state.selectedStop));
      $('#stop-name').textContent = point.name;
      $('#stop-kicker').textContent = `Точка ${keys.indexOf(state.selectedStop) + 1} из ${keys.length} · ${COORDS(point)}`;
      const step = activeSteps(route).find(candidate => candidate.stop === state.selectedStop);
      $('#stop-instruction').textContent = step?.instruction || `Сдай ${ordersText(rows.filter(writ => writ.turnIn === state.selectedStop).length)} у ${point.name}.`;

      if (state.mapMode === 'overview') {
        const groups = keys.map((key, index) => {
          const base = data.turns[key];
          const location = toContinent(base);
          return { ...base, original: base, key, rows: rows.filter(writ => writ.turnIn === key), number: index + 1, x: location.x, y: location.y };
        });
        const image = overviewMaps[String(route.continent)];
        $('#route-zone-title').textContent = route.continent === 1415 ? 'Восточные королевства' : 'Калимдор';
        $('#route-zone').disabled = true;
        drawMap($('#route-map'), image, groups, state.selectedStop, key => {
          state.selectedStop = key; renderRoute(); persist();
        }, { overview: true, path: routePath(route, true), alt: `Общий маршрут: ${route.title}` });
      } else {
        const zoneId = state.routeZone;
        const zoneGroups = groupsForZone(zoneId, rows, keys);
        $('#route-zone-title').textContent = `${data.maps[zoneId][0]} · ${data.maps[zoneId][1]}`;
        $('#route-zone').disabled = false;
        drawMap($('#route-map'), maps[zoneId], zoneGroups, state.selectedStop, key => {
          state.selectedStop = key; renderRoute(); persist();
        }, { alt: `Карта ${data.maps[zoneId][1]}` });
      }
      updateSummary();
    }

    function renderShopping() {
      const route = currentRoute();
      const keys = stopKeys(route);
      const rows = rowsInOrder(activeOrders(route), keys);
      $('#shopping-title').textContent = `Покупки: ${route.title}`;
      $('#shopping-orders').innerHTML = keys.map(key => {
        const point = data.turns[key];
        const groupRows = rows.filter(writ => writ.turnIn === key);
        if (!groupRows.length) return '';
        return `<section class="orders-group"><h3>${ESCAPE(point.name)} · ${ESCAPE(data.maps[point.map][1])} <span class="muted">${ordersText(groupRows.length)}</span></h3>${table(groupRows)}</section>`;
      }).join('');
      const economy = routeEconomy(rows);
      $('#shopping-orders').insertAdjacentHTML('afterbegin', `<p class="cost-footnote">Снимок: ${ESCAPE(prices.meta.snapshotLabel)} · оценка покупки всех writ и предметов: ${economy.priced === rows.length ? GOLD(economy.copper) : 'есть позиции без цены'}. В сумме показаны дешёвые выставленные лоты для нужного количества; перед покупкой проверь наличие и стек. Coin Pouch не считается гарантированной прибылью.</p>`);
    }

    function groupsForCatalog(zoneId, rows) {
      const groups = new Map();
      for (const writ of rows) {
        const point = data.turns[writ.turnIn];
        if (point?.map !== zoneId) continue;
        if (!groups.has(writ.turnIn)) groups.set(writ.turnIn, { ...point, key: writ.turnIn, rows: [] });
        groups.get(writ.turnIn).rows.push(writ);
      }
      return [...groups.values()].sort((a, b) => a.y - b.y || a.x - b.x).map((group, index) => ({ ...group, number: index + 1 }));
    }

    function renderCatalog() {
      const selected = state.catalogZone;
      const query = state.query.trim().toLocaleLowerCase();
      let rows = data.writs.filter(writ => selected === 'all' || (selected === 'unknown' ? !data.turns[writ.turnIn] : data.turns[writ.turnIn]?.map === Number(selected)));
      if (query) rows = rows.filter(writ => {
        const point = data.turns[writ.turnIn];
        return `${writ.name} ${point?.name || ''} ${point ? data.maps[point.map].join(' ') : ''}`.toLocaleLowerCase().includes(query);
      });
      $('#catalog-zone').value = selected;
      const zoneId = Number(selected);
      const groups = data.maps[zoneId] ? groupsForCatalog(zoneId, rows) : [];
      if (groups.length) {
        drawMap($('#catalog-map'), maps[zoneId], groups, null, key => {
          const group = groups.find(point => point.key === key);
          $('#catalog-point').textContent = `${group.name} · ${COORDS(group)} · ${ordersText(group.rows.length)}`;
        }, { alt: `Карта ${data.maps[zoneId][1]}` });
      } else $('#catalog-map').hidden = true;
      $('#catalog-point').textContent = '';
      const xlsx = audits.xlsx;
      $('#catalog-notice').textContent = selected === 'unknown'
        ? 'Эти 16 Artisan пока без подтверждённого получателя. Они не включены в рекомендуемые маршруты. Проверь маркер принятого задания в игре перед покупкой.'
        : `${ordersText(rows.length)}${data.maps[zoneId] ? ` · ${data.maps[zoneId][0]}` : ' во всём каталоге'}. ${xlsx.summary} ${xlsx.conflict}`;
      $('#catalog-orders').innerHTML = rows.length ? table(rows) : '<p class="empty-state">Заказов с таким названием здесь нет.</p>';
    }

    function showView(view) {
      state.view = ['route', 'shopping', 'catalog'].includes(view) ? view : 'route';
      for (const name of ['route', 'shopping', 'catalog']) $(`#${name}-view`).hidden = name !== state.view;
      document.querySelectorAll('[data-view]').forEach(button => {
        if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      history.replaceState(null, '', `#${state.view}`);
      if (state.view === 'route') renderRoute();
      if (state.view === 'shopping') { renderRouteOptions(); renderShopping(); }
      if (state.view === 'catalog') renderCatalog();
      persist();
    }

    function syncChecks() {
      document.querySelectorAll('input[data-kind]').forEach(input => {
        input.checked = state[input.dataset.kind].includes(Number(input.dataset.quest));
        input.closest('tr').classList.toggle('delivered', state.delivered.includes(Number(input.dataset.quest)));
      });
      updateSummary();
      renderStops();
      for (const element of mapConfigs.keys()) layoutPins(element);
    }

    $('#catalog-zone').innerHTML = `<option value="all">Все зоны · 150 заказов</option>${Object.entries(data.maps).sort((a, b) => a[1][0].localeCompare(b[1][0], 'ru')).map(([id, names]) => `<option value="${id}">${ESCAPE(names[0])} — ${ESCAPE(names[1])}</option>`).join('')}<option value="unknown">Получатель не подтверждён · 16</option>`;
    $('#catalog-search').value = state.query;
    $('#route-picker').value = state.routeId;
    $('#catalog-zone').value = state.catalogZone;

    document.addEventListener('change', event => {
      const input = event.target.closest('input[data-kind]');
      if (!input) return;
      const quest = Number(input.dataset.quest);
      const set = new Set(state[input.dataset.kind]);
      if (input.checked) set.add(quest); else set.delete(quest);
      state[input.dataset.kind] = [...set];
      persist(); syncChecks();
    });
    $('#route-stops').addEventListener('click', event => {
      const stop = event.target.closest('[data-stop]');
      if (stop) { state.selectedStop = stop.dataset.stop; state.mapMode = 'zone'; renderRoute(); persist(); }
    });
    document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
    document.querySelectorAll('[data-open-shopping]').forEach(button => button.addEventListener('click', () => showView('shopping')));
    window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
    $('#route-picker').addEventListener('change', event => {
      state.routeId = event.target.value;
      const route = currentRoute();
      const key = stopKeys(route)[0];
      state.selectedStop = key;
      const point = data.turns[key];
      state.routeZone = point.map;
      state.mapMode = 'overview';
      persist(); renderRoute(); renderShopping();
    });
    $('#route-options').addEventListener('change', event => {
      const input = event.target.closest('input[data-branch]');
      if (!input) return;
      const route = currentRoute();
      const selected = new Set(state.branches[route.id] || []);
      const branch = route.branches.find(item => item.id === input.dataset.branch);
      if (input.checked) {
        selected.add(branch.id);
        if (branch.requires) selected.add(branch.requires);
      } else {
        selected.delete(branch.id);
        route.branches.filter(item => item.requires === branch.id).forEach(child => selected.delete(child.id));
      }
      state.branches[route.id] = [...selected];
      const keys = stopKeys(route);
      if (!keys.includes(state.selectedStop)) state.selectedStop = keys[0];
      const point = data.turns[state.selectedStop];
      state.routeZone = point.map;
      persist(); renderRoute(); renderShopping();
    });
    document.querySelectorAll('[data-map-mode]').forEach(button => button.addEventListener('click', () => {
      state.mapMode = button.dataset.mapMode;
      if (state.mapMode === 'zone') state.routeZone = data.turns[state.selectedStop].map;
      persist(); renderRoute();
    }));
    $('#route-zone').addEventListener('change', event => {
      state.routeZone = Number(event.target.value);
      const key = stopKeys().find(stop => data.turns[stop].map === state.routeZone);
      if (key) state.selectedStop = key;
      renderRoute(); persist();
    });
    $('#route-stop-select').addEventListener('change', event => {
      state.selectedStop = event.target.value;
      state.routeZone = data.turns[state.selectedStop].map;
      state.mapMode = 'zone';
      renderRoute(); persist();
    });
    $('#catalog-zone').addEventListener('change', event => { state.catalogZone = event.target.value; renderCatalog(); persist(); });
    $('#catalog-search').addEventListener('input', event => { state.query = event.target.value; renderCatalog(); persist(); });

    $('#next-round').addEventListener('click', () => {
      const earned = roundRep();
      if (!state.delivered.length) return;
      state.bankedRep += earned;
      state.round += 1;
      state.writReady = []; state.itemReady = []; state.delivered = [];
      persist(); renderRoute(); renderShopping(); renderCatalog(); updateSummary();
      toast(`Начат набор ${state.round}. +${FORMAT(earned)} репутации сохранено. Отметки покупок и сдач очищены.`);
    });

    async function copyText(text, message) {
      try { await navigator.clipboard.writeText(text); toast(message); }
      catch {
        const field = $('#copy-text');
        field.value = text;
        $('#copy-dialog').showModal();
        field.focus();
        field.select();
      }
    }
    $('#copy-waypoint').addEventListener('click', () => {
      const point = data.turns[state.selectedStop];
      copyText(`/way ${point.x.toFixed(1)} ${point.y.toFixed(1)} ${point.name}`, `Команда для ${data.maps[point.map][1]} скопирована`);
    });
    $('#copy-shopping').addEventListener('click', () => {
      const route = currentRoute();
      const keys = stopKeys(route);
      const rows = activeOrders(route);
      const text = keys.map((key, index) => {
        const point = data.turns[key];
        return `${index + 1}. ${point.name} — ${data.maps[point.map][1]}, ${COORDS(point)}\n${rows.filter(writ => writ.turnIn === key).map(writ => `1 × Craftsman's Writ: ${writ.name}\n${writ.count} × ${writ.name}`).join('\n')}`;
      }).join('\n\n');
      copyText(text, `Список ${ordersText(rows.length)} скопирован`);
    });

    const dialog = $('#reputation-dialog');
    let editingProfile;
    function updateRankLimit() {
      const rank = RANKS.find(rank => rank.start === Number($('#reputation-rank').value));
      $('#reputation-points').max = rank.end - rank.start - 1;
    }
    function openProfile(profile, isNew = false) {
      editingProfile = { profile, isNew };
      const total = Math.min(42999, Math.max(0, profile.baseline + profile.bankedRep + planner.earnedRep(profile)));
      const rank = currentRank(total);
      $('#profile-dialog-title').textContent = isNew ? 'Добавить персонажа' : 'Настройки персонажа';
      $('#profile-name').value = profile.name;
      $('#reputation-rank').value = String(rank.start);
      $('#reputation-points').value = total - rank.start;
      $('#reputation-goal').value = String(profile.goal);
      $('#profile-form-error').hidden = true;
      updateRankLimit(); dialog.showModal();
    }
    $('#adjust-reputation').addEventListener('click', () => openProfile(state));
    $('#edit-profile').addEventListener('click', () => openProfile(state));
    $('#add-profile').addEventListener('click', () => openProfile(planner.createProfile(`Персонаж ${store.profiles.length + 1}`), true));
    $('#profile-picker').addEventListener('change', event => activateProfile(store.profiles.find(profile => profile.id === event.target.value)));
    $('#delete-profile').addEventListener('click', async () => {
      const profile = state;
      if (!await confirmAction('Удалить персонажа?', `«${profile.name}»: репутация, отметки покупок и сдач будут удалены из этого браузера. Можно заранее сохранить их в файл.`, 'Удалить')) return;
      store.profiles = store.profiles.filter(item => item.id !== profile.id);
      if (!store.profiles.length) store.profiles.push(planner.createProfile());
      activateProfile(store.profiles[0]);
      if (!state.reputationConfirmed) openProfile(state);
    });
    $('#reputation-rank').addEventListener('change', updateRankLimit);
    $('#cancel-reputation').addEventListener('click', () => dialog.close());
    $('#reputation-form').addEventListener('submit', event => {
      event.preventDefault();
      const name = $('#profile-name').value.trim();
      if (!name) { $('#profile-name').focus(); return; }
      try {
        const { profile, isNew } = editingProfile;
        const actual = Number($('#reputation-rank').value) + Number($('#reputation-points').value);
        planner.setReputation(profile, actual, Number($('#reputation-goal').value));
        profile.name = name;
        if (isNew) store.profiles.push(profile);
        activateProfile(profile);
        dialog.close();
        toast('Персонаж сохранён. Репутация сверена со значением из игры.');
      } catch (error) {
        $('#profile-form-error').textContent = error.message;
        $('#profile-form-error').hidden = false;
      }
    });

    $('#export-progress').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(planner.exportBackup(store), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `aca-progress-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Резервная копия всех персонажей сохранена в файл');
    });
    $('#import-progress').addEventListener('click', () => $('#backup-file').click());
    $('#backup-file').addEventListener('change', async event => {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error('Файл больше 2 МБ. Выбери резервную копию прогресса ACA.');
        const imported = planner.importBackup(JSON.parse(await file.text()));
        const preview = imported.profiles.map(profile => `• ${profile.name} — ${planner.totalRep(profile) === null ? 'репутация не задана' : `${FORMAT(planner.totalRep(profile))} реп.`}, ${counted(profile.delivered.length, ['сдача', 'сдачи', 'сдач'])}`).join('\n');
        if (!await confirmAction('Загрузить персонажей?', `${preview}\n\nОни будут добавлены с пометкой «импорт». Текущие персонажи сохранятся.`, 'Добавить')) return;
        let active;
        for (const profile of imported.profiles) {
          const wasActive = profile.id === imported.activeProfileId;
          profile.id = planner.createProfile().id;
          profile.name = `${profile.name} (импорт)`;
          store.profiles.push(profile);
          if (wasActive) active = profile;
        }
        activateProfile(active);
        toast('Прогресс загружен. Текущие персонажи сохранены.');
      } catch (error) { toast(`Не удалось загрузить прогресс: ${error.message}`); }
    });
    $('#refresh-prices').addEventListener('click', () => refreshPrices(true));

    $('#loading').hidden = true;
    $('#app').hidden = false;
    $('#build-version').textContent = `Версия ${window.ACA_SITE.version}`;
    $('#download-portable').hidden = Boolean(window.ACA_ASSETS) || location.protocol === 'file:';
    if (window.ACA_SITE.url) {
      $('#open-published').href = window.ACA_SITE.url;
      $('#open-published').hidden = false;
    }
    renderAll(); renderPriceStatus(); persist();
    if (!state.reputationConfirmed) openProfile(state);
    if (window.ACAPrices.shouldAutoRefresh(prices, lastCheckedAt)) refreshPrices();
  } catch (error) {
    $('#loading').textContent = 'Не удалось загрузить заказы, маршруты и карты. Обнови страницу или перезапусти локальный сайт.';
    console.error(error);
  }
})();
