import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createServer, startServer } from '../scripts/server.mjs';

async function makeUiRoot(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-manager-ui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return root;
}

function fakeManager() {
  const skill = {
    id: 'personal:x', display_name: 'X', short_description: '中文说明',
    original_name: 'x', original_description: 'English', category: 'other',
    source: 'personal', available: true,
  };
  const state = {
    categories: [{ id: 'other', name: '其他', order: 10, priority: 0, keywords: [] }],
    usage: { schema_version: 1, favorites: [], recent: [] },
    calls: [],
  };
  return {
    state,
    scan: async () => ({ schema_version: 1, skills: [skill] }),
    readCatalog: async () => ({ schema_version: 1, skills: [skill] }),
    categoriesList: async () => ({ schema_version: 1, categories: state.categories }),
    usageList: async () => state.usage,
    favoriteSet: async (input) => {
      state.calls.push(['favorite', input]);
      state.usage.favorites = input.favorite ? [input.id] : [];
      return state.usage;
    },
    recordUse: async (input) => {
      state.calls.push(['use', input]);
      state.usage.recent = [{ id: input.id, used_at: '2026-08-17T00:00:00.000Z' }];
      return state.usage;
    },
    apply: async (input) => { state.calls.push(['apply', input]); return { skill: { ...skill, display_name: input.displayName } }; },
    restore: async (input) => { state.calls.push(['restore', input]); return { skill }; },
    categoriesAdd: async (input) => {
      state.calls.push(['add', input]);
      state.categories = [...state.categories, { id: input.id, name: input.name }];
      return { schema_version: 1, categories: state.categories };
    },
    categoriesRename: async (input) => {
      state.calls.push(['rename', input]);
      state.categories = state.categories.map((category) => category.id === input.id
        ? { ...category, id: input.newId ?? input.id, name: input.name } : category);
      return { categories: state.categories, migrated: 0 };
    },
  };
}

async function running(t, options = {}) {
  const uiRoot = options.uiRoot ?? await makeUiRoot(t, { 'index.html': '<!doctype html><html><body>UI</body></html>' });
  const manager = options.manager ?? fakeManager();
  const server = createServer({ manager, uiRoot, port: 0, requireToken: options.requireToken ?? false });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, manager, base: `http://127.0.0.1:${server.address().port}`, uiRoot };
}

async function jsonResponse(response) { return response.json(); }

test('supports catalog, scan, categories, apply, restore, and static routes', async (t) => {
  const x = await running(t);
  assert.equal((await fetch(`${x.base}/api/catalog`)).status, 200);
  assert.equal((await fetch(`${x.base}/api/scan`, { method: 'POST', body: '{}' })).status, 200);
  const categories = await fetch(`${x.base}/api/categories`);
  assert.equal(categories.status, 200);
  assert.equal((await jsonResponse(categories)).categories[0].id, 'other');
  const added = await fetch(`${x.base}/api/categories`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'research', name: '资料研究' }),
  });
  assert.equal(added.status, 200);
  assert.deepEqual(x.manager.state.calls.at(-1), ['add', { id: 'research', name: '资料研究' }]);
  const renamed = await fetch(`${x.base}/api/categories/research/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newId: 'knowledge', name: '知识管理' }),
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(x.manager.state.calls.at(-1), ['rename', { newId: 'knowledge', name: '知识管理', id: 'research' }]);
  const applied = await fetch(`${x.base}/api/skills/personal%3Ax`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: '新名', shortDescription: '说明', category: 'other' }),
  });
  assert.equal(applied.status, 200);
  assert.deepEqual(x.manager.state.calls.at(-1), ['apply', { displayName: '新名', shortDescription: '说明', category: 'other', id: 'personal:x' }]);
  const restored = await fetch(`${x.base}/api/skills/personal%3Ax/restore`, { method: 'POST' });
  assert.equal(restored.status, 200);
  assert.deepEqual(x.manager.state.calls.at(-1), ['restore', { id: 'personal:x' }]);
  assert.equal((await fetch(`${x.base}/`)).status, 200);
});

test('write routes require the session token and reject foreign hosts', async (t) => {
  const x = await running(t, { requireToken: true });
  const rejected = await fetch(`${x.base}/api/skills/personal%3Ax/restore`, { method: 'POST' });
  assert.equal(rejected.status, 403);
  assert.equal(x.manager.state.calls.length, 0);
  const session = await (await fetch(`${x.base}/api/session`)).json();
  const accepted = await fetch(`${x.base}/api/skills/personal%3Ax/restore`, {
    method: 'POST', headers: { 'x-skill-manager-token': session.token },
  });
  assert.equal(accepted.status, 200);
  const foreignStatus = await new Promise((resolve, reject) => {
    http.get(`${x.base}/api/session`, { headers: { host: 'example.com' } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(foreignStatus, 403);
});

test('supports usage, favorite, and successful-use routes', async (t) => {
  const x = await running(t);
  const usage = await fetch(`${x.base}/api/usage`);
  assert.equal(usage.status, 200);
  assert.deepEqual(await jsonResponse(usage), { schema_version: 1, favorites: [], recent: [] });

  const favorite = await fetch(`${x.base}/api/skills/personal%3Ax/favorite`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorite: true }),
  });
  assert.equal(favorite.status, 200);
  assert.deepEqual(x.manager.state.calls.at(-1), ['favorite', { favorite: true, id: 'personal:x' }]);

  const used = await fetch(`${x.base}/api/skills/personal%3Ax/use`, { method: 'POST', body: '{}' });
  assert.equal(used.status, 200);
  assert.deepEqual(x.manager.state.calls.at(-1), ['use', { id: 'personal:x' }]);
});

test('serves browser modules with a JavaScript content type', async (t) => {
  const uiRoot = await makeUiRoot(t, { 'inbox.mjs': 'export const value = 1;' });
  const x = await running(t, { uiRoot });
  const response = await fetch(`${x.base}/inbox.mjs`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
});

test('rejects malformed, scalar, and array JSON request bodies', async (t) => {
  const x = await running(t);
  for (const requestBody of ['{"broken"', 'null', '"scalar"', '[1,2,3]']) {
    const response = await fetch(`${x.base}/api/categories`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody,
    });
    assert.equal(response.status, 400, requestBody);
    assert.equal((await jsonResponse(response)).status, 400);
  }
});

test('returns 405 with an accurate Allow header for unsupported methods', async (t) => {
  const x = await running(t);
  const cases = [
    ['/api/catalog', 'POST', 'GET'], ['/api/scan', 'GET', 'POST'],
    ['/api/usage', 'POST', 'GET'],
    ['/api/categories', 'DELETE', 'GET, POST'], ['/api/skills/personal%3Ax', 'GET', 'POST'],
    ['/api/skills/personal%3Ax/restore', 'GET', 'POST'], ['/', 'PUT', 'GET, HEAD'],
    ['/api/skills/personal%3Ax/favorite', 'GET', 'POST'],
    ['/api/skills/personal%3Ax/use', 'GET', 'POST'],
  ];
  for (const [route, method, allow] of cases) {
    const response = await fetch(`${x.base}${route}`, { method });
    assert.equal(response.status, 405, `${method} ${route}`);
    assert.equal(response.headers.get('allow'), allow, `${method} ${route}`);
  }
});

test('rejects malformed percent-encoded URLs with 400', async (t) => {
  const x = await running(t);
  for (const target of ['/api/skills/%E0%A4%A', '/api/catalog?bad=%E0%A4%A']) {
    const response = await fetch(`${x.base}${target}`);
    assert.equal(response.status, 400, target);
    assert.equal((await jsonResponse(response)).status, 400);
  }
});

test('does not serve static files through a symlink outside the UI root', async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'skill-manager-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
  const uiRoot = await makeUiRoot(t, { 'index.html': 'UI' });
  try {
    await symlink(outside, path.join(uiRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) { t.skip(`symlinks unavailable: ${error.code}`); return; }
    throw error;
  }
  const x = await running(t, { uiRoot });
  assert.equal((await fetch(`${x.base}/linked/secret.txt`)).status, 404);
});

test('rejects non-loopback hosts for createServer and startServer', async () => {
  assert.throws(() => createServer({ host: '0.0.0.0', manager: fakeManager() }), /only permits host 127\.0\.0\.1/i);
  assert.throws(() => createServer({ host: 'localhost', manager: fakeManager() }), /only permits host 127\.0\.0\.1/i);
  await assert.rejects(startServer({ host: '::1', manager: fakeManager() }), /only permits host 127\.0\.0\.1/i);
});

test('UI contains source/status filters, add-category control, and safe rename actions', async () => {
  const uiRoot = fileURLToPath(new URL('../ui', import.meta.url));
  const html = await readFile(path.join(uiRoot, 'index.html'), 'utf8');
  const app = await readFile(path.join(uiRoot, 'app.js'), 'utf8');
  assert.match(html, /id=["']source["']/);
  assert.match(html, /id=["']statusFilter["']/);
  assert.match(html, /id=["']categoryToggle["']/);
  assert.match(html, /id=["']categoryPanel["']/);
  assert.match(html, /id=["']addCategory["']/);
  assert.match(html, /id=["']categoryDialog["']/);
  assert.match(html, /id=["']categoryForm["']/);
  assert.match(html, /id=["']useSkill["']/);
  assert.match(html, /id=["']viewAll["']/);
  assert.match(html, /id=["']viewFavorites["']/);
  assert.match(html, /id=["']viewRecent["']/);
  assert.match(html, /id=["']favoriteCount["']/);
  assert.match(html, /id=["']recentCount["']/);
  assert.match(html, /id=["']toastRegion["'][^>]*aria-live=["']polite["']/);
  assert.match(html, /href=["']usage\.css["']/);
  assert.match(html, /id=["']scan["'][^>]*class=["'][^"']*action-button/);
  assert.doesNotMatch(html, /scanSecondary/);
  assert.match(app, /重命名/);
  assert.match(app, /categoryDialog/);
  assert.match(app, /categoryToggle/);
  assert.match(app, /categoriesOpen/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(app, /\$\{skill\.original_name\}/);
  assert.match(app, /runButtonAction/);
  assert.match(app, /\/api\/usage/);
  assert.match(app, /\/favorite/);
  assert.match(app, /\/use/);
  assert.doesNotMatch(app, /window\.prompt/);
  assert.match(app, /state\.catalog = await api\('\/api\/catalog'\)/);
});

test('rejects oversized JSON body', async (t) => {
  const x = await running(t);
  const response = await fetch(`${x.base}/api/scan`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(2_000_000),
  });
  assert.equal(response.status, 413);
});
