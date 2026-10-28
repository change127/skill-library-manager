#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, rename, rm, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverSkills, mergeCatalog, parseSkillFrontmatter } from './catalog.mjs';
import {
  restoreLatestMetadata,
  updateSkillMetadata,
  validateLocalizedMetadata,
} from './metadata.mjs';

const installedSkillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMPTY_USAGE = { schema_version: 1, favorites: [], recent: [] };
const RECENT_LIMIT = 20;

export function resolveDefaultPaths(options = {}) {
  const home = options.home ?? os.homedir();
  const skillRoot = path.resolve(options.skillRoot ?? installedSkillRoot);
  const projectRoots = options.projectRoots ?? [];
  return {
    roots: [
      { path: path.join(home, '.codex', 'skills') },
      { path: path.join(home, '.agents', 'skills') },
      { path: path.join(home, '.codex', 'plugins', 'cache') },
      ...projectRoots.map((root) => typeof root === 'string' ? { path: root, source: 'project' } : root),
    ],
    catalogPath: path.join(skillRoot, 'data', 'catalog.json'),
    categoriesPath: path.join(skillRoot, 'data', 'categories.json'),
    settingsPath: path.join(skillRoot, 'data', 'settings.json'),
    usagePath: path.join(skillRoot, 'data', 'usage.json'),
    snapshotPath: path.join(skillRoot, 'data', 'install-snapshot.json'),
    backupRoot: path.join(skillRoot, 'data', 'backups'),
  };
}

export function createManager(options = {}) {
  const config = { ...resolveDefaultPaths(options), ...options };
  const managerLockPath = `${config.catalogPath}.manager.lock`;
  const lockContext = new AsyncLocalStorage();
  const timestamp = () => typeof config.now === 'function'
    ? config.now()
    : config.now ?? new Date().toISOString();

  async function readData(filePath, fallback) {
    try {
      return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
      throw error;
    }
  }

  async function scan() {
    return withManagerLock(async () => {
    let catalogBytes;
    try { catalogBytes = await readFile(config.catalogPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const [previous, categories] = await Promise.all([
      readData(config.catalogPath, { schema_version: 1, generated_at: null, skills: [] }),
      readData(config.categoriesPath),
    ]);
    const discovered = await discoverSkills(config.roots, categories, { now: timestamp() });
    const catalog = mergeCatalog(previous, discovered, timestamp());
    if (config._beforeScanWrite) await config._beforeScanWrite();
    if (catalogBytes) {
      const currentBytes = await readFile(config.catalogPath);
      if (!currentBytes.equals(catalogBytes)) throw new Error('Catalog changed concurrently; retry scan.');
    }
    await atomicWriteJson(config.catalogPath, catalog);
    return catalog;
    });
  }

  async function readCatalog() {
    return readData(config.catalogPath, { schema_version: 1, generated_at: null, skills: [] });
  }

  async function snapshot() {
    return withManagerLock(async () => {
    const catalog = await scan();
    const result = {
      schema_version: 1,
      created_at: timestamp(),
      skills: catalog.skills
        .filter((skill) => skill.available)
        .map(({ id, fingerprint }) => ({ id, fingerprint })),
    };
    await atomicWriteJson(config.snapshotPath, result);
    return result;
    });
  }

  async function changes() {
    const [catalog, before] = await Promise.all([
      readData(config.catalogPath),
      readData(config.snapshotPath),
    ]);
    const prior = new Map(before.skills.map((skill) => [skill.id, skill.fingerprint]));
    const current = catalog.skills.filter((skill) => skill.available);
    return {
      new: current.filter((skill) => !prior.has(skill.id)),
      changed: current.filter((skill) => prior.has(skill.id) && prior.get(skill.id) !== skill.fingerprint),
      unchanged: current.filter((skill) => prior.get(skill.id) === skill.fingerprint),
    };
  }

  async function apply(input) {
    return withManagerLock(async () => {
    const [catalog, categories, settings] = await Promise.all([
      readData(config.catalogPath),
      readData(config.categoriesPath),
      readData(config.settingsPath),
    ]);
    const skill = findSkill(catalog, input.id);
    const currentSkill = await discoverRecord(skill.id);
    if (currentSkill.id !== skill.id) throw new Error(`Skill identity changed; re-run scan: ${skill.id}`);
    assertCategory(categories, input.category);
    const policy = settings?.localization?.source_policy?.[skill.source] ?? 'require_confirmation';
    if (policy !== 'auto_apply' && !input.confirmed) {
      throw new Error(`Source policy requires confirmation for ${skill.source} Skills.`);
    }
    const localized = validateLocalizedMetadata({
      displayName: input.displayName,
      shortDescription: input.shortDescription,
    });
    const metadata = await updateSkillMetadata(path.dirname(currentSkill.path), localized, {
      backupRoot: config.backupRoot,
    });
    const refreshed = await discoverRecord(skill.id);
    const updated = {
      ...skill,
      ...refreshed,
      display_name: localized.displayName,
      short_description: localized.shortDescription,
      category: input.category,
      localization_status: 'ready',
    };
    replaceSkill(catalog, updated);
    catalog.generated_at = timestamp();
    try {
      await atomicWriteJson(config.catalogPath, catalog);
    } catch (error) {
      try {
        await restoreLatestMetadata(path.dirname(currentSkill.path), { backupRoot: config.backupRoot });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Catalog write failed and metadata rollback failed for ${skill.id}; repair is required.`);
      }
      throw error;
    }
    return { skill: updated, metadata };
    });
  }

  async function restore(input) {
    return withManagerLock(async () => {
    const catalog = await readData(config.catalogPath);
    const skill = findSkill(catalog, input.id);
    const metadata = await restoreLatestMetadata(path.dirname(skill.path), { backupRoot: config.backupRoot });
    const categories = await readData(config.categoriesPath);
    const discovered = await discoverSkills(config.roots, categories, { now: timestamp() });
    const restoredRecord = discovered.find((record) => record.id === skill.id);
    if (!restoredRecord) throw new Error(`Skill is no longer available: ${skill.id}`);
    const previousForMerge = {
      ...catalog,
      skills: catalog.skills.map((record) => record.id === skill.id ? {
        ...record,
        display_name: restoredRecord.display_name,
        short_description: restoredRecord.short_description,
        localization_status: restoredRecord.localization_status,
      } : record),
    };
    const merged = mergeCatalog(previousForMerge, discovered, timestamp());
    await atomicWriteJson(config.catalogPath, merged);
    return { skill: findSkill(merged, skill.id), catalog: merged, metadata };
    });
  }

  async function discoverRecord(id) {
    const categories = await readData(config.categoriesPath);
    const found = await discoverSkills(config.roots, categories, { now: timestamp() });
    const record = found.find((skill) => skill.id === id);
    if (!record) throw new Error(`Skill is no longer available: ${id}`);
    return record;
  }

  async function categoriesList() {
    return readData(config.categoriesPath);
  }

  async function categoriesAdd(input) {
    return withManagerLock(async () => {
    validateCategoryInput(input.id, input.name);
    const beforeBytes = await readFile(config.categoriesPath);
    const data = JSON.parse(beforeBytes);
    ensureUniqueCategory(data.categories, input.id, input.name);
    const maxOrder = Math.max(0, ...data.categories.map((category) => Number(category.order) || 0));
    data.categories.push({
      id: input.id,
      name: input.name,
      order: input.order ?? maxOrder + 10,
      priority: input.priority ?? 0,
      keywords: input.keywords ?? [],
    });
    if (!(await readFile(config.categoriesPath)).equals(beforeBytes)) throw new Error('Categories changed concurrently; retry.');
    await atomicWriteJson(config.categoriesPath, data);
    return data;
    });
  }

  async function categoriesRename(input) {
    return withManagerLock(async () => {
    const newId = input.newId ?? input.id;
    validateCategoryInput(newId, input.name);
    const [data, catalog] = await Promise.all([
      readData(config.categoriesPath),
      readData(config.catalogPath),
    ]);
    const category = data.categories.find((item) => item.id === input.id);
    if (!category) throw new Error(`Unknown category: ${input.id}`);
    ensureUniqueCategory(data.categories, newId, input.name, input.id);
    category.id = newId;
    category.name = input.name;
    for (const skill of catalog.skills) {
      if (skill.category === input.id) skill.category = newId;
    }
    const originalCategories = await readFile(config.categoriesPath);
    const originalCatalog = await readFile(config.catalogPath);
    const writtenCategories = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
    let categoriesWritten = false;
    try {
      if (!(await readFile(config.categoriesPath)).equals(originalCategories)
        || !(await readFile(config.catalogPath)).equals(originalCatalog)) throw new Error('Manager state changed concurrently; retry.');
      await atomicWriteJson(config.categoriesPath, data);
      categoriesWritten = true;
      if (config._beforeCatalogWrite) await config._beforeCatalogWrite();
      if (!(await readFile(config.categoriesPath)).equals(writtenCategories)) {
        throw new Error('Categories changed concurrently before catalog commit.');
      }
      await atomicWriteJson(config.catalogPath, catalog);
    } catch (error) {
      if (categoriesWritten) {
        const currentCategories = await readFile(config.categoriesPath);
        if (currentCategories.equals(writtenCategories)) {
          await atomicWriteBytes(config.categoriesPath, originalCategories);
        } else {
          throw new Error(`${error.message}; partial transaction detected, recovery required.`);
        }
      }
      throw error;
    }
    return { categories: data.categories, migrated: catalog.skills.filter((skill) => skill.category === newId).length };
    });
  }

  async function usageList() {
    return readData(config.usagePath, EMPTY_USAGE);
  }

  async function favoriteSet(input) {
    if (typeof input.favorite !== 'boolean') throw new Error('favorite must be a boolean.');
    return withManagerLock(async () => {
      const [catalog, usage] = await Promise.all([
        readData(config.catalogPath),
        readData(config.usagePath, EMPTY_USAGE),
      ]);
      findSkill(catalog, input.id);
      assertValidUsage(usage);
      const favorites = new Set(usage.favorites);
      if (input.favorite) favorites.add(input.id);
      else favorites.delete(input.id);
      usage.favorites = [...favorites];
      await atomicWriteJson(config.usagePath, usage);
      return usage;
    });
  }

  async function recordUse(input) {
    return withManagerLock(async () => {
      const [catalog, usage] = await Promise.all([
        readData(config.catalogPath),
        readData(config.usagePath, EMPTY_USAGE),
      ]);
      findSkill(catalog, input.id);
      assertValidUsage(usage);
      usage.recent = [
        { id: input.id, used_at: timestamp() },
        ...usage.recent.filter((entry) => entry.id !== input.id),
      ].slice(0, RECENT_LIMIT);
      await atomicWriteJson(config.usagePath, usage);
      return usage;
    });
  }

  async function withManagerLock(operation) {
    if (lockContext.getStore() === true) return operation();
    const deadline = Date.now() + (config.lockTimeoutMs ?? 5000);
    while (true) {
      try {
        await mkdir(path.dirname(managerLockPath), { recursive: true });
        await mkdir(managerLockPath);
        try { return await lockContext.run(true, operation); }
        finally { await rm(managerLockPath, { recursive: true, force: true }); }
      } catch (error) {
        if (error?.code !== 'EEXIST' || Date.now() >= deadline) {
          if (error?.code === 'EEXIST') throw new Error('Manager state is locked; retry later.');
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  async function validate() {
    const errors = [];
    let catalog;
    let categories;
    let settings;
    let usage;
    try { catalog = await readData(config.catalogPath); } catch (error) { errors.push(`catalog: ${error.message}`); }
    try { categories = await readData(config.categoriesPath); } catch (error) { errors.push(`categories: ${error.message}`); }
    try { settings = await readData(config.settingsPath); } catch (error) { errors.push(`settings: ${error.message}`); }
    try { usage = await readData(config.usagePath, EMPTY_USAGE); } catch (error) { errors.push(`usage: ${error.message}`); }

    if (catalog?.schema_version !== 1) errors.push('catalog schema_version must be 1.');
    if (!Array.isArray(catalog?.skills)) errors.push('catalog.skills must be an array.');
    if (categories?.schema_version !== 1) errors.push('categories schema_version must be 1.');
    if (!Array.isArray(categories?.categories) || categories.categories.length === 0) {
      errors.push('categories.categories must be a nonempty array.');
    }
    if (settings?.schema_version !== 1) errors.push('settings schema_version must be 1.');
    if (!settings?.localization?.source_policy || typeof settings.localization.source_policy !== 'object') {
      errors.push('settings.localization.source_policy must be an object.');
    } else {
      for (const [source, policy] of Object.entries(settings.localization.source_policy)) {
        if (!['auto_apply', 'require_confirmation'].includes(policy)) {
          errors.push(`Invalid source policy for ${source}: ${policy}`);
        }
      }
    }
    const categoryIds = new Set();
    const categoryNames = new Set();
    for (const category of categories?.categories ?? []) {
      if (typeof category.id !== 'string' || !category.id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category.id)) errors.push(`category ${category.id}: invalid id.`);
      if (typeof category.name !== 'string' || !category.name.trim()) errors.push(`category ${category.id}: name must be a nonempty string.`);
      if (!Number.isFinite(Number(category.order))) errors.push(`category ${category.id}: order must be numeric.`);
      if (!Number.isFinite(Number(category.priority))) errors.push(`category ${category.id}: priority must be numeric.`);
      if (!Array.isArray(category.keywords)) errors.push(`category ${category.id}: keywords must be an array.`);
      if (categoryIds.has(category.id) || categoryNames.has(category.name)) errors.push(`categories must be unique: ${category.id}`);
      categoryIds.add(category.id);
      categoryNames.add(category.name);
    }
    const skillIds = new Set();
    for (const skill of catalog?.skills ?? []) {
      const label = skill.id ?? '(missing id)';
      if (!skill.id || !skill.source || !skill.path || !skill.original_name || !skill.original_description) {
        errors.push(`catalog Skill is incomplete: ${label}; re-run scan.`);
      }
      if (typeof skill.available !== 'boolean') errors.push(`${label}: available must be true or false; re-run scan.`);
      if (!/^[a-f0-9]{64}$/i.test(String(skill.fingerprint ?? ''))) {
        errors.push(`${label}: fingerprint is missing or invalid; re-run scan.`);
      }
      if (!String(skill.last_seen ?? '').trim()) errors.push(`${label}: last_seen is required; re-run scan.`);
      if (!['pending', 'ready', 'repair-needed'].includes(skill.localization_status)) {
        errors.push(`${label}: localization_status must be pending, ready, or repair-needed; re-run scan.`);
      }
      const hasLocalized = Boolean(skill.display_name && skill.short_description);
      if (skill.localization_status === 'ready' && !hasLocalized) {
        errors.push(`${label}: localization_status ready requires localized fields.`);
      }
      if (skill.localization_status === 'pending' && hasLocalized) {
        errors.push(`${label}: localization_status pending conflicts with localized fields.`);
      }
      if (skillIds.has(skill.id)) errors.push(`catalog contains duplicate id: ${skill.id}`);
      skillIds.add(skill.id);
      if (!categoryIds.has(skill.category)) errors.push(`catalog Skill ${skill.id} has unknown category: ${skill.category}`);
      if (skill.display_name || skill.short_description) {
        try {
          validateLocalizedMetadata({ displayName: skill.display_name, shortDescription: skill.short_description });
        } catch (error) {
          errors.push(`metadata for ${skill.id}: ${error.message}`);
        }
      }
      if (skill.path) {
        let contained = false;
        try {
          const canonicalSkill = await realpath(skill.path);
          for (const rootEntry of config.roots) {
            const rootPath = await realpath(typeof rootEntry === 'string' ? rootEntry : rootEntry.path).catch(() => null);
            if (rootPath && (canonicalSkill === rootPath || canonicalSkill.startsWith(`${rootPath}${path.sep}`))) { contained = true; break; }
          }
        } catch { /* handled below */ }
        if (!contained) {
          try { await realpath(skill.path); errors.push(`${label}: path is outside configured Skill roots; re-run scan.`); continue; }
          catch { /* missing path gets the actionable missing-file error below */ }
        }
        let sourceContent;
        try {
          sourceContent = await readFile(skill.path, 'utf8');
        } catch (error) {
          if (error?.code !== 'ENOENT') errors.push(`${label}: cannot read SKILL.md at ${skill.path}: ${error.message}`);
        }
        if (sourceContent === undefined) {
          if (skill.available === true) errors.push(`${label}: available=true but SKILL.md is missing at ${skill.path}; re-run scan.`);
        } else {
          if (skill.available === false) errors.push(`${label}: available=false but SKILL.md exists at ${skill.path}; re-run scan.`);
          const source = parseSkillFrontmatter(sourceContent);
          if (skill.original_name !== source.name) {
            errors.push(`${label}: original_name does not match SKILL.md; re-run scan.`);
          }
          if (skill.original_description !== source.description) {
            errors.push(`${label}: original_description does not match SKILL.md; re-run scan.`);
          }
          const currentFingerprint = createHash('sha256').update(sourceContent).digest('hex');
          if (skill.fingerprint !== currentFingerprint) {
            errors.push(`${label}: fingerprint does not match SKILL.md; re-run scan.`);
          }
        }
      }
    }
    errors.push(...usageValidationErrors(usage, skillIds));
    return { valid: errors.length === 0, errors };
  }

  return {
    readCatalog,
    scan,
    snapshot,
    changes,
    apply,
    restore,
    categoriesList,
    categoriesAdd,
    categoriesRename,
    usageList,
    favoriteSet,
    recordUse,
    validate,
    paths: config,
  };
}

function usageValidationErrors(usage, catalogIds) {
  const errors = [];
  if (usage?.schema_version !== 1) errors.push('usage schema_version must be 1.');
  if (!Array.isArray(usage?.favorites)) {
    errors.push('usage.favorites must be an array.');
  } else {
    if (new Set(usage.favorites).size !== usage.favorites.length) errors.push('usage.favorites must contain unique Skill ids.');
    for (const id of usage.favorites) {
      if (typeof id !== 'string' || !id) errors.push('usage.favorites must contain nonempty Skill ids.');
      else if (catalogIds && !catalogIds.has(id)) errors.push(`usage.favorites contains unknown Skill id: ${id}`);
    }
  }
  if (!Array.isArray(usage?.recent)) {
    errors.push('usage.recent must be an array.');
  } else {
    if (usage.recent.length > RECENT_LIMIT) errors.push(`usage.recent must contain at most ${RECENT_LIMIT} entries.`);
    const recentIds = new Set();
    for (const entry of usage.recent) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push('usage.recent entries must be objects.');
        continue;
      }
      if (typeof entry.id !== 'string' || !entry.id) errors.push('usage.recent entries require a nonempty id.');
      else {
        if (recentIds.has(entry.id)) errors.push('usage.recent Skill ids must be unique.');
        recentIds.add(entry.id);
        if (catalogIds && !catalogIds.has(entry.id)) errors.push(`usage.recent contains unknown Skill id: ${entry.id}`);
      }
      if (typeof entry.used_at !== 'string' || !Number.isFinite(Date.parse(entry.used_at))) {
        errors.push('usage.recent used_at must be a valid timestamp.');
      }
    }
  }
  return errors;
}

function assertValidUsage(usage) {
  const errors = usageValidationErrors(usage);
  if (errors.length) throw new Error(`Invalid usage data: ${errors.join(' ')}`);
}

function findSkill(catalog, id) {
  const skill = catalog.skills.find((item) => item.id === id);
  if (!skill) throw new Error(`Unknown Skill id: ${id}`);
  if (!skill.available) throw new Error(`Skill is unavailable: ${id}`);
  return skill;
}

function replaceSkill(catalog, record) {
  const index = catalog.skills.findIndex((skill) => skill.id === record.id);
  if (index < 0) throw new Error(`Unknown Skill id: ${record.id}`);
  catalog.skills[index] = record;
}

function assertCategory(categories, categoryId) {
  if (!categories.categories.some((category) => category.id === categoryId)) {
    throw new Error(`Unknown category: ${categoryId}`);
  }
}

function validateCategoryInput(id, name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(id ?? ''))) {
    throw new Error('Category id must use lowercase letters, digits, and hyphens.');
  }
  if (!String(name ?? '').trim()) throw new Error('Category name is required.');
}

function ensureUniqueCategory(categories, id, name, exceptId) {
  if (categories.some((item) => item.id !== exceptId && (item.id === id || item.name === name))) {
    throw new Error('Category id and name must each be unique.');
  }
}

async function atomicWriteJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function atomicWriteBytes(targetPath, content) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.rollback.tmp`;
  try { await writeFile(temporaryPath, content); await rename(temporaryPath, targetPath); }
  finally { await rm(temporaryPath, { force: true }); }
}

function parseOptions(args) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (Object.prototype.hasOwnProperty.call(options, key)) throw new Error(`Duplicate option --${value.slice(2)}`);
    if (['json', 'confirmed'].includes(key)) options[key] = true;
    else {
      if (index + 1 >= args.length || String(args[index + 1]).startsWith('--')) {
        throw new Error(`Missing value for --${value.slice(2)}`);
      }
      options[key] = args[++index];
    }
  }
  return { positionals, options };
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  let parsed;
  try { parsed = parseOptions(argv); } catch (error) {
    const io = dependencies.io ?? { stdout: () => {}, stderr: (value) => process.stderr.write(`${value}\n`) };
    io.stderr(`Error: ${error.message}`);
    return 1;
  }
  const { positionals, options } = parsed;
  const command = positionals[0];
  const allowed = {
    scan: ['json', 'projectRoot'], snapshot: ['json'], changes: ['json'], validate: ['json'],
    apply: ['json', 'id', 'displayName', 'shortDescription', 'category', 'confirmed'],
    restore: ['json', 'id'],
  };
  const commandKey = command === 'categories' ? `categories ${positionals[1]}` : command;
  const categoryAllowed = {
    'categories list': ['json'], 'categories add': ['json', 'id', 'name', 'order', 'priority', 'keywords'],
    'categories rename': ['json', 'id', 'newId', 'name'],
  };
  const allowedKeys = allowed[command] ?? categoryAllowed[commandKey];
  if (!allowedKeys) {
    const io = dependencies.io ?? { stdout: () => {}, stderr: (value) => process.stderr.write(`${value}\n`) };
    io.stderr('Error: Unknown command.');
    return 1;
  }
  const positionalCounts = {
    scan: [1], snapshot: [1], changes: [1], validate: [1], apply: [1], restore: [1],
    'categories list': [2], 'categories add': [2], 'categories rename': [2],
  };
  if (!positionalCounts[commandKey]?.includes(positionals.length)) {
    const io = dependencies.io ?? { stdout: () => {}, stderr: (value) => process.stderr.write(`${value}\n`) };
    io.stderr('Error: Invalid positional arguments.');
    return 1;
  }
  const required = { apply: ['id', 'displayName', 'shortDescription', 'category'], restore: ['id'], 'categories add': ['id', 'name'], 'categories rename': ['id', 'name'] }[commandKey] ?? [];
  const missing = required.find((key) => options[key] === undefined);
  if (missing) {
    const io = dependencies.io ?? { stdout: () => {}, stderr: (value) => process.stderr.write(`${value}\n`) };
    io.stderr(`Error: Missing required option --${missing.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    return 1;
  }
  const unknown = Object.keys(options).find((key) => !allowedKeys.includes(key));
  if (unknown) {
    const io = dependencies.io ?? { stdout: () => {}, stderr: (value) => process.stderr.write(`${value}\n`) };
    io.stderr(`Error: Unknown option --${unknown.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    return 1;
  }
  const manager = dependencies.manager ?? createManager({
    projectRoots: options.projectRoot ? [options.projectRoot] : [],
  });
  const io = dependencies.io ?? {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
  };
  try {
    let result;
    if (command === 'scan') result = await manager.scan();
    else if (command === 'snapshot') result = await manager.snapshot();
    else if (command === 'changes') result = await manager.changes();
    else if (command === 'apply') result = await manager.apply(options);
    else if (command === 'restore') result = await manager.restore(options);
    else if (command === 'validate') result = await manager.validate();
    else if (command === 'categories' && positionals[1] === 'list') result = await manager.categoriesList();
    else if (command === 'categories' && positionals[1] === 'add') result = await manager.categoriesAdd(options);
    else if (command === 'categories' && positionals[1] === 'rename') result = await manager.categoriesRename(options);
    else throw new Error('Usage: manager.mjs scan|snapshot|changes|apply|restore|validate|categories list|add|rename [options]');
    io.stdout(options.json ? JSON.stringify(result) : formatHuman(command, result));
    return command === 'validate' && !result.valid ? 1 : 0;
  } catch (error) {
    io.stderr(options.json ? JSON.stringify({ error: error.message }) : `Error: ${error.message}`);
    return 1;
  }
}

function formatHuman(command, result) {
  if (command === 'scan') return `Scanned ${result.skills.length} Skills.`;
  if (command === 'validate') return result.valid ? 'Validation passed.' : `Validation failed:\n${result.errors.join('\n')}`;
  return JSON.stringify(result, null, 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli();
}
