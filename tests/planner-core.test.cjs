'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createContext } = require('../dist/planner-core.js');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, '../dist', name), 'utf8'));
const data = read('data.json');
const routes = read('routes.json').routes;
const core = createContext({ writs: data.writs, routes });
const journeyman = data.writs.find(writ => writ.tier === 'JOURNEYMAN').quest;
const expert = data.writs.find(writ => writ.tier === 'EXPERT').quest;
const artisan = data.writs.find(writ => writ.tier === 'ARTISAN').quest;

test('new profiles have independent marks and unknown reputation', () => {
  const first = core.createProfile('Паладин');
  const second = core.createProfile('Маг');
  assert.notEqual(first.id, second.id);
  assert.equal(first.baseline, 0);
  assert.equal(first.goal, 9000);
  assert.equal(first.favorBalance, null);
  assert.equal(first.favorGoalMode, 'recipes');
  assert.equal(first.favorTarget, 0);
  assert.equal(first.favorLevel, 60);
  assert.equal(first.favorBonusRank, 0);
  assert.equal(first.favorProfession, 'all');
  assert.equal(core.totalRep(first), null);
  first.delivered.push(journeyman);
  first.favorRecipeIds.push(123);
  first.branches['kalimdor-south'].push('silithus');
  assert.deepEqual(second.delivered, []);
  assert.deepEqual(second.favorRecipeIds, []);
  assert.deepEqual(second.branches['kalimdor-south'], ['dustwallow']);
});

test('v1 migration preserves progress and requests review of its old total', () => {
  const legacy = {
    version: 1, baseline: 2075, bankedRep: 750, round: 2,
    writReady: [expert], itemReady: [expert], delivered: [journeyman, journeyman],
    routeId: 'kalimdor-south', branches: { 'kalimdor-south': ['wilderness', 'ortell'] },
  };
  const profile = core.restoreStore(null, legacy).profiles[0];
  assert.equal(profile.name, 'Мой персонаж');
  assert.equal(core.totalRep(profile), null);
  assert.equal(profile.baseline + profile.bankedRep + core.earnedRep(profile), 2900);
  assert.equal(profile.needsReputationReview, true);
  assert.deepEqual(profile.writReady, [expert]);
  assert.deepEqual(profile.itemReady, [expert]);
  assert.deepEqual(profile.branches['kalimdor-south'], ['torwa', 'silithus', 'ortell', 'dustwallow']);
  assert.equal(profile.southKalimdorRevision, 1);
  assert.equal(legacy.branches['kalimdor-south'][0], 'wilderness');
});

test('confirmation adjusts the baseline without clearing marks or double-counting', () => {
  const profile = core.normalizeProfile({ baseline: 2075, bankedRep: 1000, delivered: [journeyman, expert, artisan, artisan, -1], needsReputationReview: true });
  assert.equal(core.earnedRep(profile), 400);
  const marks = [...profile.delivered];
  core.setReputation(profile, 500, 21000);
  assert.equal(profile.baseline, -900);
  assert.equal(core.totalRep(profile), 500);
  assert.equal(profile.goal, 21000);
  assert.equal(profile.needsReputationReview, false);
  assert.deepEqual(profile.delivered, marks);
  const earned = core.earnedRep(profile);
  profile.bankedRep += earned;
  profile.delivered = [];
  assert.equal(core.totalRep(profile), 500);
});

test('normalization prunes removed data, dependencies, and invalid UI state', () => {
  const profile = core.normalizeProfile({
    routeId: 'removed', routeZone: -1, selectedStop: 'removed', catalogZone: 'removed', mapMode: 'broken',
    baseline: NaN, bankedRep: Infinity, round: 0, southKalimdorRevision: 1,
    writReady: [journeyman, journeyman, -1, null, 'bad'],
    branches: { removed: ['x'], 'kalimdor-south': ['ortell', 'removed'] },
  });
  assert.equal(profile.routeId, 'north');
  assert.equal(profile.routeZone, 1437);
  assert.equal(profile.selectedStop, '8305');
  assert.equal(profile.catalogZone, '1437');
  assert.equal(profile.mapMode, 'overview');
  assert.equal(profile.baseline, 0);
  assert.equal(profile.bankedRep, 0);
  assert.equal(profile.round, 1);
  assert.deepEqual(profile.writReady, [journeyman]);
  assert.deepEqual(profile.branches['kalimdor-south'], []);
  assert.equal(profile.branches.removed, undefined);
  assert.equal(core.normalizeProfile({ catalogZone: '1447' }).catalogZone, '1447');
});

test('backup round trip preserves profiles and original IDs without sharing arrays', () => {
  const first = core.createProfile('Паладин');
  core.setReputation(first, 42999, 42000);
  first.delivered = [artisan];
  const second = core.createProfile('Маг');
  const store = { version: 2, profiles: [first, second], activeProfileId: second.id };
  const backup = core.exportBackup(store);
  const imported = core.importBackup(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(imported, store);
  imported.profiles[0].delivered.push(expert);
  assert.deepEqual(first.delivered, [artisan]);
  assert.deepEqual(backup.profiles[0].delivered, [artisan]);
  assert.equal(core.restoreStore(store, { version: 1 }).activeProfileId, second.id);
});

test('Favor settings survive backup round trips independently for each character', () => {
  const profile = core.normalizeProfile({
    name: 'Кузнец', view: 'favor', favorBalance: 0, favorGoalMode: 'coins', favorTarget: 1200,
    favorRecipeIds: [101, 202, 101], favorLevel: 35, favorBonusRank: 3, favorProfession: 'BLACKSMITHING',
  });
  assert.deepEqual(profile.favorRecipeIds, [101, 202]);
  const backup = core.exportBackup({ version: 2, profiles: [profile], activeProfileId: profile.id });
  const restored = core.importBackup(backup).profiles[0];
  assert.deepEqual(restored, profile);
  restored.favorRecipeIds.push(303);
  assert.deepEqual(profile.favorRecipeIds, [101, 202]);
  assert.deepEqual(backup.profiles[0].favorRecipeIds, [101, 202]);
});

test('existing saves and backups without Favor fields receive defaults without losing progress', () => {
  const old = { id: 'existing', name: 'Паладин', baseline: 2075, bankedRep: 500, delivered: [journeyman], reputationConfirmed: true, view: 'shopping' };
  const store = core.restoreStore({ version: 2, profiles: [old], activeProfileId: old.id });
  assert.equal(core.totalRep(store.profiles[0]), 2650);
  assert.equal(store.profiles[0].view, 'shopping');
  assert.equal(store.profiles[0].favorBalance, null);
  const imported = core.importBackup({ format: 'aca-route-planner', version: 1, exportedAt: '2026-11-21T15:00:00Z', profiles: [old], activeProfileId: old.id });
  assert.equal(core.totalRep(imported.profiles[0]), 2650);
  assert.deepEqual(imported.profiles[0].favorRecipeIds, []);
  const migrated = core.restoreStore(null, { version: 1, ...old }).profiles[0];
  assert.equal(migrated.favorLevel, 60);
  assert.equal(migrated.baseline, old.baseline);
  assert.deepEqual(migrated.delivered, old.delivered);
});

test('strict import rejects invalid Favor settings and normalization preserves valid recipe IDs', () => {
  const profile = core.createProfile();
  const backup = core.exportBackup({ version: 2, profiles: [profile], activeProfileId: profile.id });
  for (const [key, value] of [
    ['favorBalance', -1], ['favorBalance', Infinity], ['favorBalance', '0'],
    ['favorGoalMode', 'rep'], ['favorTarget', 1.5], ['favorTarget', NaN],
    ['favorLevel', 0], ['favorLevel', 61], ['favorBonusRank', 4], ['favorBonusRank', '1'],
    ['favorProfession', 'MINING'], ['favorProfession', 'alchemy'],
    ['favorRecipeIds', null], ['favorRecipeIds', [0]], ['favorRecipeIds', [123, '202']],
  ]) {
    const input = structuredClone(backup);
    input.profiles[0][key] = value;
    assert.throws(() => core.importBackup(input), key);
  }
  const repaired = core.normalizeProfile({ favorRecipeIds: [123, null, -1, 202, 123], favorBalance: NaN });
  assert.deepEqual(repaired.favorRecipeIds, [123, 202]);
  assert.equal(repaired.favorBalance, null);
});

test('strict import rejects malformed fields and unsupported envelopes', () => {
  const profile = core.createProfile();
  const backup = core.exportBackup({ version: 2, profiles: [profile], activeProfileId: profile.id });
  const reject = change => {
    const value = structuredClone(backup);
    change(value);
    assert.throws(() => core.importBackup(value));
  };
  reject(value => { value.version = 2; });
  reject(value => { value.profiles = []; });
  reject(value => { value.profiles = [null]; });
  reject(value => { value.profiles.push({ ...value.profiles[0] }); });
  reject(value => { value.activeProfileId = 'missing'; });
  reject(value => { value.exportedAt = 'not a date'; });
  reject(value => { value.market = { region: 'US', ruleset: 'PvP', faction: 'Alliance' }; });
  for (const [key, value] of [['baseline', NaN], ['bankedRep', Infinity], ['round', -1], ['goal', 5000], ['reputationConfirmed', 'yes'], ['delivered', [null]], ['branches', []], ['name', ' ']]) {
    reject(backup => { backup.profiles[0][key] = value; });
  }
  reject(value => { value.profiles[0].branches.north = 'bad'; });
  const compatible = structuredClone(backup);
  compatible.profiles[0].delivered = [journeyman, -1];
  compatible.profiles[0].routeId = 'retired-route';
  assert.deepEqual(core.importBackup(compatible).profiles[0].delivered, [journeyman]);
});

test('invalid reputation input cannot mutate a profile', () => {
  const profile = core.createProfile();
  const previous = structuredClone(profile);
  for (const value of [-1, 43000, NaN, Infinity, 1.5, '3000']) assert.throws(() => core.setReputation(profile, value, 9000));
  assert.throws(() => core.setReputation(profile, 3000, 8000));
  assert.deepEqual(profile, previous);
});

test('module exposes the same API in a browser without DOM or storage', () => {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/planner-core.js'), 'utf8'), sandbox);
  const browserCore = sandbox.ACAPlanner.createContext({ writs: data.writs, routes });
  assert.equal(browserCore.totalRep(browserCore.createProfile('Паладин')), null);
});
