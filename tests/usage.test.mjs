import assert from 'node:assert/strict';
import test from 'node:test';

import { getUsageCounts, matchesUsageView, sortSkillsForUsageView } from '../ui/usage.mjs';

const skills = [
  { id: 'a', original_name: 'alpha' },
  { id: 'b', original_name: 'beta' },
  { id: 'c', original_name: 'charlie' },
];
const usage = {
  schema_version: 1,
  favorites: ['a', 'c', 'missing'],
  recent: [
    { id: 'b', used_at: '2026-08-17T02:00:00.000Z' },
    { id: 'a', used_at: '2026-08-17T01:00:00.000Z' },
  ],
};

test('usage counts include only Skills present in the catalog', () => {
  assert.deepEqual(getUsageCounts(skills, usage), { favorites: 2, recent: 2 });
});

test('usage views filter favorites and recent Skills', () => {
  assert.equal(matchesUsageView(skills[0], 'favorites', usage), true);
  assert.equal(matchesUsageView(skills[1], 'favorites', usage), false);
  assert.equal(matchesUsageView(skills[1], 'recent', usage), true);
  assert.equal(matchesUsageView(skills[2], 'recent', usage), false);
  assert.equal(matchesUsageView(skills[2], 'all', usage), true);
});

test('available view excludes removed Skills while all retains history', () => {
  const removed = { id: 'old', available: false };
  assert.equal(matchesUsageView(skills[0], 'available', usage), true);
  assert.equal(matchesUsageView(removed, 'available', usage), false);
  assert.equal(matchesUsageView(removed, 'all', usage), true);
});

test('recent view follows persisted newest-first order', () => {
  assert.deepEqual(
    sortSkillsForUsageView(skills, 'recent', usage).map((skill) => skill.id),
    ['b', 'a', 'c'],
  );
});
