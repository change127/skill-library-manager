import path from 'node:path';

export function resolveManagerRoot({ isPackaged, home, moduleRoot, env = process.env }) {
  if (!isPackaged) return path.resolve(moduleRoot);
  return path.resolve(env.SKILL_MANAGER_ROOT || path.join(home, '.codex', 'skills', 'skill-library-manager'));
}

export function navigationAllowed(candidateUrl, appUrl) {
  try {
    const candidate = new URL(candidateUrl);
    const trusted = new URL(appUrl);
    return candidate.origin === trusted.origin && candidate.protocol === 'http:' && candidate.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}
