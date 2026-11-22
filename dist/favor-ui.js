'use strict';

window.ACAFavorUI = (() => {
  const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = value => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const professions = {
    ALCHEMY: 'Алхимия', BLACKSMITHING: 'Кузнечное дело', COOKING: 'Кулинария',
    ENCHANTING: 'Наложение чар', ENGINEERING: 'Инженерное дело',
    LEATHERWORKING: 'Кожевничество', TAILORING: 'Портняжное дело',
  };
  const standings = { 0: 'без требования репутации', 3000: 'Friendly · Дружелюбие', 9000: 'Honored · Уважение', 21000: 'Revered · Почтение', 42000: 'Exalted · Превознесение' };
  function money(copper) {
    const value = Math.abs(copper);
    const parts = [];
    if (value >= 10000) parts.push(`${number(Math.floor(value / 10000))}g`);
    if (value % 10000 >= 100) parts.push(`${Math.floor(value % 10000 / 100)}s`);
    if (value % 100 || !parts.length) parts.push(`${value % 100}c`);
    return `${copper < 0 ? '−' : ''}${parts.join(' ')}`;
  }
  const itemLink = (id, name) => `<a href="https://www.wowhead.com/forever/item=${id}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`;

  function create({ root, catalog, getProfile, getPrices, getReputation, save, copyText }) {
    const $ = selector => root.querySelector(selector);
    const recipes = new Map(catalog.recipes.map(recipe => [recipe.id, recipe]));
    const crates = new Map(catalog.crates.map(crate => [crate.id, crate]));
    const itemIds = [...new Set(catalog.crates.flatMap(crate => [crate.id, ...crate.bundles.map(bundle => bundle.item)]))];
    let query = '';
    let limit = 30;
    let profileId;
    let lastPlan = null;
    const basket = () => getProfile().favorRecipeIds.map(id => recipes.get(id) || { id, name: `Рецепт #${id}`, available: false });
    const selectedCost = () => basket().reduce((sum, recipe) => sum + (recipe.cost || 0), 0);
    const target = () => getProfile().favorGoalMode === 'recipes' ? selectedCost() : getProfile().favorTarget;

    $('#favor-profession').innerHTML = '<option value="all">Все профессии</option>' + Object.entries(professions).map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
    $('#favor-sources').innerHTML = 'Источники: ' + catalog.sources.map(source => `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a>`).join(' · ');
    $('#favor-catalog-date').textContent = `Проверка каталога: ${catalog.checkedAt.split('-').reverse().join('.')}. Дата цен аукциона указана вверху страницы.`;

    function syncMode() {
      const recipeMode = getProfile().favorGoalMode === 'recipes';
      $('#favor-target-field').hidden = recipeMode;
      $('#favor-target').disabled = recipeMode;
      $('#favor-basket-section').hidden = !recipeMode;
      $('#favor-recipes-section').hidden = !recipeMode;
      root.classList.toggle('favor-coins-mode', !recipeMode);
    }

    function renderBasket() {
      const rows = basket();
      $('#favor-clear').disabled = !rows.length;
      $('#favor-basket').innerHTML = rows.length ? `<ul class="favor-basket-list">${rows.map(recipe => `<li><span>${esc(recipe.name)}<small>${recipe.cost ? `${number(recipe.cost)} Favor` : 'Нет цены в каталоге'}</small></span><button type="button" class="text-button" data-favor-remove="${recipe.id}" aria-label="Убрать ${esc(recipe.name)}">Убрать</button></li>`).join('')}</ul><p class="favor-basket-total">Всего: <strong>${number(selectedCost())} Favor</strong></p>` : '<p class="muted">Добавь нужные рецепты из каталога. Стоимость выбранных рецептов суммируется автоматически.</p>';
      const rep = getReputation();
      $('#favor-reputation').textContent = rep === null ? 'Репутация профиля не задана. Требования к покупке указаны у рецептов.' : `Репутация профиля: ${number(rep)}. Рецепты с более высоким требованием можно выбрать для будущей покупки.`;
    }

    function renderRecipes() {
      const profile = getProfile();
      const search = query.trim().toLocaleLowerCase('ru-RU');
      const rows = catalog.recipes.filter(recipe => (profile.favorProfession === 'all' || recipe.profession === profile.favorProfession) && (!search || `${recipe.name} ${professions[recipe.profession]} ${recipe.vendor.name}`.toLocaleLowerCase('ru-RU').includes(search)))
        .sort((a, b) => (a.skill ?? Infinity) - (b.skill ?? Infinity) || a.name.localeCompare(b.name));
      const selected = new Set(profile.favorRecipeIds);
      const rep = getReputation();
      $('#favor-recipe-count').textContent = `${Math.min(limit, rows.length)} из ${rows.length}`;
      $('#favor-recipes').innerHTML = rows.length ? rows.slice(0, limit).map(recipe => {
        const reputation = recipe.reputation == null ? 'требование репутации уточняется' : standings[recipe.reputation];
        const blocked = recipe.reputation != null && rep !== null && recipe.reputation > rep;
        return `<article class="favor-recipe${selected.has(recipe.id) ? ' is-selected' : ''}${recipe.available ? '' : ' is-disputed'}"><label class="favor-recipe-choice"><input type="checkbox" data-favor-recipe="${recipe.id}" ${selected.has(recipe.id) ? 'checked' : ''} ${recipe.available ? '' : 'disabled'} aria-label="Выбрать рецепт: ${esc(recipe.name)}"><span><strong>${esc(recipe.name)}</strong><small>${professions[recipe.profession]} · навык ${recipe.skill ?? 'уточняется'}</small></span><b>${number(recipe.cost)}<small>Favor</small></b></label><p class="${blocked ? 'favor-warning' : 'muted'}">${esc(reputation)}${blocked ? ' · пока не достигнуто' : ''}</p><p class="muted">${esc(recipe.vendor.name)} · <a href="${esc(recipe.source)}" target="_blank" rel="noopener noreferrer">Проверить рецепт</a></p>${recipe.note ? `<p class="favor-warning">${esc(recipe.note)}</p>` : ''}</article>`;
      }).join('') : '<p class="muted">Рецептов с таким названием нет.</p>';
      $('#favor-more').hidden = rows.length <= limit;
      $('#favor-more').textContent = `Показать ещё ${Math.min(30, rows.length - limit)}`;
    }

    function notice(text) {
      lastPlan = null;
      $('#favor-copy').disabled = true;
      $('#favor-result').innerHTML = `<p class="favor-notice">${esc(text)}</p>`;
      $('#favor-purchases').innerHTML = '';
    }

    function renderResult() {
      const profile = getProfile();
      const snapshot = getPrices();
      if (profile.favorBalance === null) return notice('Укажи текущий баланс Merchant’s Favor из игры. Если монет нет, введи 0.');
      if (profile.favorGoalMode === 'recipes' && !profile.favorRecipeIds.length) return notice('Выбери рецепты в каталоге или переключись на желаемый баланс монет.');
      if (profile.favorGoalMode === 'recipes' && basket().some(recipe => !recipe.available)) return notice('В корзине есть рецепт с неподтверждённым наличием или без данных. Убери его, чтобы составить закупку.');
      if (target() <= profile.favorBalance) return notice(`Монет достаточно: нужно ${number(target())}, на балансе ${number(profile.favorBalance)} Favor. Закупка не требуется.`);
      if (profile.favorLevel < 10) return notice('Для заполнения первых Waylaid Crates нужен уровень 10.');
      if (!window.ACAPrices.hasItems(snapshot, itemIds)) return notice('Этот снимок ещё не содержит цен ящиков и материалов. Нажми «Обновить цены» вверху страницы.');
      try {
        const plan = window.ACAFavor.solve({ crates: catalog.crates, items: snapshot.items, balance: profile.favorBalance, target: target(), level: profile.favorLevel });
        if (plan.status === 'insufficientData') return notice(`По опубликованным запасам можно получить ${number(plan.availableFavor)} Favor, нужно ещё ${number(plan.deficit)}. Снимка недостаточно для покрытия цели. Обнови цены или уменьши цель.`);
        lastPlan = plan;
        $('#favor-copy').disabled = false;
        const expected = plan.totalFavor * (1 + profile.favorBonusRank * 0.05);
        $('#favor-result').innerHTML = `<p class="favor-target-summary">Нужно ${number(target())} · есть ${number(profile.favorBalance)} · заработать <strong>${number(plan.deficit)} Favor</strong></p><div class="favor-metrics"><div><span>На закупку</span><strong>${money(plan.grossCopper)}</strong></div><div><span>Подтверждённый возврат</span><strong>${money(plan.totalReturnCopper)}</strong></div><div class="favor-net"><span>Расход после сдач</span><strong>${money(plan.netCopper)}</strong></div><div><span>Сдачи</span><strong>${number(plan.crateCount)}</strong></div><div><span>Базовые монеты</span><strong>${number(plan.totalFavor)} Favor</strong></div><div><span>Баланс после сдач</span><strong>${number(profile.favorBalance + plan.totalFavor)} Favor</strong></div></div>${profile.favorBonusRank ? `<p class="muted">При шансе ${profile.favorBonusRank * 5}% ожидается около ${number(expected)} Favor за этот план. Закупка рассчитана без случайных удвоений.</p>` : ''}${plan.unknownReturnCount ? `<p class="favor-warning">В плане ${number(plan.unknownReturnCount)} Artisan-ящиков. Их возможный возврат серебра не подтверждён и не вычтен из расходов.</p>` : ''}${plan.netCopper < 0 ? '<p class="favor-warning">По модели снимка возврат превышает закупку. Перед покупкой проверь актуальные цены и целые стеки.</p>' : ''}<p class="muted favor-plan-date">Минимум по опубликованным ценам единиц. Снимок: ${esc(snapshot.meta.snapshotLabel)}.</p>`;
        const purchases = new Map();
        for (const line of plan.lines) {
          purchases.set(line.crateId, (purchases.get(line.crateId) || 0) + line.crates);
          purchases.set(line.item, (purchases.get(line.item) || 0) + line.itemCount);
        }
        $('#favor-purchases').innerHTML = `<h4>Купить на аукционе Альянса</h4><ul class="favor-shopping-list">${[...purchases].map(([id, count]) => `<li>${itemLink(id, catalog.items[id])} <strong>× ${number(count)}</strong></li>`).join('')}</ul><h4>Заполнить и сдать</h4><ol class="favor-fill-list">${plan.lines.map(line => `<li><strong>${number(line.crates)} × ${esc(crates.get(line.crateId).name)}</strong><span>В каждый: ${number(line.countPerCrate)} × ${esc(catalog.items[line.item])}. Всего ${number(line.itemCount)} предметов → ${number(line.favor)} Favor.</span></li>`).join('')}</ol><p class="muted">Сдавай Marcy Baker в Three Corners. Бонусные монеты в баланс автоматически не записываются — после сдач внеси фактическое значение из игры.</p>`;
      } catch (error) { notice(`Расчёт недоступен: ${error.message}`); }
    }

    function renderRanking() {
      const snapshot = getPrices();
      if (!window.ACAPrices.hasItems(snapshot, itemIds)) { $('#favor-ranking').innerHTML = '<p class="muted">Обнови цены, чтобы сравнить ящики.</p>'; return; }
      const level = getProfile().favorLevel;
      const rows = catalog.crates.map(crate => {
        const plan = window.ACAFavor.solve({ crates: [crate], items: snapshot.items, balance: 0, target: 1, level });
        return { crate, plan, rate: plan.status === 'ready' ? plan.netCopper / plan.totalFavor : Infinity };
      }).sort((a, b) => a.rate - b.rate || a.crate.id - b.crate.id);
      $('#favor-ranking').innerHTML = `<p class="muted">Цена первого ящика с самым дешёвым доступным заполнением. План выше учитывает рост цен и может смешивать варианты.</p><div class="table-wrap"><table class="favor-table"><thead><tr><th>Ящик и заполнение</th><th>Монеты</th><th>Закупка</th><th>Расход после сдачи</th><th>За Favor</th></tr></thead><tbody>${rows.map(({ crate, plan, rate }) => `<tr><td>${itemLink(crate.id, crate.name)}<small>${crate.level > level ? `Нужен уровень ${crate.level}` : plan.status !== 'ready' ? 'Нет полного комплекта в снимке' : `${plan.lines[0].countPerCrate} × ${esc(catalog.items[plan.lines[0].item])}`}${crate.returnCopper === null ? ' · возврат не учтён' : ''}</small></td><td>${crate.favor}</td><td>${plan.status === 'ready' ? money(plan.grossCopper) : '—'}</td><td>${plan.status === 'ready' ? money(plan.netCopper) : '—'}</td><td>${Number.isFinite(rate) ? `${number(rate)}c` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
    }

    function render() {
      const profile = getProfile();
      if (profileId !== profile.id) { profileId = profile.id; query = ''; limit = 30; $('#favor-search').value = ''; }
      $('#favor-balance').value = profile.favorBalance ?? '';
      $('#favor-mode').value = profile.favorGoalMode;
      $('#favor-target').value = profile.favorTarget;
      $('#favor-level').value = profile.favorLevel;
      $('#favor-bonus').value = profile.favorBonusRank;
      $('#favor-profession').value = profile.favorProfession;
      $('#favor-input-error').hidden = true;
      syncMode(); renderBasket(); renderRecipes(); renderResult(); renderRanking();
    }

    $('#favor-settings').addEventListener('submit', event => event.preventDefault());
    $('#favor-settings').addEventListener('input', () => {
      const profile = getProfile();
      profile.favorGoalMode = $('#favor-mode').value;
      syncMode();
      const fields = ['#favor-level', ...(profile.favorGoalMode === 'coins' ? ['#favor-target'] : [])];
      const valid = fields.every(selector => $(selector).validity.valid && Number.isSafeInteger(Number($(selector).value))) && ($('#favor-balance').value === '' || ($('#favor-balance').validity.valid && Number.isSafeInteger(Number($('#favor-balance').value))));
      $('#favor-input-error').hidden = valid;
      if (!valid) {
        $('#favor-input-error').textContent = 'Укажи целые неотрицательные суммы и уровень от 1 до 60.';
        notice('Проверь значения в форме, чтобы пересчитать закупку.');
        return;
      }
      profile.favorBalance = $('#favor-balance').value === '' ? null : Number($('#favor-balance').value);
      if (profile.favorGoalMode === 'coins') profile.favorTarget = Number($('#favor-target').value);
      profile.favorLevel = Number($('#favor-level').value);
      profile.favorBonusRank = Number($('#favor-bonus').value);
      save(); renderResult(); renderRanking();
    });
    $('#favor-profession').addEventListener('change', event => { getProfile().favorProfession = event.target.value; limit = 30; save(); renderRecipes(); });
    $('#favor-search').addEventListener('input', event => { query = event.target.value; limit = 30; renderRecipes(); });
    $('#favor-more').addEventListener('click', () => { limit += 30; renderRecipes(); });
    root.addEventListener('change', event => {
      const input = event.target.closest('[data-favor-recipe]');
      if (!input) return;
      const id = Number(input.dataset.favorRecipe);
      if (!recipes.get(id)?.available) return;
      const selected = new Set(getProfile().favorRecipeIds);
      if (input.checked) selected.add(id); else selected.delete(id);
      getProfile().favorRecipeIds = [...selected];
      save(); renderBasket(); renderResult(); renderRecipes();
      $(`[data-favor-recipe="${id}"]`)?.focus({ preventScroll: true });
    });
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-favor-remove]');
      if (!button) return;
      getProfile().favorRecipeIds = getProfile().favorRecipeIds.filter(id => id !== Number(button.dataset.favorRemove));
      save(); renderBasket(); renderResult(); renderRecipes();
    });
    $('#favor-clear').addEventListener('click', () => { getProfile().favorRecipeIds = []; save(); renderBasket(); renderResult(); renderRecipes(); });
    $('#favor-copy').addEventListener('click', () => {
      if (!lastPlan) return;
      const shopping = new Map();
      for (const line of lastPlan.lines) {
        shopping.set(line.crateId, (shopping.get(line.crateId) || 0) + line.crates);
        shopping.set(line.item, (shopping.get(line.item) || 0) + line.itemCount);
      }
      const text = [`Merchant's Favor · EU PvP Alliance · ${getPrices().meta.snapshotLabel}`, `Купить: ${money(lastPlan.grossCopper)}. Подтверждённый возврат: ${money(lastPlan.totalReturnCopper)}. Расход: ${money(lastPlan.netCopper)}.`, '', 'Купить на аукционе Альянса:', ...[...shopping].map(([id, count]) => `${count} × ${catalog.items[id]}`), '', 'Заполнить:', ...lastPlan.lines.map(line => `${line.crates} × ${crates.get(line.crateId).name}: в каждый ${line.countPerCrate} × ${catalog.items[line.item]}`), '', `Базовая награда: ${lastPlan.totalFavor} Favor.`, 'Сдать Marcy Baker, Three Corners, Redridge Mountains: /way 9.6 70.9', 'Расчёт по ценам единиц; при покупке проверь целые стеки.', ...(lastPlan.unknownReturnCount ? ['Возврат серебра Artisan не учтён.'] : [])].join('\n');
      copyText(text, 'Список ящиков и материалов скопирован');
    });
    return { render };
  }
  return { create };
})();
