export function getInboxCounts(skills = []) {
  return {
    pending: skills.filter((skill) => skill.available !== false && skill.localization_status === 'pending').length,
    repair: skills.filter((skill) => skill.available !== false && skill.localization_status === 'repair-needed').length,
    unavailable: skills.filter((skill) => skill.available === false).length,
  };
}

export function matchesInboxFilter(skill, filter) {
  if (!filter) return true;
  if (filter === 'pending') return skill.available !== false && skill.localization_status === 'pending';
  if (filter === 'repair') return skill.available !== false && skill.localization_status === 'repair-needed';
  if (filter === 'unavailable') return skill.available === false;
  return true;
}
