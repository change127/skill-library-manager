import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createManager, resolveDefaultPaths, runCli } from '../scripts/manager.mjs';

const categories = {
  schema_version: 1,
  categories: [
    { id: 'documents', name: '文档办公', order: 10, priority: 10, keywords: ['pdf'] },
    { id: 'other', name: '其他', order: 20, priority: 0, keywords: [] },
  ],
};

const settings = {
  schema_version: 1,
  localization: {
    source_policy: {
      personal: 'auto_apply',
      plugin: 'require_confirmation',
      unknown: 'require_confirmation',
    },
  },
};

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-manager-'));
  const skillRoot = path.join(root, 'installed');
  const dataDir = path.join(root, 'manager-data');
  await mkdir(skillRoot);
  await mkdir(dataDir);
  await writeJson(path.join(dataDir, 'catalog.json'), { schema_version: 1, generated_at: null, skills: [] });
  await writeJson(path.join(dataDir, 'categories.json'), categories);
  await writeJson(path.join(dataDir, 'settings.json'), settings);
  return {
    root,
    skillRoot,
    dataDir,
    manager: createManager({
      roots: [{ path: skillRoot, source: 'personal' }],
      catalogPath: path.join(dataDir, 'catalog.json'),
      categoriesPath: path.join(dataDir, 'categories.json'),
      settingsPath: path.join(dataDir, 'settings.json'),
      usagePath: path.join(dataDir, 'usage.json'),
      snapshotPath: path.join(dataDir, 'install-snapshot.json'),
      backupRoot: path.join(dataDir, 'backups'),
      now: options.now ?? (() => '2026-08-17T00:00:00.000Z'),
    }),
  };
}

async function installSkill(root, name, description, metadata = '') {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8',
  );
  if (metadata) {
    await mkdir(path.join(directory, 'agents'));
    await writeFile(path.join(directory, 'agents', 'openai.yaml'), metadata, 'utf8');
  }
  return directory;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('default roots are dynamic and data files are relative to the installed manager', () => {
  const paths = resolveDefaultPaths({
    home: 'C:\\Users\\tester',
    skillRoot: 'D:\\skills\\skill-library-manager',
    projectRoots: ['D:\\project\\.agents\\skills'],
  });

  assert.deepEqual(paths.roots, [
    { path: path.join('C:\\Users\\tester', '.codex', 'skills') },
    { path: path.join('C:\\Users\\tester', '.agents', 'skills') },
    { path: path.join('C:\\Users\\tester', '.codex', 'plugins', 'cache') },
    { path: 'D:\\project\\.agents\\skills', source: 'project' },
  ]);
  assert.equal(paths.catalogPath, path.resolve('D:\\skills\\skill-library-manager', 'data', 'catalog.json'));
  assert.equal(paths.snapshotPath, path.resolve('D:\\skills\\skill-library-manager', 'data', 'install-snapshot.json'));
  assert.equal(paths.usagePath, path.resolve('D:\\skills\\skill-library-manager', 'data', 'usage.json'));
  assert.equal(paths.roots.some((root) => /\d+\.\d+/.test(root.path)), false);
});

test('concurrent scans wait for the active manager operation', async () => {
  let entered = 0;
  let releaseFirst;
  let signalFirst;
  const firstEntered = new Promise((resolve) => { signalFirst = resolve; });
  const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
  const f = await fixture();
  const manager = createManager({
    roots: [{ path: f.skillRoot, source: 'personal' }],
    catalogPath: path.join(f.dataDir, 'catalog.json'),
    categoriesPath: path.join(f.dataDir, 'categories.json'),
    settingsPath: path.join(f.dataDir, 'settings.json'),
    _beforeScanWrite: async () => {
      entered += 1;
      if (entered === 1) { signalFirst(); await holdFirst; }
    },
  });
  const first = manager.scan();
  await firstEntered;
  const second = manager.scan();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(entered, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(entered, 2);
});

test('favorites persist and setting the same value is idempotent', async () => {
  const { manager, skillRoot, dataDir } = await fixture();
  await installSkill(skillRoot, 'favorite-tool', 'A favorite Skill.');
  const skill = (await manager.scan()).skills[0];

  assert.deepEqual(await manager.usageList(), { schema_version: 1, favorites: [], recent: [] });
  await manager.favoriteSet({ id: skill.id, favorite: true });
  await manager.favoriteSet({ id: skill.id, favorite: true });

  assert.deepEqual((await manager.usageList()).favorites, [skill.id]);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'usage.json'), 'utf8')).favorites, [skill.id]);

  await manager.favoriteSet({ id: skill.id, favorite: false });
  assert.deepEqual((await manager.usageList()).favorites, []);
});

test('recent usage is newest-first, deduplicated, and capped at 20 Skills', async () => {
  let tick = 0;
  const { manager, skillRoot } = await fixture({
    now: () => new Date(Date.UTC(2026, 7, 17, 0, 0, tick++)).toISOString(),
  });
  for (let index = 0; index < 21; index += 1) {
    await installSkill(skillRoot, `tool-${index}`, `Skill number ${index}.`);
  }
  const catalog = await manager.scan();
  for (const skill of catalog.skills) await manager.recordUse({ id: skill.id });
  await manager.recordUse({ id: catalog.skills[5].id });

  const usage = await manager.usageList();
  assert.equal(usage.recent.length, 20);
  assert.equal(usage.recent[0].id, catalog.skills[5].id);
  assert.equal(usage.recent.filter((entry) => entry.id === catalog.skills[5].id).length, 1);
  assert.equal(usage.recent.some((entry) => entry.id === catalog.skills[0].id), false);
});

test('usage mutations reject invalid favorite values and unknown Skill ids', async () => {
  const { manager } = await fixture();

  await assert.rejects(manager.favoriteSet({ id: 'missing', favorite: 'yes' }), /favorite.*boolean/i);
  await assert.rejects(manager.favoriteSet({ id: 'missing', favorite: true }), /unknown Skill/i);
  await assert.rejects(manager.recordUse({ id: 'missing' }), /unknown Skill/i);
});

test('validate reports malformed usage data', async () => {
  const { manager, dataDir } = await fixture();
  await writeJson(path.join(dataDir, 'usage.json'), {
    schema_version: 2,
    favorites: ['duplicate', 'duplicate'],
    recent: [{ id: '', used_at: 'not-a-date' }],
  });

  const result = await manager.validate();

  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => /usage.*schema/i.test(error)), true);
  assert.equal(result.errors.some((error) => /favorites.*unique/i.test(error)), true);
  assert.equal(result.errors.some((error) => /recent.*used_at/i.test(error)), true);
});

test('managed install snapshot and changes identify newly installed and changed Skills', async () => {
  const { manager, skillRoot } = await fixture();
  const existing = await installSkill(skillRoot, 'existing', 'Existing English description.');
  await manager.scan();
  const before = await manager.snapshot();
  assert.equal(before.skills.length, 1);

  await installSkill(skillRoot, 'new-pdf', 'Create and inspect PDF documents.');
  await writeFile(
    path.join(existing, 'SKILL.md'),
    '---\nname: existing\ndescription: Changed English description.\n---\n',
    'utf8',
  );
  await manager.scan();
  const result = await manager.changes();

  assert.deepEqual(result.new.map((skill) => skill.original_name), ['new-pdf']);
  assert.deepEqual(result.changed.map((skill) => skill.original_name), ['existing']);
  assert.equal(result.new[0].original_description, 'Create and inspect PDF documents.');
});

test('apply preserves English source fields, enforces policy, and writes localized metadata safely', async () => {
  const { manager, skillRoot, dataDir } = await fixture();
  await installSkill(
    skillRoot,
    'pdf-tool',
    'Create and inspect PDF documents.',
    'interface:\n  default_prompt: keep-this\n',
  );
  const scanned = await manager.scan();
  const id = scanned.skills[0].id;
  const localized = {
    id,
    displayName: 'PDF 文档处理',
    shortDescription: '创建、检查并整理 PDF 文档内容，同时保留原始英文说明和调用名称',
    category: 'documents',
  };

  const applied = await manager.apply(localized);
  assert.equal(applied.skill.original_name, 'pdf-tool');
  assert.equal(applied.skill.original_description, 'Create and inspect PDF documents.');
  assert.equal(applied.skill.display_name, 'PDF 文档处理');
  assert.equal(applied.skill.category, 'documents');
  const metadata = await readFile(path.join(skillRoot, 'pdf-tool', 'agents', 'openai.yaml'), 'utf8');
  assert.match(metadata, /display_name: "PDF 文档处理"/);
  assert.match(metadata, /default_prompt: keep-this/);
  const catalog = JSON.parse(await readFile(path.join(dataDir, 'catalog.json'), 'utf8'));
  assert.equal(catalog.skills[0].original_name, 'pdf-tool');
  assert.equal(catalog.skills[0].original_description, 'Create and inspect PDF documents.');

  const pluginFixture = await fixture();
  pluginFixture.manager = createManager({
    roots: [{ path: pluginFixture.skillRoot, source: 'plugin' }],
    catalogPath: path.join(pluginFixture.dataDir, 'catalog.json'),
    categoriesPath: path.join(pluginFixture.dataDir, 'categories.json'),
    settingsPath: path.join(pluginFixture.dataDir, 'settings.json'),
    snapshotPath: path.join(pluginFixture.dataDir, 'install-snapshot.json'),
    backupRoot: path.join(pluginFixture.dataDir, 'backups'),
  });
  await installSkill(pluginFixture.skillRoot, 'plugin-pdf', 'Plugin English description.');
  const plugin = (await pluginFixture.manager.scan()).skills[0];
  await assert.rejects(
    pluginFixture.manager.apply({ ...localized, id: plugin.id }),
    /confirmation/i,
  );
  await pluginFixture.manager.apply({ ...localized, id: plugin.id, confirmed: true });
});

test('restore returns the latest original metadata and refreshes the catalog record', async () => {
  const { manager, skillRoot } = await fixture();
  const original = 'interface:\n  display_name: "Original"\n  short_description: "这是原始中文说明内容，其长度满足二十五至六十四个字符的约束"\n';
  await installSkill(skillRoot, 'pdf-tool', 'Original English description.', original);
  const id = (await manager.scan()).skills[0].id;
  await manager.apply({
    id,
    displayName: 'PDF 文档处理',
    shortDescription: '创建、检查并整理 PDF 文档内容，同时保留原始英文说明和调用名称',
    category: 'documents',
  });

  const restored = await manager.restore({ id });

  assert.equal(await readFile(path.join(skillRoot, 'pdf-tool', 'agents', 'openai.yaml'), 'utf8'), original);
  assert.equal(restored.skill.display_name, 'Original');
  assert.equal(restored.skill.original_name, 'pdf-tool');
});

test('restore performs a full discovery merge for new and missing Skills', async () => {
  const { manager, skillRoot } = await fixture();
  await installSkill(skillRoot, 'pdf-tool', 'Original English description.');
  await installSkill(skillRoot, 'will-disappear', 'This Skill will be removed.');
  const initial = await manager.scan();
  const target = initial.skills.find((skill) => skill.original_name === 'pdf-tool');
  await manager.apply({
    id: target.id,
    displayName: 'PDF 文档处理',
    shortDescription: '创建、检查并整理 PDF 文档内容，同时保留原始英文说明和调用名称',
    category: 'documents',
  });
  await rm(path.join(skillRoot, 'will-disappear'), { recursive: true });
  await installSkill(skillRoot, 'new-after-apply', 'Installed before the restore operation.');

  const restored = await manager.restore({ id: target.id });

  assert.equal(restored.catalog.skills.find((skill) => skill.original_name === 'new-after-apply').available, true);
  assert.equal(restored.catalog.skills.find((skill) => skill.original_name === 'will-disappear').available, false);
  assert.equal(restored.skill.original_name, 'pdf-tool');
});

test('category add and rename persist uniquely and migrate catalog references', async () => {
  const { manager, skillRoot } = await fixture();
  await installSkill(skillRoot, 'misc', 'Miscellaneous helper.');
  await manager.scan();
  await manager.categoriesAdd({ id: 'research', name: '资料研究' });
  await assert.rejects(manager.categoriesAdd({ id: 'research', name: '重复编号' }), /unique/i);
  await assert.rejects(manager.categoriesAdd({ id: 'another', name: '资料研究' }), /unique/i);
  await manager.apply({
    id: (await manager.scan()).skills[0].id,
    displayName: '资料整理工具',
    shortDescription: '用于整理研究资料、归纳关键信息并维护清晰一致的内容分类结构',
    category: 'research',
  });

  await manager.categoriesRename({ id: 'research', newId: 'knowledge', name: '知识管理' });
  const listed = await manager.categoriesList();
  assert.equal(listed.categories.some((category) => category.id === 'knowledge' && category.name === '知识管理'), true);
  assert.equal((await manager.scan()).skills[0].category, 'knowledge');
});

test('validate reports malformed data and invalid localized target metadata', async () => {
  const { manager, skillRoot, dataDir } = await fixture();
  await installSkill(skillRoot, 'bad', 'Bad localized metadata.', 'interface:\n  display_name: English\n  short_description: too short\n');
  await manager.scan();
  const result = await manager.validate();
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => /metadata/i.test(error)), true);

  await writeJson(path.join(dataDir, 'categories.json'), { schema_version: 1, categories: [] });
  const malformed = await manager.validate();
  assert.equal(malformed.valid, false);
  assert.equal(malformed.errors.some((error) => /categories/i.test(error)), true);
});

test('validate rejects unsupported schemas and unknown source policy values', async () => {
  const { manager, dataDir } = await fixture();
  await writeJson(path.join(dataDir, 'catalog.json'), { schema_version: 2, skills: [] });
  await writeJson(path.join(dataDir, 'settings.json'), {
    schema_version: 1,
    localization: { source_policy: { personal: 'silently_overwrite' } },
  });

  const result = await manager.validate();

  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => /catalog.*schema/i.test(error)), true);
  assert.equal(result.errors.some((error) => /source policy/i.test(error)), true);
});

test('validate reports actionable record and disk consistency errors', async () => {
  const { manager, skillRoot, dataDir } = await fixture();
  const skillDirectory = await installSkill(skillRoot, 'source-truth', 'Original English description.');
  const catalog = await manager.scan();
  const record = catalog.skills[0];
  record.original_name = 'stale-name';
  record.original_description = 'Stale English description.';
  record.fingerprint = 'stale-fingerprint';
  record.last_seen = '';
  record.localization_status = 'unknown';
  record.available = false;
  await writeJson(path.join(dataDir, 'catalog.json'), catalog);

  const result = await manager.validate();

  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.includes(record.id) && /available=false.*exists/i.test(error)), true);
  assert.equal(result.errors.some((error) => error.includes(record.id) && /original_name.*SKILL\.md/i.test(error)), true);
  assert.equal(result.errors.some((error) => error.includes(record.id) && /original_description.*SKILL\.md/i.test(error)), true);
  assert.equal(result.errors.some((error) => error.includes(record.id) && /fingerprint.*re-run.*scan/i.test(error)), true);
  assert.equal(result.errors.some((error) => error.includes(record.id) && /last_seen/i.test(error)), true);
  assert.equal(result.errors.some((error) => error.includes(record.id) && /localization_status/i.test(error)), true);

  await rm(skillDirectory, { recursive: true });
  record.available = true;
  await writeJson(path.join(dataDir, 'catalog.json'), catalog);
  const missing = await manager.validate();
  assert.equal(missing.errors.some((error) => error.includes(record.id) && /available=true.*missing/i.test(error)), true);
});

test('CLI supports machine-readable JSON for scan and category listing', async () => {
  const fixtureData = await fixture();
  await installSkill(fixtureData.skillRoot, 'pdf-tool', 'Create PDF documents.');
  const output = [];
  const io = { stdout: (value) => output.push(value), stderr: () => {} };

  assert.equal(await runCli(['scan', '--json'], { manager: fixtureData.manager, io }), 0);
  assert.equal(JSON.parse(output.pop()).skills[0].original_name, 'pdf-tool');
  assert.equal(await runCli(['categories', 'list', '--json'], { manager: fixtureData.manager, io }), 0);
  assert.equal(Array.isArray(JSON.parse(output.pop()).categories), true);
});
