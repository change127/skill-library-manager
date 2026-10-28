import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultBackupRoot = path.resolve(moduleDirectory, '..', 'data', 'backups');
const localizedFields = [
  ['display_name', 'displayName'],
  ['short_description', 'shortDescription'],
];
let backupSequence = 0;

export function validateLocalizedMetadata(fields) {
  const displayName = fields?.displayName;
  const shortDescription = fields?.shortDescription;
  if (typeof displayName !== 'string' || !displayName.trim()) {
    throw new TypeError('Localized display name must be a nonempty string.');
  }
  if (!/\p{Script=Han}/u.test(displayName)) {
    throw new TypeError('Localized display name must contain Chinese content.');
  }
  if (typeof shortDescription !== 'string') {
    throw new TypeError('Localized short description must be a string.');
  }
  const length = [...shortDescription].length;
  if (length < 25 || length > 64) {
    throw new RangeError('Localized short description must contain 25 to 64 Unicode code points.');
  }
  if (!/\p{Script=Han}/u.test(shortDescription)) {
    throw new TypeError('Localized short description must contain Chinese content.');
  }
  return { displayName, shortDescription };
}

export async function updateSkillMetadata(skillDirectory, fields, options = {}) {
  const localized = validateLocalizedMetadata(fields);
  const context = await resolveSkillContext(skillDirectory);
  const backupRoot = path.resolve(options.backupRoot ?? defaultBackupRoot);
  return withSkillLock(context, backupRoot, options, async () => {
    const previous = await readOptionalMetadata(context.metadataPath);
    const content = updateYamlContent(previous.content, localized);
    const backupPath = await createMetadataBackup(context, previous, backupRoot);

    await mkdir(context.agentsPath, { recursive: true });
    await atomicWrite(context.metadataPath, content, {
      expectedPrevious: previous,
      beforeCommit: options._beforeCommit,
      validateParent: () => assertAgentsDirectorySafe(context.skillDirectory, context.agentsPath),
    });
    return {
      metadataPath: context.metadataPath,
      backupPath,
      previousExisted: previous.existed,
    };
  });
}

export async function restoreLatestMetadata(skillDirectory, options = {}) {
  const context = await resolveSkillContext(skillDirectory);
  const backupRoot = path.resolve(options.backupRoot ?? defaultBackupRoot);
  return withSkillLock(context, backupRoot, options, async () => {
    const selection = await findLatestBackup(context, backupRoot);
    const backup = selection.backup;
    if (!backup) throw new Error('No valid metadata backup exists for this Skill.');

    const current = await readOptionalMetadata(context.metadataPath);
    const safetyBackupPath = await createMetadataBackup(context, current, backupRoot);
    if (backup.record.existed) {
      await mkdir(context.agentsPath, { recursive: true });
      await atomicWrite(context.metadataPath, Buffer.from(backup.record.content_base64, 'base64'), {
        expectedPrevious: current,
        beforeCommit: options._beforeCommit,
        validateParent: () => assertAgentsDirectorySafe(context.skillDirectory, context.agentsPath),
      });
    } else if (current.existed) {
      if (options._beforeCommit) await options._beforeCommit({ targetPath: context.metadataPath });
      await assertAgentsDirectorySafe(context.skillDirectory, context.agentsPath);
      await assertUnchanged(context.metadataPath, current);
      await unlink(context.metadataPath);
    }

    return {
      metadataPath: context.metadataPath,
      restoredFrom: backup.path,
      restoredExisted: backup.record.existed,
      safetyBackupPath,
      ignoredBackupCount: selection.ignoredCount,
    };
  });
}

async function resolveSkillContext(skillDirectory) {
  if (typeof skillDirectory !== 'string' || !skillDirectory) {
    throw new TypeError('A Skill directory is required.');
  }
  let canonicalDirectory;
  try {
    canonicalDirectory = await realpath(path.resolve(skillDirectory));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Skill directory does not exist: ${skillDirectory}`);
    throw error;
  }

  const skillPath = path.join(canonicalDirectory, 'SKILL.md');
  let canonicalSkillPath;
  try {
    canonicalSkillPath = await realpath(skillPath);
    const skillStats = await lstat(canonicalSkillPath);
    if (!skillStats.isFile()) throw new Error('SKILL.md is not a file.');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Skill directory must contain SKILL.md: ${canonicalDirectory}`);
    throw error;
  }
  assertWithin(canonicalDirectory, canonicalSkillPath);

  const agentsPath = path.join(canonicalDirectory, 'agents');
  const metadataPath = path.join(agentsPath, 'openai.yaml');
  await assertAgentsDirectorySafe(canonicalDirectory, agentsPath);
  await assertExistingPathWithin(canonicalDirectory, metadataPath);
  return { skillDirectory: canonicalDirectory, agentsPath, metadataPath };
}

async function assertAgentsDirectorySafe(skillDirectory, agentsPath) {
  try {
    const stats = await lstat(agentsPath);
    if (stats.isSymbolicLink()) {
      throw new Error('Refusing a symlinked agents directory because it may resolve outside the supplied Skill directory.');
    }
    if (!stats.isDirectory()) throw new Error('The Skill agents path must be a directory.');
    assertWithin(skillDirectory, await realpath(agentsPath));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertExistingPathWithin(skillDirectory, candidatePath) {
  try {
    const canonical = await realpath(candidatePath);
    assertWithin(skillDirectory, canonical);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function assertWithin(skillDirectory, candidatePath) {
  const relative = path.relative(skillDirectory, candidatePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access a path outside the supplied Skill directory: ${candidatePath}`);
  }
}

async function readOptionalMetadata(metadataPath) {
  try {
    const bytes = await readFile(metadataPath);
    return { existed: true, bytes, content: bytes.toString('utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { existed: false, bytes: Buffer.alloc(0), content: '' };
    throw error;
  }
}

function updateYamlContent(content, fields) {
  if (!content) {
    return [
      'interface:',
      `  display_name: ${quoteYaml(fields.displayName)}`,
      `  short_description: ${quoteYaml(fields.shortDescription)}`,
      '',
    ].join('\n');
  }

  const lines = splitLinesPreservingTerminators(content);
  const preferredNewline = chooseNewline(lines);
  const hadFinalNewline = Boolean(lines.at(-1)?.eol);
  if (countTopLevelInterfaceMappings(lines) > 1) {
    throw new Error('Duplicate top-level interface mappings are not supported.');
  }
  let scope = findInterfaceScope(lines);

  if (!scope) {
    if (hasUnsupportedTopLevelInterface(lines)) {
      throw new Error('Unsupported top-level interface mapping style in agents/openai.yaml.');
    }
    if (lines.length && !lines.at(-1).eol) lines.at(-1).eol = preferredNewline;
    lines.push({ text: 'interface:', eol: preferredNewline });
    lines.push({ text: `  display_name: ${quoteYaml(fields.displayName)}`, eol: preferredNewline });
    lines.push({
      text: `  short_description: ${quoteYaml(fields.shortDescription)}`,
      eol: hadFinalNewline ? preferredNewline : '',
    });
  } else {
    assertSupportedLocalizedKeyForms(lines, scope);
    assertNoDuplicateManagedKeys(lines, scope);
    assertSafeManagedScalarForms(lines, scope);
    for (const [yamlName, propertyName] of localizedFields) {
      replaceOrInsertField(lines, scope, yamlName, fields[propertyName], preferredNewline);
      scope = findInterfaceScope(lines);
    }
  }
  return lines.map((line) => `${line.text}${line.eol}`).join('');
}

function findInterfaceScope(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = logicalLineText(lines, index).match(/^(interface):\s*(?:#.*)?$/);
    if (!match) continue;
    const indent = 0;
    let end = index + 1;
    while (end < lines.length) {
      const current = lines[end].text;
      if (current.trim() && indentation(current) <= indent) break;
      end += 1;
    }
    return { start: index, end, indent };
  }
  return null;
}

function hasUnsupportedTopLevelInterface(lines) {
  return lines.some((line, index) => (
    /^interface\s*:/.test(logicalLineText(lines, index))
    || /^(['"])interface\1\s*:/.test(logicalLineText(lines, index))
  ));
}

function countTopLevelInterfaceMappings(lines) {
  return lines.filter((line, index) => {
    const text = logicalLineText(lines, index);
    return /^interface\s*:/.test(text) || /^(['"])interface\1\s*:/.test(text);
  }).length;
}

function logicalLineText(lines, index) {
  const text = lines[index].text;
  return index === 0 && text.startsWith('\uFEFF') ? text.slice(1) : text;
}

function assertSupportedLocalizedKeyForms(lines, scope) {
  const childIndent = directChildIndent(lines, scope);
  for (let index = scope.start + 1; index < scope.end; index += 1) {
    const text = lines[index].text;
    if (indentation(text) !== childIndent) continue;
    const keyText = text.slice(childIndent);
    const quoted = keyText.match(/^(['"])(display_name|short_description)\1\s*:/);
    const spaced = keyText.match(/^(display_name|short_description)\s+:/);
    const field = quoted?.[2] ?? spaced?.[1];
    if (field) {
      throw new Error(`Unsupported ${field} key form inside the top-level interface mapping.`);
    }
  }
}

function assertNoDuplicateManagedKeys(lines, scope) {
  const childIndent = directChildIndent(lines, scope);
  const counts = new Map();
  for (let index = scope.start + 1; index < scope.end; index += 1) {
    const match = lines[index].text.match(
      new RegExp(`^\\s{${childIndent}}(display_name|short_description):`),
    );
    if (!match) continue;
    const count = (counts.get(match[1]) ?? 0) + 1;
    counts.set(match[1], count);
    if (count > 1) throw new Error(`Duplicate managed key ${match[1]} inside interface.`);
  }
}

function assertSafeManagedScalarForms(lines, scope) {
  const childIndent = directChildIndent(lines, scope);
  for (let index = scope.start + 1; index < scope.end; index += 1) {
    const match = lines[index].text.match(
      new RegExp(`^\\s{${childIndent}}(display_name|short_description):(.*)$`),
    );
    if (!match) continue;
    if (/^[&*!]/.test(match[2].trimStart())) {
      throw new Error(
        `Cannot update ${match[1]} because YAML anchors, tags, and aliases are unsupported on managed values.`,
      );
    }
  }
}

function replaceOrInsertField(lines, scope, yamlName, value, preferredNewline) {
  const childIndent = directChildIndent(lines, scope);
  const matcher = new RegExp(`^(\\s{${childIndent}})${yamlName}:(.*)$`);
  for (let index = scope.start + 1; index < scope.end; index += 1) {
    const match = lines[index].text.match(matcher);
    if (!match) continue;
    const valuePart = match[2];
    const scalar = scalarSpan(lines, index, scope.end, childIndent, valuePart);
    const replacement = {
      text: `${' '.repeat(childIndent)}${yamlName}: ${quoteYaml(value)}${scalar.comment}`,
      eol: lines[scalar.end - 1].eol,
    };
    lines.splice(index, scalar.end - index, replacement);
    return;
  }
  const previous = lines[scope.end - 1];
  const insertedAtEnd = scope.end === lines.length;
  const previousHadNewline = Boolean(previous?.eol);
  if (insertedAtEnd && previous && !previous.eol) previous.eol = preferredNewline;
  lines.splice(scope.end, 0, {
    text: `${' '.repeat(childIndent)}${yamlName}: ${quoteYaml(value)}`,
    eol: insertedAtEnd && !previousHadNewline ? '' : preferredNewline,
  });
}

function directChildIndent(lines, scope) {
  let smallest = Infinity;
  for (let index = scope.start + 1; index < scope.end; index += 1) {
    const line = lines[index].text;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = indentation(line);
    if (indent > scope.indent) smallest = Math.min(smallest, indent);
  }
  return Number.isFinite(smallest) ? smallest : scope.indent + 2;
}

function scalarSpan(lines, index, scopeEnd, fieldIndent, rawValue) {
  const trimmed = rawValue.trimStart();
  if (/^[>|](?:[+-][1-9]?|[1-9][+-]?)?(?:\s+#.*)?$/.test(trimmed)) {
    let end = index + 1;
    while (end < scopeEnd && (!lines[end].text.trim() || indentation(lines[end].text) > fieldIndent)) end += 1;
    return { end, comment: yamlCommentSuffix(rawValue) };
  }
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const sameLineClosing = closingQuoteIndex(trimmed, first, 1);
    if (sameLineClosing >= 0) {
      return {
        end: index + 1,
        comment: commentAfterClosingQuote(trimmed, sameLineClosing),
      };
    }
    let end = index + 1;
    while (end < scopeEnd) {
      const closing = closingQuoteIndex(lines[end].text, first, 0);
      end += 1;
      if (closing >= 0) {
        return {
          end,
          comment: commentAfterClosingQuote(lines[end - 1].text, closing),
        };
      }
    }
    return { end, comment: '' };
  }
  return { end: index + 1, comment: yamlCommentSuffix(rawValue) };
}

function yamlCommentSuffix(rawValue) {
  let quote = null;
  for (let index = 0; index < rawValue.length; index += 1) {
    const character = rawValue[index];
    if (quote === '"' && character === '\\') {
      index += 1;
      continue;
    }
    if (quote && character === quote) {
      if (quote === "'" && rawValue[index + 1] === "'") index += 1;
      else quote = null;
      continue;
    }
    if (!quote && (character === '"' || character === "'")) {
      quote = character;
      continue;
    }
    if (!quote && character === '#' && (index === 0 || /\s/.test(rawValue[index - 1]))) {
      return ` ${rawValue.slice(index).trimStart()}`;
    }
  }
  return '';
}

function closingQuoteIndex(value, quote, startIndex) {
  for (let index = startIndex; index < value.length; index += 1) {
    if (quote === '"' && value[index] === '\\') {
      index += 1;
      continue;
    }
    if (value[index] === quote) {
      if (quote === "'" && value[index + 1] === "'") index += 1;
      else return index;
    }
  }
  return -1;
}

function commentAfterClosingQuote(value, closingIndex) {
  const suffix = value.slice(closingIndex + 1);
  const match = suffix.match(/^\s+(#.*)$/);
  return match ? ` ${match[1]}` : '';
}

function splitLinesPreservingTerminators(content) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\r' && content[index + 1] === '\n') {
      lines.push({ text: content.slice(start, index), eol: '\r\n' });
      index += 1;
      start = index + 1;
    } else if (content[index] === '\n' || content[index] === '\r') {
      lines.push({ text: content.slice(start, index), eol: content[index] });
      start = index + 1;
    }
  }
  if (start < content.length) lines.push({ text: content.slice(start), eol: '' });
  return lines;
}

function chooseNewline(lines) {
  return lines.find((line) => line.eol)?.eol ?? '\n';
}

function indentation(line) {
  return line.match(/^\s*/)[0].length;
}

function quoteYaml(value) {
  return JSON.stringify(value);
}

async function withSkillLock(context, backupRoot, options, operation) {
  const directory = path.join(path.dirname(backupRoot), 'locks', skillStorageKey(context));
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, '.metadata.lock');
  const release = await acquireSkillLock(lockPath, {
    timeoutMs: options._lockTimeoutMs ?? 5_000,
    pollMs: options._lockPollMs ?? 25,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function acquireSkillLock(lockPath, settings) {
  const token = randomUUID();
  const deadline = Date.now() + Math.max(0, settings.timeoutMs);
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() })}\n`);
      } finally {
        await handle.close();
      }
      return async () => releaseSkillLock(lockPath, token);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for Skill metadata lock: ${lockPath}. `
          + 'Manual recovery is required only after confirming no Skill manager process is running.',
        );
      }
      await wait(Math.max(1, Math.min(settings.pollMs, deadline - Date.now())));
    }
  }
}

async function releaseSkillLock(lockPath, token) {
  try {
    const record = JSON.parse(await readFile(lockPath, 'utf8'));
    if (record.token !== token) return;
    await unlink(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createMetadataBackup(context, previous, backupRoot) {
  const directory = backupDirectory(context, backupRoot);
  await mkdir(directory, { recursive: true });
  const ordinal = await nextBackupOrdinal(context, directory);
  const createdAtEpochMs = Date.now();
  backupSequence = (backupSequence + 1) % 1_000_000;
  const sequence = backupSequence;
  const backupPath = path.join(
    directory,
    `${String(createdAtEpochMs).padStart(13, '0')}-${String(sequence).padStart(6, '0')}-${randomUUID()}.json`,
  );
  const record = {
    schema_version: 1,
    skill_directory: context.skillDirectory,
    metadata_path: context.metadataPath,
    existed: previous.existed,
    content_base64: previous.bytes.toString('base64'),
    created_at: new Date().toISOString(),
    created_at_epoch_ms: createdAtEpochMs,
    sequence,
    ordinal,
  };
  await atomicWrite(backupPath, `${JSON.stringify(record, null, 2)}\n`);
  return backupPath;
}

function backupDirectory(context, backupRoot) {
  return path.join(backupRoot, skillStorageKey(context));
}

function skillStorageKey(context) {
  const identity = process.platform === 'win32'
    ? context.skillDirectory.toLowerCase()
    : context.skillDirectory;
  return createHash('sha256').update(identity).digest('hex');
}

async function nextBackupOrdinal(context, directory) {
  let names = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let maximum = 0;
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (isValidBackupRecord(record, context)) maximum = Math.max(maximum, backupOrdinal(record));
    } catch {
      // Invalid backups never participate in ordering.
    }
  }
  if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error('Backup ordinal space is exhausted.');
  return maximum + 1;
}

async function findLatestBackup(context, backupRoot) {
  const directory = backupDirectory(context, backupRoot);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return { backup: null, ignoredCount: 0 };
    throw error;
  }
  const candidates = [];
  let ignoredCount = 0;
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const backupPath = path.join(directory, name);
    let record;
    try {
      record = JSON.parse(await readFile(backupPath, 'utf8'));
    } catch {
      ignoredCount += 1;
      continue;
    }
    if (!isValidBackupRecord(record, context)) {
      ignoredCount += 1;
      continue;
    }
    candidates.push({ path: backupPath, record });
  }
  candidates.sort((left, right) => {
    const ordinalDifference = backupOrdinal(right.record) - backupOrdinal(left.record);
    if (ordinalDifference) return ordinalDifference;
    const timeDifference = right.record.created_at_epoch_ms - left.record.created_at_epoch_ms;
    if (timeDifference) return timeDifference;
    return (right.record.sequence ?? 0) - (left.record.sequence ?? 0);
  });
  return { backup: candidates[0] ?? null, ignoredCount };
}

function isValidBackupRecord(record, context) {
  return record?.schema_version === 1
    && record.skill_directory === context.skillDirectory
    && typeof record.existed === 'boolean'
    && Number.isSafeInteger(record.created_at_epoch_ms)
    && record.created_at_epoch_ms >= 0
    && (record.sequence === undefined || Number.isSafeInteger(record.sequence))
    && (record.ordinal === undefined || (Number.isSafeInteger(record.ordinal) && record.ordinal > 0))
    && isCanonicalBase64(record.content_base64);
}

function backupOrdinal(record) {
  return Number.isSafeInteger(record.ordinal) ? record.ordinal : 0;
}

function isCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

async function atomicWrite(targetPath, content, options = {}) {
  if (options.validateParent) await options.validateParent();
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, content);
  try {
    if (options.beforeCommit) {
      await options.beforeCommit({ targetPath, temporaryPath });
    }
    if (options.validateParent) await options.validateParent();
    if (options.expectedPrevious) await assertUnchanged(targetPath, options.expectedPrevious);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

async function assertUnchanged(targetPath, expectedPrevious) {
  const current = await readOptionalMetadata(targetPath);
  if (current.existed !== expectedPrevious.existed || !current.bytes.equals(expectedPrevious.bytes)) {
    throw new Error(`Metadata write conflict: ${targetPath} changed concurrently.`);
  }
}
