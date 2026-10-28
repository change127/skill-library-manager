import assert from 'node:assert/strict';
import {
  mkdtemp as fsMkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  restoreLatestMetadata,
  updateSkillMetadata,
  validateLocalizedMetadata,
} from '../scripts/metadata.mjs';

const validFields = {
  displayName: 'PDF 文件处理',
  shortDescription: '读取、创建、填写、渲染并检查版式敏感的 PDF 文件内容',
};

const temporaryRoots = new Set();

async function mkdtemp(prefix) {
  const directory = await fsMkdtemp(prefix);
  temporaryRoots.add(directory);
  return directory;
}

test.after(async () => {
  await Promise.all([...temporaryRoots].map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeSkill(root, name = 'example') {
  const skillDirectory = path.join(root, name);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    path.join(skillDirectory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Example skill.\n---\n`,
    'utf8',
  );
  return skillDirectory;
}

test('creates agents/openai.yaml when metadata is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const backupRoot = path.join(root, 'manager-data', 'backups');

  const result = await updateSkillMetadata(skillDirectory, validFields, { backupRoot });
  const content = await readFile(path.join(skillDirectory, 'agents', 'openai.yaml'), 'utf8');

  assert.equal(
    content,
    `interface:\n  display_name: "PDF 文件处理"\n  short_description: "读取、创建、填写、渲染并检查版式敏感的 PDF 文件内容"\n`,
  );
  assert.equal(result.metadataPath, await realpath(path.join(skillDirectory, 'agents', 'openai.yaml')));
  assert.equal(result.previousExisted, false);
  assert.match(result.backupPath, new RegExp(`^${escapeRegExp(path.resolve(backupRoot))}`));
});

test('changes only localized interface fields in a rich YAML file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  await mkdir(agentsDirectory);
  const original = [
    '# keep this header',
    'interface:',
    '  display_name: "Old name" # keep display note',
    '  short_description: >- # keep summary note',
    '    Old summary that spans',
    '    more than one line.',
    '  default_prompt: "Keep me"',
    '  icon: ./asset.png',
    'policy:',
    '  allow_implicit_invocation: false',
    '',
  ].join('\n');
  await writeFile(path.join(agentsDirectory, 'openai.yaml'), original, 'utf8');

  await updateSkillMetadata(skillDirectory, validFields, {
    backupRoot: path.join(root, 'backups'),
  });
  const updated = await readFile(path.join(agentsDirectory, 'openai.yaml'), 'utf8');

  assert.equal(updated, [
    '# keep this header',
    'interface:',
    '  display_name: "PDF 文件处理" # keep display note',
    '  short_description: "读取、创建、填写、渲染并检查版式敏感的 PDF 文件内容" # keep summary note',
    '  default_prompt: "Keep me"',
    '  icon: ./asset.png',
    'policy:',
    '  allow_implicit_invocation: false',
    '',
  ].join('\n'));
});

test('updates only the top-level interface when a nested interface appears first', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  await mkdir(agentsDirectory);
  const original = [
    'wrapper:',
    '  interface:',
    '    display_name: "Nested name"',
    '    short_description: "这是嵌套配置的中文说明文字，不应由元数据更新器修改"',
    'interface:',
    '  display_name: "Top-level name"',
    '  short_description: "这是顶层配置的旧中文说明文字，应当由更新器进行修改"',
    '',
  ].join('\n');
  await writeFile(path.join(agentsDirectory, 'openai.yaml'), original, 'utf8');

  await updateSkillMetadata(skillDirectory, validFields, { backupRoot: path.join(root, 'backups') });
  const updated = await readFile(path.join(agentsDirectory, 'openai.yaml'), 'utf8');

  assert.match(updated, /    display_name: "Nested name"/);
  assert.match(updated, /    short_description: "这是嵌套配置的中文说明文字，不应由元数据更新器修改"/);
  assert.match(updated, /^  display_name: "PDF 文件处理"$/m);
});

test('rejects unsupported top-level flow-style interface instead of creating a duplicate key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const metadataPath = path.join(agentsDirectory, 'openai.yaml');
  await mkdir(agentsDirectory);
  const original = 'interface: { display_name: "Old", short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求" }\n';
  await writeFile(metadataPath, original, 'utf8');

  await assert.rejects(
    updateSkillMetadata(skillDirectory, validFields, { backupRoot: path.join(root, 'backups') }),
    /unsupported.*top-level interface/i,
  );
  assert.equal(await readFile(metadataPath, 'utf8'), original);
});

test('rejects duplicate top-level interface mappings before backup or write', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const metadataPath = path.join(agentsDirectory, 'openai.yaml');
  const backupRoot = path.join(root, 'backups');
  await mkdir(agentsDirectory);
  const original = 'interface:\n  display_name: "First"\ninterface:\n  short_description: "这是第二个映射中的中文说明文字，长度满足限制要求"\n';
  await writeFile(metadataPath, original, 'utf8');

  await assert.rejects(
    updateSkillMetadata(skillDirectory, validFields, { backupRoot }),
    /duplicate.*top-level interface/i,
  );
  assert.equal(await readFile(metadataPath, 'utf8'), original);
  await assert.rejects(readdir(backupRoot), { code: 'ENOENT' });
});

test('rejects quoted top-level interface keys instead of creating a duplicate key', async () => {
  for (const quote of ["'", '"']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
    const skillDirectory = await makeSkill(root);
    const agentsDirectory = path.join(skillDirectory, 'agents');
    const metadataPath = path.join(agentsDirectory, 'openai.yaml');
    await mkdir(agentsDirectory);
    const original = `${quote}interface${quote}:\n  display_name: "Old"\n`;
    await writeFile(metadataPath, original, 'utf8');

    await assert.rejects(
      updateSkillMetadata(skillDirectory, validFields, { backupRoot: path.join(root, 'backups') }),
      /unsupported.*top-level interface/i,
    );
    assert.equal(await readFile(metadataPath, 'utf8'), original);
  }
});

test('rejects quoted localized display-name keys before backup or write', async () => {
  for (const key of ["'display_name'", '"display_name"']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
    const skillDirectory = await makeSkill(root);
    const agentsDirectory = path.join(skillDirectory, 'agents');
    const metadataPath = path.join(agentsDirectory, 'openai.yaml');
    const backupRoot = path.join(root, 'backups');
    await mkdir(agentsDirectory);
    const original = `interface:\n  ${key}: "Old"\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"\n`;
    await writeFile(metadataPath, original, 'utf8');

    await assert.rejects(
      updateSkillMetadata(skillDirectory, validFields, { backupRoot }),
      /unsupported.*display_name.*interface/i,
    );
    assert.equal(await readFile(metadataPath, 'utf8'), original);
    await assert.rejects(readdir(backupRoot), { code: 'ENOENT' });
  }
});

test('rejects quoted localized short-description keys before backup or write', async () => {
  for (const key of ["'short_description'", '"short_description"']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
    const skillDirectory = await makeSkill(root);
    const agentsDirectory = path.join(skillDirectory, 'agents');
    const metadataPath = path.join(agentsDirectory, 'openai.yaml');
    const backupRoot = path.join(root, 'backups');
    await mkdir(agentsDirectory);
    const original = `interface:\n  display_name: "Old"\n  ${key}: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"\n`;
    await writeFile(metadataPath, original, 'utf8');

    await assert.rejects(
      updateSkillMetadata(skillDirectory, validFields, { backupRoot }),
      /unsupported.*short_description.*interface/i,
    );
    assert.equal(await readFile(metadataPath, 'utf8'), original);
    await assert.rejects(readdir(backupRoot), { code: 'ENOENT' });
  }
});

test('rejects localized keys with whitespace before the colon', async () => {
  for (const field of ['display_name', 'short_description']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
    const skillDirectory = await makeSkill(root);
    const agentsDirectory = path.join(skillDirectory, 'agents');
    const metadataPath = path.join(agentsDirectory, 'openai.yaml');
    const backupRoot = path.join(root, 'backups');
    await mkdir(agentsDirectory);
    const other = field === 'display_name'
      ? '  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"'
      : '  display_name: "Old"';
    const value = field === 'display_name'
      ? '"Old"'
      : '"这是原始的中文说明文字，长度满足二十五个字符的限制要求"';
    const original = `interface:\n  ${field} : ${value}\n${other}\n`;
    await writeFile(metadataPath, original, 'utf8');

    await assert.rejects(
      updateSkillMetadata(skillDirectory, validFields, { backupRoot }),
      new RegExp(`unsupported.*${field}.*interface`, 'i'),
    );
    assert.equal(await readFile(metadataPath, 'utf8'), original);
    await assert.rejects(readdir(backupRoot), { code: 'ENOENT' });
  }
});

test('rejects duplicate managed keys inside the selected interface', async () => {
  for (const field of ['display_name', 'short_description']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
    const skillDirectory = await makeSkill(root);
    const agentsDirectory = path.join(skillDirectory, 'agents');
    const metadataPath = path.join(agentsDirectory, 'openai.yaml');
    const backupRoot = path.join(root, 'backups');
    await mkdir(agentsDirectory);
    const repeatedValue = field === 'display_name'
      ? '"重复中文名称"'
      : '"这是重复的中文说明文字，长度满足二十五个字符的限制要求"';
    const other = field === 'display_name'
      ? '  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"'
      : '  display_name: "原始中文名称"';
    const original = `interface:\n  ${field}: ${repeatedValue}\n  ${field}: ${repeatedValue}\n${other}\n`;
    await writeFile(metadataPath, original, 'utf8');

    await assert.rejects(
      updateSkillMetadata(skillDirectory, validFields, { backupRoot }),
      new RegExp(`duplicate.*${field}`, 'i'),
    );
    assert.equal(await readFile(metadataPath, 'utf8'), original);
    await assert.rejects(readdir(backupRoot), { code: 'ENOENT' });
  }
});

test('rejects anchors, tags, and aliases on managed scalar values before backup or write', async () => {
  const cases = [
    '  display_name: &localized "Old"\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"',
    '  display_name: !!str "Old"\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"',
    '  display_name: "Old"\n  short_description: *localized',
  ];
  for (const managedLines of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
    const skillDirectory = await makeSkill(root);
    const agentsDirectory = path.join(skillDirectory, 'agents');
    const metadataPath = path.join(agentsDirectory, 'openai.yaml');
    const backupRoot = path.join(root, 'backups');
    await mkdir(agentsDirectory);
    const original = `interface:\n${managedLines}\n`;
    await writeFile(metadataPath, original, 'utf8');

    await assert.rejects(
      updateSkillMetadata(skillDirectory, validFields, { backupRoot }),
      /anchor|tag|alias/i,
    );
    assert.equal(await readFile(metadataPath, 'utf8'), original);
    await assert.rejects(readdir(backupRoot), { code: 'ENOENT' });
  }
});

test('preserves a UTF-8 BOM and CRLF line endings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const metadataPath = path.join(agentsDirectory, 'openai.yaml');
  await mkdir(agentsDirectory);
  await writeFile(
    metadataPath,
    '\uFEFFinterface:\r\n  display_name: "Old"\r\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"\r\n',
    'utf8',
  );

  await updateSkillMetadata(skillDirectory, validFields, { backupRoot: path.join(root, 'backups') });
  const updated = await readFile(metadataPath, 'utf8');

  assert.equal(updated, '\uFEFFinterface:\r\n  display_name: "PDF 文件处理"\r\n  short_description: "读取、创建、填写、渲染并检查版式敏感的 PDF 文件内容"\r\n');
});

test('rejects a concurrent metadata change immediately before commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const metadataPath = path.join(agentsDirectory, 'openai.yaml');
  await mkdir(agentsDirectory);
  const original = 'interface:\n  display_name: "Old"\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"\n';
  const concurrent = 'interface:\n  display_name: "Concurrent"\n  short_description: "这是并发写入的中文说明文字，必须保留而不能被静默覆盖"\n';
  await writeFile(metadataPath, original, 'utf8');

  await assert.rejects(
    updateSkillMetadata(skillDirectory, validFields, {
      backupRoot: path.join(root, 'backups'),
      _beforeCommit: async () => writeFile(metadataPath, concurrent, 'utf8'),
    }),
    /conflict|concurrent/i,
  );
  assert.equal(await readFile(metadataPath, 'utf8'), concurrent);
  assert.equal((await readdir(agentsDirectory)).some((name) => name.endsWith('.tmp')), false);
  const [backupDirectoryName] = await readdir(path.join(root, 'backups'));
  const lockPath = path.join(root, 'locks', backupDirectoryName, '.metadata.lock');
  await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' });
});

test('serializes concurrent manager updates and releases the per-Skill lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const metadataPath = path.join(agentsDirectory, 'openai.yaml');
  const backupRoot = path.join(root, 'backups');
  await mkdir(agentsDirectory);
  await writeFile(
    metadataPath,
    'interface:\n  display_name: "原始名称"\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"\n',
    'utf8',
  );
  const entered = deferred();
  const release = deferred();
  const firstFields = validFields;
  const secondFields = {
    displayName: 'Word 文档处理',
    shortDescription: '读取、创建、编辑并检查 Word 文档内容以及页面布局效果',
  };
  const firstUpdate = updateSkillMetadata(skillDirectory, firstFields, {
    backupRoot,
    _beforeCommit: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  let secondSettled = false;
  const secondUpdate = updateSkillMetadata(skillDirectory, secondFields, { backupRoot })
    .finally(() => { secondSettled = true; });
  await delay(30);
  const settledWhileFirstHeldCommit = secondSettled;
  release.resolve();
  const [firstResult, secondResult] = await Promise.all([firstUpdate, secondUpdate]);

  assert.equal(settledWhileFirstHeldCommit, false);
  assert.notEqual(firstResult.backupPath, secondResult.backupPath);
  assert.match(await readFile(metadataPath, 'utf8'), /display_name: "Word 文档处理"/);
  await assert.rejects(
    readFile(lockPathForBackup(firstResult.backupPath, backupRoot), 'utf8'),
    { code: 'ENOENT' },
  );
});

test('keeps a manager-held lock protected beyond the former stale threshold', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const backupRoot = path.join(root, 'backups');
  const entered = deferred();
  const release = deferred();
  const first = updateSkillMetadata(skillDirectory, validFields, {
    backupRoot,
    _beforeCommit: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  await assert.rejects(
    updateSkillMetadata(skillDirectory, {
      displayName: 'Word 文档处理',
      shortDescription: '读取、创建、编辑并检查 Word 文档内容以及页面布局效果',
    }, {
      backupRoot,
      _lockStaleMs: 5,
      _lockTimeoutMs: 30,
      _lockPollMs: 5,
    }),
    /timed out.*lock.*manual recovery/i,
  );
  release.resolve();
  const result = await first;
  await assert.rejects(readFile(lockPathForBackup(result.backupPath, backupRoot), 'utf8'), { code: 'ENOENT' });
});

test('times out on an old orphan lock without deleting it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const backupRoot = path.join(root, 'backups');
  const initial = await updateSkillMetadata(skillDirectory, validFields, { backupRoot });
  const lockPath = lockPathForBackup(initial.backupPath, backupRoot);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const orphan = '{"owner":"orphan"}\n';
  await writeFile(lockPath, orphan, 'utf8');
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  await assert.rejects(
    updateSkillMetadata(skillDirectory, validFields, {
      backupRoot,
      _lockStaleMs: 1,
      _lockTimeoutMs: 20,
      _lockPollMs: 5,
    }),
    /timed out.*lock.*manual recovery/i,
  );
  assert.equal(await readFile(lockPath, 'utf8'), orphan);
  await rm(lockPath);
});

test('orders backups by persisted wall-clock time rather than process-relative time', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const metadataPath = path.join(agentsDirectory, 'openai.yaml');
  const backupRoot = path.join(root, 'backups');
  await mkdir(agentsDirectory);
  const original = 'interface:\n  display_name: "Original"\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"\n';
  await writeFile(metadataPath, original, 'utf8');
  const first = await updateSkillMetadata(skillDirectory, validFields, { backupRoot });
  const second = await updateSkillMetadata(skillDirectory, {
    displayName: 'Word 文档处理',
    shortDescription: '读取、创建、编辑并检查 Word 文档内容以及页面布局效果',
  }, { backupRoot });
  const firstRecord = JSON.parse(await readFile(first.backupPath, 'utf8'));
  const secondRecord = JSON.parse(await readFile(second.backupPath, 'utf8'));
  firstRecord.created_at_epoch_ms = 2_000;
  firstRecord.created_at_ns = '1';
  delete firstRecord.ordinal;
  secondRecord.created_at_epoch_ms = 1_000;
  secondRecord.created_at_ns = '999999999999';
  delete secondRecord.ordinal;
  await writeFile(first.backupPath, `${JSON.stringify(firstRecord)}\n`, 'utf8');
  await writeFile(second.backupPath, `${JSON.stringify(secondRecord)}\n`, 'utf8');

  const restored = await restoreLatestMetadata(skillDirectory, { backupRoot });

  assert.equal(restored.restoredFrom, first.backupPath);
  assert.equal(await readFile(metadataPath, 'utf8'), original);
});

test('uses persisted backup ordinals as a total order when timestamps and sequences collide', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const metadataPath = path.join(agentsDirectory, 'openai.yaml');
  const backupRoot = path.join(root, 'backups');
  await mkdir(agentsDirectory);
  await writeFile(
    metadataPath,
    'interface:\n  display_name: "原始名称"\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"\n',
    'utf8',
  );
  const first = await updateSkillMetadata(skillDirectory, validFields, { backupRoot });
  const second = await updateSkillMetadata(skillDirectory, {
    displayName: 'Word 文档处理',
    shortDescription: '读取、创建、编辑并检查 Word 文档内容以及页面布局效果',
  }, { backupRoot });
  for (const backupPath of [first.backupPath, second.backupPath]) {
    const record = JSON.parse(await readFile(backupPath, 'utf8'));
    record.created_at_epoch_ms = 5_000;
    record.sequence = 1;
    await writeFile(backupPath, JSON.stringify(record), 'utf8');
  }

  const restored = await restoreLatestMetadata(skillDirectory, { backupRoot });

  assert.equal(restored.restoredFrom, second.backupPath);
  assert.match(await readFile(metadataPath, 'utf8'), /display_name: "PDF 文件处理"/);
});

test('skips corrupted, invalid-schema, and invalid-base64 backups during restore', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const metadataPath = path.join(agentsDirectory, 'openai.yaml');
  const backupRoot = path.join(root, 'backups');
  await mkdir(agentsDirectory);
  const original = 'interface:\n  display_name: "Original"\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"\n';
  await writeFile(metadataPath, original, 'utf8');
  const valid = await updateSkillMetadata(skillDirectory, validFields, { backupRoot });
  const directory = path.dirname(valid.backupPath);
  const common = {
    schema_version: 1,
    skill_directory: path.resolve(skillDirectory),
    metadata_path: metadataPath,
    existed: true,
    created_at: '2286-11-20T17:46:39.999Z',
    created_at_epoch_ms: 9_999_999_999_999,
    sequence: 0,
  };
  await writeFile(path.join(directory, 'newer-corrupt.json'), '{broken', 'utf8');
  await writeFile(path.join(directory, 'newer-schema.json'), JSON.stringify({ ...common, schema_version: 99, content_base64: '' }), 'utf8');
  await writeFile(path.join(directory, 'newer-base64.json'), JSON.stringify({ ...common, content_base64: '%%%not-base64%%%' }), 'utf8');

  const restored = await restoreLatestMetadata(skillDirectory, { backupRoot });

  assert.equal(restored.restoredFrom, valid.backupPath);
  assert.equal(restored.ignoredBackupCount, 3);
  assert.equal(await readFile(metadataPath, 'utf8'), original);
});

test('preserves final newline when both localized fields are inserted at EOF', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const metadataPath = path.join(agentsDirectory, 'openai.yaml');
  await mkdir(agentsDirectory);
  await writeFile(metadataPath, 'interface:\n  default_prompt: keep\n', 'utf8');

  await updateSkillMetadata(skillDirectory, validFields, { backupRoot: path.join(root, 'backups') });
  const updated = await readFile(metadataPath, 'utf8');

  assert.equal(updated.endsWith('\n'), true);
  assert.equal(updated, `interface:\n  default_prompt: keep\n  display_name: "PDF 文件处理"\n  short_description: "读取、创建、填写、渲染并检查版式敏感的 PDF 文件内容"\n`);
});

test('preserves final newline when one localized field is inserted at EOF', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const metadataPath = path.join(agentsDirectory, 'openai.yaml');
  await mkdir(agentsDirectory);
  await writeFile(
    metadataPath,
    'interface:\n  display_name: "Old"\n  default_prompt: keep\n',
    'utf8',
  );

  await updateSkillMetadata(skillDirectory, validFields, { backupRoot: path.join(root, 'backups') });
  const updated = await readFile(metadataPath, 'utf8');

  assert.equal(updated.endsWith('\n'), true);
  assert.equal(updated, `interface:\n  display_name: "PDF 文件处理"\n  default_prompt: keep\n  short_description: "读取、创建、填写、渲染并检查版式敏感的 PDF 文件内容"\n`);
});

test('preserves mixed line terminators outside replaced field values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  await mkdir(agentsDirectory);
  const original = '# header\r\ninterface:\n  display_name: old\r\n  short_description: 这是旧中文说明文字但长度依然满足二十五个字符要求\n  default_prompt: keep\r\npolicy:\n  enabled: true\r\n';
  await writeFile(path.join(agentsDirectory, 'openai.yaml'), original, 'utf8');

  await updateSkillMetadata(skillDirectory, validFields, { backupRoot: path.join(root, 'backups') });
  const updated = await readFile(path.join(agentsDirectory, 'openai.yaml'), 'utf8');

  assert.equal(updated, '# header\r\ninterface:\n  display_name: "PDF 文件处理"\r\n  short_description: "读取、创建、填写、渲染并检查版式敏感的 PDF 文件内容"\n  default_prompt: keep\r\npolicy:\n  enabled: true\r\n');
});

test('preserves comments on closing lines of multiline quoted scalars', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  await mkdir(agentsDirectory);
  const original = [
    'interface:',
    '  display_name: "Old',
    '    display name" # keep display closing note',
    "  short_description: '这是旧的多行中文说明文字，",
    "    并且长度符合要求' # keep summary closing note",
    '  default_prompt: keep',
    '',
  ].join('\n');
  await writeFile(path.join(agentsDirectory, 'openai.yaml'), original, 'utf8');

  await updateSkillMetadata(skillDirectory, validFields, { backupRoot: path.join(root, 'backups') });
  const updated = await readFile(path.join(agentsDirectory, 'openai.yaml'), 'utf8');

  assert.equal(updated, [
    'interface:',
    '  display_name: "PDF 文件处理" # keep display closing note',
    '  short_description: "读取、创建、填写、渲染并检查版式敏感的 PDF 文件内容" # keep summary closing note',
    '  default_prompt: keep',
    '',
  ].join('\n'));
});

test('creates a recoverable backup before every metadata update', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const backupRoot = path.join(root, 'backups');
  await mkdir(agentsDirectory);
  const original = 'interface:\n  display_name: "Original"\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"\n';
  await writeFile(path.join(agentsDirectory, 'openai.yaml'), original, 'utf8');

  const first = await updateSkillMetadata(skillDirectory, validFields, { backupRoot });
  const second = await updateSkillMetadata(skillDirectory, {
    displayName: 'Word 文档处理',
    shortDescription: '读取、创建、编辑并检查 Word 文档内容以及页面布局效果',
  }, { backupRoot });

  assert.notEqual(first.backupPath, second.backupPath);
  const firstBackup = JSON.parse(await readFile(first.backupPath, 'utf8'));
  assert.equal(firstBackup.existed, true);
  assert.equal(Buffer.from(firstBackup.content_base64, 'base64').toString('utf8'), original);
  assert.equal((await readdir(path.dirname(first.backupPath))).length, 2);
});

test('restores the latest metadata backup and backs up the replaced state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const metadataPath = path.join(agentsDirectory, 'openai.yaml');
  const backupRoot = path.join(root, 'backups');
  await mkdir(agentsDirectory);
  const original = 'interface:\n  display_name: "Original"\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"\n';
  await writeFile(metadataPath, original, 'utf8');
  await updateSkillMetadata(skillDirectory, validFields, { backupRoot });

  const restored = await restoreLatestMetadata(skillDirectory, { backupRoot });

  assert.equal(await readFile(metadataPath, 'utf8'), original);
  assert.equal(restored.restoredExisted, true);
  assert.notEqual(restored.safetyBackupPath, restored.restoredFrom);
  assert.match(restored.safetyBackupPath, new RegExp(`^${escapeRegExp(path.resolve(backupRoot))}`));
});

test('validates nonempty names and 25-64 code-point Chinese summaries', () => {
  assert.throws(
    () => validateLocalizedMetadata({ displayName: '  ', shortDescription: validFields.shortDescription }),
    /display name/i,
  );
  assert.throws(
    () => validateLocalizedMetadata({ displayName: '名称', shortDescription: '中文太短' }),
    /25.*64/,
  );
  assert.throws(
    () => validateLocalizedMetadata({ displayName: 'Name', shortDescription: 'a'.repeat(25) }),
    /Chinese/i,
  );
  assert.throws(
    () => validateLocalizedMetadata({ displayName: 'PDF tools', shortDescription: validFields.shortDescription }),
    /display name.*Chinese/i,
  );
  assert.throws(
    () => validateLocalizedMetadata({ displayName: '名称', shortDescription: `中文${'字'.repeat(63)}` }),
    /25.*64/,
  );
  assert.deepEqual(validateLocalizedMetadata(validFields), validFields);
});

test('quotes and escapes YAML-sensitive values safely', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const fields = {
    displayName: '工具: "引用" #1',
    shortDescription: '用于处理路径 \\server\\目录、引号 "内容" 与换行\n字符的中文工具说明',
  };

  await updateSkillMetadata(skillDirectory, fields, { backupRoot: path.join(root, 'backups') });
  const content = await readFile(path.join(skillDirectory, 'agents', 'openai.yaml'), 'utf8');

  assert.match(content, /display_name: "工具: \\"引用\\" #1"/);
  assert.match(content, /short_description: "用于处理路径 \\\\server\\\\目录、引号 \\"内容\\" 与换行\\n字符的中文工具说明"/);
});

test('preserves CRLF newline style and final-newline choice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  await mkdir(agentsDirectory);
  await writeFile(
    path.join(agentsDirectory, 'openai.yaml'),
    'interface:\r\n  display_name: old\r\n  short_description: 这是旧中文说明文字但长度依然满足二十五个字符要求',
    'utf8',
  );

  await updateSkillMetadata(skillDirectory, validFields, { backupRoot: path.join(root, 'backups') });
  const content = await readFile(path.join(agentsDirectory, 'openai.yaml'), 'utf8');

  assert.equal(content.includes('\r\n'), true);
  assert.equal(/(^|[^\r])\n/.test(content), false);
  assert.equal(content.endsWith('\r\n'), false);
});

test('rejects directories without SKILL.md', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  await assert.rejects(
    updateSkillMetadata(root, validFields, { backupRoot: path.join(root, 'backups') }),
    /SKILL\.md/,
  );
});

test('rejects agents links that would write outside the supplied skill directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  try {
    await symlink(outside, path.join(skillDirectory, 'agents'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    updateSkillMetadata(skillDirectory, validFields, { backupRoot: path.join(root, 'backups') }),
    /outside.*skill directory/i,
  );
});

test('rejects a symlinked agents directory even when it resolves inside the Skill', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const realAgents = path.join(skillDirectory, 'real-agents');
  await mkdir(realAgents);
  try {
    await symlink(realAgents, path.join(skillDirectory, 'agents'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    updateSkillMetadata(skillDirectory, validFields, { backupRoot: path.join(root, 'backups') }),
    /symlinked agents directory/i,
  );
});

test('revalidates agents after temp creation and rejects a swap race', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-metadata-'));
  const skillDirectory = await makeSkill(root);
  const agentsDirectory = path.join(skillDirectory, 'agents');
  const parkedAgents = path.join(skillDirectory, 'agents-parked');
  const outside = path.join(root, 'outside');
  await mkdir(agentsDirectory);
  await mkdir(outside);
  await writeFile(
    path.join(agentsDirectory, 'openai.yaml'),
    'interface:\n  display_name: "Old"\n  short_description: "这是原始的中文说明文字，长度满足二十五个字符的限制要求"\n',
    'utf8',
  );

  let canLink = true;
  const beforeCommit = async () => {
    await rename(agentsDirectory, parkedAgents);
    try {
      await symlink(outside, agentsDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      canLink = false;
      throw error;
    }
  };
  try {
    await assert.rejects(
      updateSkillMetadata(skillDirectory, validFields, {
        backupRoot: path.join(root, 'backups'),
        _beforeCommit: beforeCommit,
      }),
      /symlinked agents directory/i,
    );
  } catch (error) {
    if (!canLink && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(readFile(path.join(outside, 'openai.yaml'), 'utf8'), { code: 'ENOENT' });
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function lockPathForBackup(backupPath, backupRoot) {
  return path.join(
    path.dirname(path.resolve(backupRoot)),
    'locks',
    path.basename(path.dirname(backupPath)),
    '.metadata.lock',
  );
}
