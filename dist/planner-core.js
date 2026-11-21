'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ACAPlanner = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const REPUTATION = { JOURNEYMAN: 75, EXPERT: 125, ARTISAN: 200 };
  const GOALS = [3000, 9000, 21000, 42000];
  const CHECKS = ['writReady', 'itemReady', 'delivered'];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const id = () => globalThis.crypto?.randomUUID?.() || `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  function createContext({ writs, routes }) {
    const byQuest = new Map(writs.map(writ => [writ.quest, writ]));
    const byRoute = new Map(routes.map(route => [route.id, route]));
    const firstRoute = byRoute.get('north') || routes[0];
    if (!firstRoute) throw new Error('Нет маршрутов для планировщика.');
    const stops = new Set(writs.map(writ => writ.turnIn).filter(Boolean).map(String));
    const defaultStop = firstRoute.steps.find(step => step.stop)?.stop || '';
    const defaultZone = firstRoute.layers?.find(zone => zone === 1437) || firstRoute.layers?.[0] || 1437;

    function earnedRep(profile) {
      return [...new Set(profile.delivered || [])].reduce((sum, quest) => sum + (REPUTATION[byQuest.get(quest)?.tier] || 0), 0);
    }

    function totalRep(profile) {
      return profile.reputationConfirmed ? Math.max(0, profile.baseline + profile.bankedRep + earnedRep(profile)) : null;
    }

    function normalizeProfile(raw, { strict = false } = {}) {
      if (!object(raw)) {
        if (strict) throw new Error('Профиль должен быть объектом.');
        raw = {};
      }
      function field(key, fallback, valid) {
        if (!own(raw, key)) return fallback;
        if (valid(raw[key])) return raw[key];
        if (strict) throw new Error(`Некорректное поле профиля: ${key}.`);
        return fallback;
      }
      const integer = Number.isSafeInteger;
      const zone = value => integer(value) && value > 0;
      const text = value => typeof value === 'string';
      const boolean = value => typeof value === 'boolean';
      const profile = {
        id: field('id', id(), value => text(value) && value.trim().length > 0),
        name: field('name', 'Персонаж 1', value => text(value) && value.trim().length > 0).trim(),
        baseline: field('baseline', 0, integer),
        bankedRep: field('bankedRep', 0, value => integer(value) && value >= 0),
        round: field('round', 1, value => integer(value) && value >= 1),
        goal: field('goal', 9000, value => GOALS.includes(value)),
        reputationConfirmed: field('reputationConfirmed', false, boolean),
        needsReputationReview: field('needsReputationReview', false, boolean),
        southKalimdorRevision: field('southKalimdorRevision', 0, value => integer(value) && value >= 0),
        view: field('view', 'route', value => ['route', 'shopping', 'catalog'].includes(value)),
        routeId: field('routeId', firstRoute.id, text),
        mapMode: field('mapMode', 'overview', value => ['overview', 'zone'].includes(value)),
        routeZone: field('routeZone', defaultZone, zone),
        selectedStop: field('selectedStop', String(defaultStop), text),
        catalogZone: field('catalogZone', '1437', text),
        query: field('query', '', text),
        branches: {},
      };
      if (!byRoute.has(profile.routeId)) profile.routeId = firstRoute.id;
      if (!stops.has(profile.selectedStop)) profile.selectedStop = String(defaultStop);
      if (!['all', 'unknown'].includes(profile.catalogZone)) profile.catalogZone = zone(Number(profile.catalogZone)) ? String(Number(profile.catalogZone)) : String(defaultZone);
      for (const key of CHECKS) {
        const values = field(key, [], Array.isArray);
        if (strict && !values.every(integer)) throw new Error(`Некорректные отметки профиля: ${key}.`);
        profile[key] = [...new Set(values)].filter(quest => integer(quest) && byQuest.has(quest));
      }
      const branches = field('branches', {}, object);
      for (const [routeId, values] of Object.entries(branches)) {
        if (strict && (!Array.isArray(values) || !values.every(text))) throw new Error(`Некорректные ветки маршрута: ${routeId}.`);
      }
      for (const route of routes) {
        const definitions = route.branches || [];
        const values = branches[route.id];
        const selected = new Set(Array.isArray(values) ? values : definitions.filter(branch => branch.default).map(branch => branch.id));
        if (route.id === 'kalimdor-south' && profile.southKalimdorRevision < 1) {
          selected.add('dustwallow');
          if (selected.delete('wilderness')) {
            selected.add('torwa');
            selected.add('silithus');
          }
        }
        let valid = definitions.filter(branch => selected.has(branch.id));
        while (valid.some(branch => branch.requires && !valid.some(parent => parent.id === branch.requires))) {
          valid = valid.filter(branch => !branch.requires || valid.some(parent => parent.id === branch.requires));
        }
        profile.branches[route.id] = valid.map(branch => branch.id);
      }
      profile.southKalimdorRevision = Math.max(1, profile.southKalimdorRevision);
      return profile;
    }

    function createProfile(name = 'Персонаж 1') {
      return normalizeProfile({ name, southKalimdorRevision: 1 });
    }

    function setReputation(profile, total, goal = profile.goal) {
      if (!Number.isSafeInteger(total) || total < 0 || total > 42999) throw new Error('Репутация должна быть целым числом от 0 до 42999.');
      if (!GOALS.includes(goal)) throw new Error('Неизвестная цель репутации.');
      profile.baseline = total - profile.bankedRep - earnedRep(profile);
      profile.goal = goal;
      profile.reputationConfirmed = true;
      profile.needsReputationReview = false;
      return profile;
    }

    function normalizeStore(value, strict) {
      if (!object(value) || value.version !== 2 || !Array.isArray(value.profiles) || !value.profiles.length) throw new Error('Некорректное хранилище профилей.');
      const profiles = value.profiles.filter(raw => {
        if (object(raw)) return true;
        if (strict) throw new Error('Некорректный профиль в резервной копии.');
        return false;
      }).map(raw => {
        if (strict && (typeof raw.id !== 'string' || !raw.id.trim())) throw new Error('В профиле отсутствует идентификатор.');
        return normalizeProfile(raw, { strict });
      });
      if (!profiles.length) throw new Error('Нет профилей для восстановления.');
      const ids = new Set();
      for (const profile of profiles) {
        if (ids.has(profile.id)) {
          if (strict) throw new Error('Идентификаторы профилей повторяются.');
          profile.id = id();
        }
        ids.add(profile.id);
      }
      if (strict && (typeof value.activeProfileId !== 'string' || !ids.has(value.activeProfileId))) throw new Error('Активный профиль отсутствует в резервной копии.');
      return { version: 2, activeProfileId: ids.has(value.activeProfileId) ? value.activeProfileId : profiles[0].id, profiles };
    }

    function restoreStore(v2, legacyV1) {
      if (v2 != null) {
        try { return normalizeStore(v2, false); }
        catch { /* Повреждённое хранилище не должно мешать восстановлению старого. */ }
      }
      if (object(legacyV1) && legacyV1.version === 1) {
        const profile = normalizeProfile({ baseline: 2075, ...legacyV1, id: id(), name: 'Мой персонаж', reputationConfirmed: false, needsReputationReview: true });
        return { version: 2, activeProfileId: profile.id, profiles: [profile] };
      }
      const profile = createProfile();
      return { version: 2, activeProfileId: profile.id, profiles: [profile] };
    }

    function exportBackup(store) {
      const normalized = normalizeStore(store, true);
      return { format: 'aca-route-planner', version: 1, exportedAt: new Date().toISOString(), profiles: normalized.profiles, activeProfileId: normalized.activeProfileId };
    }

    function importBackup(value) {
      if (!object(value) || value.format !== 'aca-route-planner' || value.version !== 1) throw new Error('Неизвестный формат или версия резервной копии.');
      if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) throw new Error('Некорректная дата резервной копии.');
      if (own(value, 'market')) {
        const market = value.market;
        if (!object(market) || market.region !== 'EU' || market.ruleset !== 'PvP' || market.faction !== 'Alliance') throw new Error('Резервная копия относится к другому рынку.');
      }
      return normalizeStore({ version: 2, profiles: value.profiles, activeProfileId: value.activeProfileId }, true);
    }

    return { createProfile, normalizeProfile, restoreStore, totalRep, earnedRep, setReputation, exportBackup, importBackup };
  }

  return { createContext };
});
