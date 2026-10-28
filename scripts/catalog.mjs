import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function normalizePath(filePath) {
  return String(filePath).replaceAll('\\', '/').replace(/\/+$/, '');
}

function unquoteScalar(value) {
  const trimmed = stripYamlComment(value).trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function findClosingQuote(value) {
  const firstNonWhitespace = value.search(/\S/);
  const quote = firstNonWhitespace >= 0 && ['"', "'"].includes(value[firstNonWhitespace])
    ? value[firstNonWhitespace] : null;
  if (!quote) return -1;
  for (let index = firstNonWhitespace + 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === '\\') {
      index += 1;
      continue;
    }
    if (character === quote) {
      if (quote === "'" && value[index + 1] === "'") {
        index += 1;
        continue;
      }
      return index;
    }
  }
  return -1;
}

function stripYamlComment(value) {
  const firstNonWhitespace = value.search(/\S/);
  const quoted = firstNonWhitespace >= 0 && ['"', "'"].includes(value[firstNonWhitespace]);
  const searchFrom = quoted ? findClosingQuote(value) + 1 : 0;
  if (quoted && searchFrom === 0) return value;
  for (let index = searchFrom; index < value.length; index += 1) {
    if (value[index] === '#' && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index);
  }
  return value;
}

function parseBlockScalar(lines, startIndex, marker, parentIndent) {
  const collected = [];
  let minimumIndent = Infinity;
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    const indent = line.match(/^\s*/)[0].length;
    if (line.trim() && indent <= parentIndent) break;
    if (line.trim()) minimumIndent = Math.min(minimumIndent, indent);
    collected.push(line);
    index += 1;
  }

  const indentationIndicator = marker.match(/[1-9]/)?.[0];
  const contentIndent = indentationIndicator
    ? parentIndent + Number(indentationIndicator)
    : Number.isFinite(minimumIndent) ? minimumIndent : parentIndent + 2;
  const values = collected.map((line) => line.trim() ? line.slice(contentIndent) : '');
  const moreIndented = collected.map((line) => line.trim() && line.match(/^\s*/)[0].length > contentIndent);
  const style = marker[0];
  const chomping = marker.includes('-') ? 'strip' : marker.includes('+') ? 'keep' : 'clip';
  let value;

  if (style === '|') {
    value = values.join('\n');
  } else {
    let firstContent = 0;
    while (firstContent < values.length && !values[firstContent]) firstContent += 1;
    value = `${'\n'.repeat(firstContent)}${values[firstContent] ?? ''}`;
    for (let lineIndex = firstContent + 1; lineIndex < values.length; lineIndex += 1) {
      const previous = values[lineIndex - 1];
      const current = values[lineIndex];
      if (!current) value += '\n';
      else if (!previous) value += current;
      else if (moreIndented[lineIndex - 1] || moreIndented[lineIndex]) value += `\n${current}`;
      else value += ` ${current}`;
    }
  }

  if (chomping === 'strip') value = value.replace(/\n+$/, '');
  else if (chomping === 'clip') value = value.replace(/\n*$/, '\n');
  else if (collected.length) value += '\n';

  return { value, nextIndex: index };
}

function parseSelectedYamlFields(content, fieldNames, scopeName) {
  const fields = {};
  const lines = String(content).replace(/^\uFEFF/, '').split(/\r?\n/);
  let scopeIndent = null;

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();

    if (scopeName && scopeIndent === null) {
      if (new RegExp(`^${scopeName}:\\s*(?:#.*)?$`).test(trimmed)) scopeIndent = indent;
      index += 1;
      continue;
    }
    if (scopeName && scopeIndent !== null && trimmed && indent <= scopeIndent) break;

    const match = line.match(/^\s*([A-Za-z_][\w-]*):(?:\s*(.*))?$/);
    if (!match || !fieldNames.has(match[1])) {
      index += 1;
      continue;
    }

    const rawValue = match[2] ?? '';
    if (/^[>|](?:[+-][1-9]?|[1-9][+-]?)?(?:\s+#.*)?$/.test(rawValue.trim())) {
      const parsed = parseBlockScalar(lines, index + 1, rawValue.trim().split(/\s+/)[0], indent);
      fields[match[1]] = parsed.value;
      index = parsed.nextIndex;
    } else if (/^\s*["']/.test(rawValue) && findClosingQuote(rawValue) < 0) {
      let combined = rawValue.trimStart();
      let continuation = index + 1;
      while (continuation < lines.length && findClosingQuote(combined) < 0) {
        combined += ` ${lines[continuation].trim()}`;
        continuation += 1;
      }
      fields[match[1]] = unquoteScalar(combined);
      index = continuation;
    } else {
      fields[match[1]] = unquoteScalar(rawValue);
      index += 1;
    }
  }
  return fields;
}

export function parseSkillFrontmatter(content) {
  const normalized = String(content).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  const match = normalized.match(/^---[ \t]*\n([\s\S]*?)\n---(?:[ \t]*\n|$)/);
  if (!match) return { name: '', description: '' };
  const fields = parseSelectedYamlFields(match[1], new Set(['name', 'description']));
  return {
    name: fields.name ?? '',
    description: fields.description ?? '',
  };
}

function parseOpenAiMetadata(content) {
  if (!content) return { display_name: '', short_description: '' };
  const fields = parseSelectedYamlFields(
    content,
    new Set(['display_name', 'short_description']),
    'interface',
  );
  return {
    display_name: fields.display_name ?? '',
    short_description: fields.short_description ?? '',
  };
}

export function detectSource(filePath) {
  const normalized = normalizePath(filePath);
  const lower = normalized.toLowerCase();
  if (lower.includes('/.codex/plugins/cache/')) return 'plugin';
  if (lower.includes('/.codex/skills/.system/')) return 'system';

  const home = normalizePath(os.homedir()).toLowerCase();
  if (lower.startsWith(`${home}/.codex/skills/`)) return 'personal';
  if (lower.startsWith(`${home}/.agents/skills/`)) return 'user';

  // Keep detection useful when catalogs are produced on a different machine.
  if (/^[a-z]:\/users\/[^/]+\/\.codex\/skills\//i.test(normalized)) return 'personal';
  if (/^[a-z]:\/users\/[^/]+\/\.agents\/skills\//i.test(normalized)) return 'user';
  if (lower.includes('/.agents/skills/') || lower.includes('/.codex/skills/')) return 'project';
  return 'unknown';
}

export function createStableSkillId(filePath, skillName, source = detectSource(filePath)) {
  const normalized = normalizePath(filePath);
  if (source === 'plugin') {
    const match = normalized.match(/\/\.codex\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+\/skills(?:\/[^/]+)*\/SKILL\.md$/i);
    if (match) return `plugin:${match[1]}/${match[2]}:${skillName}`;
    const fallback = normalized.match(/\/\.codex\/plugins\/cache\/([^/]+)\/([^/]+)/i);
    if (fallback) return `plugin:${fallback[1]}/${fallback[2]}:${skillName}`;
  }
  const pathComponent = createHash('sha256')
    .update(normalizePath(path.resolve(filePath)).toLowerCase())
    .digest('hex')
    .slice(0, 12);
  return `${source}:${skillName}:${pathComponent}`;
}

function pluginCacheParts(filePath) {
  const match = normalizePath(filePath).match(
    /\/\.codex\/plugins\/cache\/([^/]+)\/([^/]+)\/([^/]+)\/skills\//i,
  );
  return match ? { publisher: match[1], plugin: match[2], version: match[3] } : null;
}

function compareVersions(left, right) {
  const [leftCore, ...leftPrerelease] = left.split('-');
  const [rightCore, ...rightPrerelease] = right.split('-');
  const coreComparison = leftCore.localeCompare(rightCore, undefined, { numeric: true, sensitivity: 'base' });
  if (coreComparison !== 0) return coreComparison;
  const leftPre = leftPrerelease.join('-');
  const rightPre = rightPrerelease.join('-');
  if (!leftPre && rightPre) return 1;
  if (leftPre && !rightPre) return -1;
  return leftPre.localeCompare(rightPre, undefined, { numeric: true, sensitivity: 'base' });
}

function preferDiscovery(candidate, existing) {
  const candidatePlugin = pluginCacheParts(candidate.path);
  const existingPlugin = pluginCacheParts(existing.path);
  if (candidatePlugin && existingPlugin
    && candidatePlugin.publisher.toLowerCase() === existingPlugin.publisher.toLowerCase()
    && candidatePlugin.plugin.toLowerCase() === existingPlugin.plugin.toLowerCase()) {
    const versionComparison = compareVersions(candidatePlugin.version, existingPlugin.version);
    if (versionComparison !== 0) return versionComparison > 0;
  }
  return normalizePath(candidate.path).localeCompare(
    normalizePath(existing.path),
    undefined,
    { numeric: true, sensitivity: 'base' },
  ) > 0;
}

export function classifySkill(skill, categories) {
  const records = categories?.categories ?? [];
  const name = String(skill.name ?? skill.original_name ?? '').toLowerCase().replaceAll(/[_-]+/g, ' ');
  const description = String(skill.description ?? skill.original_description ?? '').toLowerCase();
  const positiveDescription = description
    .split(/(?<=[.!?;])\s+|\r?\n/)
    .filter((clause) => !/\b(?:do not use|don't use|not for|avoid using|never use)\b/.test(clause))
    .join(' ');
  const ranked = records
    .map((category, index) => ({ category, index }))
    .filter(({ category }) => category.id !== 'other' && Array.isArray(category.keywords))
    .sort((left, right) => (
      (Number(right.category.priority) || 0) - (Number(left.category.priority) || 0)
      || left.index - right.index
    ));

  const fallback = records.find((category) => category.id === 'other')?.id ?? records[0]?.id ?? 'other';
  const scored = ranked.map(({ category }) => {
    let evidence = 0;
    for (const rawKeyword of category.keywords) {
      const keyword = String(rawKeyword).trim().toLowerCase();
      if (!keyword) continue;
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const matcher = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
      if (matcher.test(name)) evidence += 100;
      if (matcher.test(positiveDescription)) evidence += 10;
    }
    return {
      id: category.id,
      evidence,
      score: evidence > 0 ? evidence * 1000 + (Number(category.priority) || 0) : 0,
    };
  }).filter((result) => result.evidence > 0).sort((left, right) => right.score - left.score);

  if (!scored.length || (scored[1] && scored[0].score === scored[1].score)) return fallback;
  return scored[0].id;
}

async function findSkillFiles(rootPath) {
  const results = [];
  const visited = new Set();
  async function visit(directory) {
    let canonical;
    try {
      canonical = await realpath(directory);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') return;
      throw error;
    }
    const visitKey = process.platform === 'win32'
      ? normalizePath(canonical).toLowerCase()
      : normalizePath(canonical);
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory() && new Set(['node_modules', '.git', 'dist', 'build']).has(entry.name.toLowerCase())) continue;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isSymbolicLink()) {
        try {
          const target = await stat(child);
          if (target.isDirectory()) await visit(child);
          else if (target.isFile() && entry.name.toLowerCase() === 'skill.md') results.push(child);
        } catch (error) {
          if (error?.code !== 'ENOENT' && error?.code !== 'EACCES') throw error;
        }
      }
      else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') results.push(child);
    }
  }
  await visit(rootPath);
  return results;
}

export async function discoverSkills(roots, categories, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const discoveries = [];

  for (const rootEntry of roots) {
    const root = typeof rootEntry === 'string' ? { path: rootEntry } : rootEntry;
    const files = await findSkillFiles(root.path);
    for (const skillPath of files) {
      const skillContent = await readFile(skillPath, 'utf8');
      const original = parseSkillFrontmatter(skillContent);
      if (!original.name) continue;

      const metadataPath = path.join(path.dirname(skillPath), 'agents', 'openai.yaml');
      let metadataContent = '';
      try {
        metadataContent = await readFile(metadataPath, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const localized = parseOpenAiMetadata(metadataContent);
      const metadataFingerprint = metadataContent
        ? createHash('sha256').update(metadataContent).digest('hex')
        : null;
      const source = root.source ?? detectSource(skillPath);
      discoveries.push({
        id: createStableSkillId(skillPath, original.name, source),
        source,
        path: skillPath,
        original_name: original.name,
        original_description: original.description,
        display_name: localized.display_name,
        short_description: localized.short_description,
        category: classifySkill(original, categories),
        localization_status: localized.display_name && localized.short_description ? 'ready' : 'pending',
        metadata_fingerprint: metadataFingerprint,
        available: true,
        fingerprint: createHash('sha256').update(skillContent).digest('hex'),
        last_seen: now,
      });
    }
  }

  const byId = new Map();
  for (const discovery of discoveries) {
    const existing = byId.get(discovery.id);
    if (!existing || preferDiscovery(discovery, existing)) {
      byId.set(discovery.id, discovery);
    }
  }
  const uniqueDiscoveries = [...byId.values()];
  const nameCounts = new Map();
  for (const discovery of uniqueDiscoveries) {
    const nameKey = discovery.original_name.toLowerCase();
    nameCounts.set(nameKey, (nameCounts.get(nameKey) ?? 0) + 1);
  }
  return uniqueDiscoveries
    .map((discovery) => ({
      ...discovery,
      duplicate_name: (nameCounts.get(discovery.original_name.toLowerCase()) ?? 0) > 1,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function mergeCatalog(previousCatalog, discoveredSkills, now = new Date().toISOString()) {
  const previous = new Map((previousCatalog?.skills ?? []).map((skill) => [skill.id, skill]));
  const discoveredIds = new Set(discoveredSkills.map((skill) => skill.id));
  const skills = discoveredSkills.map((skill) => {
    const existing = previous.get(skill.id);
    if (!existing) return skill;

    const diskLocalized = Boolean(skill.display_name && skill.short_description);
    const metadataChanged = existing.metadata_fingerprint
      && existing.metadata_fingerprint !== skill.metadata_fingerprint;
    const displayName = existing.display_name || skill.display_name;
    const shortDescription = existing.short_description || skill.short_description;
    const status = metadataChanged && skill.metadata_fingerprint
      ? 'repair-needed'
      : displayName && shortDescription ? 'ready' : 'pending';
    return {
      ...existing,
      ...skill,
      display_name: displayName,
      short_description: shortDescription,
      category: existing.category || skill.category,
      localization_status: status,
      metadata_fingerprint: skill.metadata_fingerprint,
    };
  });

  for (const existing of previous.values()) {
    if (!discoveredIds.has(existing.id)) skills.push({ ...existing, available: false });
  }

  skills.sort((left, right) => left.id.localeCompare(right.id));
  return {
    ...previousCatalog,
    schema_version: previousCatalog?.schema_version ?? 1,
    generated_at: now,
    skills,
  };
}
