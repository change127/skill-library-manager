export function getUsageCounts(skills = [], usage = {}) {
  const catalogIds = new Set(skills.map((skill) => skill.id));
  return {
    favorites: (usage.favorites ?? []).filter((id) => catalogIds.has(id)).length,
    recent: (usage.recent ?? []).filter((entry) => catalogIds.has(entry.id)).length,
  };
}

export function matchesUsageView(skill, view, usage = {}) {
  if (view === 'available') return skill.available !== false;
  if (view === 'favorites') return (usage.favorites ?? []).includes(skill.id);
  if (view === 'recent') return (usage.recent ?? []).some((entry) => entry.id === skill.id);
  return true;
}

export function sortSkillsForUsageView(skills, view, usage = {}) {
  if (view !== 'recent') return [...skills];
  const order = new Map((usage.recent ?? []).map((entry, index) => [entry.id, index]));
  return [...skills].sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}
