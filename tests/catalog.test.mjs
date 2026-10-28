import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifySkill,
  createStableSkillId,
  detectSource,
  discoverSkills,
  mergeCatalog,
  parseSkillFrontmatter,
} from '../scripts/catalog.mjs';

const categories = {
  schema_version: 1,
  categories: [
    { id: 'development', name: '开发流程', priority: 10, keywords: ['code', 'debug', 'test'] },
    { id: 'documents-office', name: '文档与办公', priority: 20, keywords: ['pdf', 'document'] },
    { id: 'visual-design', name: '视觉与设计', priority: 30, keywords: ['image', 'images', 'imagegen', 'visual'] },
    { id: 'skills-plugins', name: 'Skill 与插件', priority: 40, keywords: ['skill', 'plugin'] },
    { id: 'other', name: '其他', priority: 0, keywords: [] },
  ],
};

async function makeSkill(root, relativeDirectory, skillMd, openaiYaml) {
  const directory = path.join(root, relativeDirectory);
  await mkdir(path.join(directory, 'agents'), { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), skillMd, 'utf8');
  if (openaiYaml !== undefined) {
    await writeFile(path.join(directory, 'agents', 'openai.yaml'), openaiYaml, 'utf8');
  }
  return directory;
}

test('parses quoted names and folded or literal frontmatter descriptions', () => {
  const folded = parseSkillFrontmatter(`---\nname: "pdf-tools"\ndescription: >-\n  Read and create PDFs\n  while preserving layout.\n---\n# Body\n`);
  assert.equal(folded.name, 'pdf-tools');
  assert.equal(folded.description, 'Read and create PDFs while preserving layout.');

  const literal = parseSkillFrontmatter(`---\nname: 'review-code'\ndescription: |\n  Review changes.\n  Report defects.\n---\n`);
  assert.equal(literal.name, 'review-code');
  assert.equal(literal.description, 'Review changes.\nReport defects.\n');
});

test('parses quoted scalars with comments and preserves more-indented folded lines', () => {
  const parsed = parseSkillFrontmatter(`---\nname: "pdf-tools" # canonical name\ndescription: >-\n  First paragraph\n    preserved example\n  final line\n---\n`);
  assert.equal(parsed.name, 'pdf-tools');
  assert.equal(parsed.description, 'First paragraph\n  preserved example\nfinal line');
});

test('keeps comment markers inside quoted scalars', () => {
  const parsed = parseSkillFrontmatter(`---\nname: "pdf # tools" # source note\ndescription: 'Handles # tagged files.' # source note\n---\n`);
  assert.equal(parsed.name, 'pdf # tools');
  assert.equal(parsed.description, 'Handles # tagged files.');
});

test('parses multiline quoted frontmatter scalars', () => {
  const parsed = parseSkillFrontmatter(`---\nname: "multi\n  line"\ndescription: 'First line\n  and second line'\n---\n`);
  assert.equal(parsed.name, 'multi line');
  assert.equal(parsed.description, 'First line and second line');
});

test('parses comments after plain scalars containing apostrophes', () => {
  const plain = parseSkillFrontmatter(`---\nname: helper\ndescription: Bob's helper # source note\n---\n`);
  assert.equal(plain.description, "Bob's helper");
});

test('preserves leading blank lines in folded blocks', () => {
  const leadingBlank = parseSkillFrontmatter(`---\nname: folded\ndescription: >-\n\n  first line\n---\n`);
  assert.equal(leadingBlank.description, '\nfirst line');
});

test('honors explicit indentation and chomping markers in block scalars', () => {
  const explicitIndent = parseSkillFrontmatter(`---\nname: literal\ndescription: |2-\n    preserved indentation\n  base indentation\n---\n`);
  assert.equal(explicitIndent.description, '  preserved indentation\nbase indentation');
});

test('detects known sources from normalized Windows-style paths', () => {
  assert.equal(detectSource('C:/Users/q/.codex/skills/.system/imagegen/SKILL.md'), 'system');
  assert.equal(detectSource('C:/Users/q/.codex/skills/my-skill/SKILL.md'), 'personal');
  assert.equal(detectSource('C:/Users/q/.agents/skills/my-skill/SKILL.md'), 'user');
  assert.equal(detectSource('D:/repo/.agents/skills/my-skill/SKILL.md'), 'project');
  assert.equal(detectSource('C:/Users/q/.codex/plugins/cache/acme/office/1.2.3/skills/pdf/SKILL.md'), 'plugin');
  assert.equal(detectSource('D:/misc/my-skill/SKILL.md'), 'unknown');
});

test('plugin stable IDs include publisher and plugin but omit cache version', () => {
  const first = 'C:/Users/q/.codex/plugins/cache/acme/office/1.2.3/skills/pdf/SKILL.md';
  const upgraded = 'C:/Users/q/.codex/plugins/cache/acme/office/2.0.0/skills/pdf/SKILL.md';
  assert.equal(createStableSkillId(first, 'pdf', 'plugin'), 'plugin:acme/office:pdf');
  assert.equal(createStableSkillId(upgraded, 'pdf', 'plugin'), 'plugin:acme/office:pdf');
});

test('non-plugin stable IDs retain a path component so same-name skills stay distinct', () => {
  const first = createStableSkillId('D:/skills/one/SKILL.md', 'helper', 'project');
  const second = createStableSkillId('D:/skills/two/SKILL.md', 'helper', 'project');
  assert.notEqual(first, second);
  assert.match(first, /^project:helper:/);
});

test('discovers skills recursively and keeps English originals separate from Chinese UI metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-'));
  await makeSkill(
    root,
    'nested/pdf',
    `---\nname: pdf\ndescription: Read, create, and inspect PDF documents.\n---\n`,
    `interface:\n  display_name: "PDF 文件处理"\n  short_description: "读取、创建并检查 PDF 文件的内容与版式"\n`,
  );

  const [entry] = await discoverSkills([{ path: root, source: 'personal' }], categories, {
    now: '2026-08-17T12:00:00.000Z',
  });

  assert.equal(entry.source, 'personal');
  assert.equal(entry.original_name, 'pdf');
  assert.equal(entry.original_description, 'Read, create, and inspect PDF documents.');
  assert.equal(entry.display_name, 'PDF 文件处理');
  assert.equal(entry.short_description, '读取、创建并检查 PDF 文件的内容与版式');
  assert.equal(entry.category, 'documents-office');
  assert.equal(entry.localization_status, 'ready');
  assert.equal(entry.available, true);
  assert.match(entry.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(entry.last_seen, '2026-08-17T12:00:00.000Z');
});

test('parses multiline quoted Chinese fields from openai.yaml', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-'));
  await makeSkill(
    root,
    'multiline',
    `---\nname: multiline\ndescription: An English description.\n---\n`,
    `interface:\n  display_name: "多行\n    展示名"\n  short_description: '这是一段\n    多行中文说明'\n`,
  );
  const [entry] = await discoverSkills([{ path: root, source: 'personal' }], categories);
  assert.equal(entry.display_name, '多行 展示名');
  assert.equal(entry.short_description, '这是一段 多行中文说明');
});

test('classification is deterministic and constrained to configured category IDs', () => {
  assert.equal(classifySkill({ name: 'pdf', description: 'Create and inspect documents' }, categories), 'documents-office');
  assert.equal(classifySkill({ name: 'unit-tests', description: 'Test and debug source code' }, categories), 'development');
  assert.equal(classifySkill({ name: 'mystery', description: 'Do an unusual thing' }, categories), 'other');
});

test('classification rules come from category data and honor configured priority', () => {
  const firstRules = {
    categories: [
      { id: 'lower', priority: 10, keywords: ['widget'] },
      { id: 'higher', priority: 20, keywords: ['widget'] },
      { id: 'other', priority: 0, keywords: [] },
    ],
  };
  assert.equal(classifySkill({ name: 'widget-helper', description: '' }, firstRules), 'higher');

  const changedRules = {
    categories: firstRules.categories.map((category) => (
      category.id === 'higher' ? { ...category, keywords: ['unrelated'] } : category
    )),
  };
  assert.equal(classifySkill({ name: 'widget-helper', description: '' }, changedRules), 'lower');
});

test('classification uses boundaries, ignores negative clauses, and favors purpose names', () => {
  assert.equal(
    classifySkill({ name: 'latest-release', description: 'Show recent package versions.' }, categories),
    'other',
  );
  assert.equal(
    classifySkill({ name: 'helper', description: 'Organize utilities. Do not use for plugins.' }, categories),
    'other',
  );
  assert.equal(
    classifySkill({ name: 'imagegen', description: 'Generate images using Codex.' }, categories),
    'visual-design',
  );
});

test('classification returns other when competing categories have equal evidence and priority', () => {
  const ambiguous = {
    categories: [
      { id: 'alpha', priority: 10, keywords: ['widget'] },
      { id: 'beta', priority: 10, keywords: ['widget'] },
      { id: 'other', priority: 0, keywords: [] },
    ],
  };
  assert.equal(classifySkill({ name: 'widget', description: '' }, ambiguous), 'other');
});

test('merges scans while preserving manual fields and marking missing entries', () => {
  const previous = {
    schema_version: 1,
    generated_at: '2026-08-16T00:00:00.000Z',
    skills: [
      {
        id: 'plugin:acme/office:pdf',
        source: 'plugin',
        path: 'old/path/SKILL.md',
        original_name: 'pdf',
        original_description: 'Old English.',
        display_name: '我的 PDF 工具',
        short_description: '我手动编写的中文说明，同步时不应该被覆盖',
        category: 'visual-design',
        localization_status: 'ready',
        available: true,
        fingerprint: 'old',
        last_seen: '2026-08-16T00:00:00.000Z',
      },
      {
        id: 'personal:gone',
        source: 'personal',
        path: 'gone/SKILL.md',
        original_name: 'gone',
        original_description: 'No longer installed.',
        display_name: '已移除',
        short_description: '这条历史记录应保留但会被标记为不可用',
        category: 'other',
        localization_status: 'ready',
        available: true,
        fingerprint: 'gone',
        last_seen: '2026-08-15T00:00:00.000Z',
      },
    ],
  };
  const discovered = [{
    id: 'plugin:acme/office:pdf',
    source: 'plugin',
    path: 'new/version/path/SKILL.md',
    original_name: 'pdf',
    original_description: 'New English description.',
    display_name: '自动 PDF',
    short_description: '自动生成的中文说明不应覆盖人工内容',
    category: 'documents-office',
    localization_status: 'ready',
    available: true,
    fingerprint: 'new',
    last_seen: '2026-08-17T12:00:00.000Z',
  }];

  const merged = mergeCatalog(previous, discovered, '2026-08-17T12:00:00.000Z');
  const pdf = merged.skills.find((skill) => skill.id === 'plugin:acme/office:pdf');
  const gone = merged.skills.find((skill) => skill.id === 'personal:gone');

  assert.equal(pdf.display_name, '我的 PDF 工具');
  assert.equal(pdf.short_description, '我手动编写的中文说明，同步时不应该被覆盖');
  assert.equal(pdf.category, 'visual-design');
  assert.equal(pdf.original_description, 'New English description.');
  assert.equal(pdf.path, 'new/version/path/SKILL.md');
  assert.equal(pdf.fingerprint, 'new');
  assert.equal(gone.available, false);
  assert.equal(gone.last_seen, '2026-08-15T00:00:00.000Z');
  assert.equal(merged.generated_at, '2026-08-17T12:00:00.000Z');
});

test('new entries without Chinese metadata remain pending', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-'));
  await makeSkill(root, 'plain', `---\nname: plain\ndescription: A plain helper.\n---\n`);
  const [entry] = await discoverSkills([{ path: root, source: 'user' }], categories);
  assert.equal(entry.display_name, '');
  assert.equal(entry.short_description, '');
  assert.equal(entry.localization_status, 'pending');
});

test('marks localized metadata for repair when disk metadata changes or disappears', () => {
  const previous = { schema_version: 1, skills: [{ id: 'x', display_name: '旧名', short_description: '这是一段足够长的中文说明用于测试元数据状态', localization_status: 'ready', metadata_fingerprint: 'old', available: true }] };
  const discovered = [{ id: 'x', display_name: '', short_description: '', localization_status: 'pending', metadata_fingerprint: 'new', available: true }];
  const merged = mergeCatalog(previous, discovered);
  assert.equal(merged.skills[0].localization_status, 'repair-needed');
});

test('keeps same-name non-plugin skills as separate duplicate-name records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-'));
  await makeSkill(root, 'one', `---\nname: helper\ndescription: First helper.\n---\n`);
  await makeSkill(root, 'two', `---\nname: helper\ndescription: Second helper.\n---\n`);
  const entries = await discoverSkills([{ path: root, source: 'project' }], categories);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.equal(entries[0].duplicate_name, true);
  assert.equal(entries[1].duplicate_name, true);
});

test('follows directory links and avoids cycles when the platform permits them', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-link-'));
  const scanRoot = path.join(base, 'scan');
  const external = path.join(base, 'external');
  await mkdir(scanRoot, { recursive: true });
  await makeSkill(external, 'linked-skill', `---\nname: linked\ndescription: Linked helper.\n---\n`);
  try {
    await symlink(external, path.join(scanRoot, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(scanRoot, path.join(external, 'cycle-back'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const entries = await discoverSkills([{ path: scanRoot, source: 'project' }], categories);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].original_name, 'linked');
});

test('deduplicates coexisting plugin cache versions by stable ID', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-'));
  const pluginRoot = path.join(root, '.codex/plugins/cache/acme/office');
  await makeSkill(pluginRoot, '1.2.3/skills/pdf', `---\nname: pdf\ndescription: Old PDF support.\n---\n`);
  await makeSkill(pluginRoot, '2.0.0/skills/pdf', `---\nname: pdf\ndescription: Current PDF support.\n---\n`);

  const entries = await discoverSkills([{ path: root, source: 'plugin' }], categories);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'plugin:acme/office:pdf');
  assert.equal(entries[0].original_description, 'Current PDF support.');
  assert.match(normalizeForAssertion(entries[0].path), /\/2\.0\.0\/skills\/pdf\/SKILL\.md$/);
});

test('prefers a final plugin release over its prerelease regardless of root prefix', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-'));
  const earlyRoot = path.join(root, 'z-root/.codex/plugins/cache/acme/office');
  const finalRoot = path.join(root, 'a-root/.codex/plugins/cache/acme/office');
  await makeSkill(earlyRoot, '2.0.0-beta/skills/pdf', `---\nname: pdf\ndescription: Beta PDF support.\n---\n`);
  await makeSkill(finalRoot, '2.0.0/skills/pdf', `---\nname: pdf\ndescription: Final PDF support.\n---\n`);

  const entries = await discoverSkills([
    { path: earlyRoot, source: 'plugin' },
    { path: finalRoot, source: 'plugin' },
  ], categories);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].original_description, 'Final PDF support.');
});

function normalizeForAssertion(filePath) {
  return filePath.replaceAll('\\', '/');
}
