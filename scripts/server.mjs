import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManager } from './manager.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultUiRoot = path.resolve(here, '..', 'ui');
const MAX_BODY = 1024 * 1024;

function json(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, {'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body)}); res.end(body); }
async function safePath(root, requestPath) { let decoded; try { decoded = decodeURIComponent(requestPath); } catch { throw Object.assign(new Error('Malformed URL encoding'), { status: 400 }); } const target = path.resolve(root, `.${decoded}`); const canonicalRoot = await realpath(root); let canonicalTarget; try { canonicalTarget = await realpath(target); } catch { return null; } const rel = path.relative(canonicalRoot, canonicalTarget); if (rel.startsWith('..') || path.isAbsolute(rel)) return null; return canonicalTarget; }
async function body(req) { let size=0; const chunks=[]; for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 }); chunks.push(chunk); } if (!size) return {}; try { const value=JSON.parse(Buffer.concat(chunks)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object'); return value; } catch (error) { throw Object.assign(new Error(error.message === 'JSON body must be an object' ? error.message : 'Invalid JSON body'), { status: 400 }); } }

export function createServer(options = {}) {
  if (options.host !== undefined && options.host !== '127.0.0.1') throw new Error('Skill manager server only permits host 127.0.0.1.');
  const manager = options.manager ?? createManager();
  const uiRoot = path.resolve(options.uiRoot ?? defaultUiRoot);
  const sessionToken = randomBytes(32).toString('hex');
  return http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`) {
        return json(res, 403, { error: 'Invalid host', status: 403 });
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      // Validate every encoded path before route matching so malformed escapes
      // cannot fall through to a misleading 404 on an unknown API route.
      try { decodeURIComponent(url.pathname); decodeURIComponent(url.search); } catch { throw Object.assign(new Error('Malformed URL encoding'), { status: 400 }); }
      if (options.requireToken !== false && req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const supplied = req.headers['x-skill-manager-token'];
        const expected = Buffer.from(sessionToken);
        const actual = Buffer.from(typeof supplied === 'string' ? supplied : '');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          return json(res, 403, { error: 'Invalid session token', status: 403 });
        }
      }
      if (url.pathname.startsWith('/api/')) {
        let result;
        if (req.method === 'GET' && url.pathname === '/api/session') result = { token: sessionToken };
        else if (req.method === 'GET' && url.pathname === '/api/catalog') result = await manager.readCatalog();
        else if (req.method === 'POST' && url.pathname === '/api/scan') { await body(req); result = await manager.scan(); }
        else if (req.method === 'GET' && url.pathname === '/api/categories') result = await manager.categoriesList();
        else if (req.method === 'POST' && url.pathname === '/api/categories') result = await manager.categoriesAdd(await body(req));
        else if (req.method === 'GET' && url.pathname === '/api/usage') result = await manager.usageList();
        else {
          const favorite = url.pathname.match(/^\/api\/skills\/([^/]+)\/favorite$/);
          if (favorite && req.method === 'POST') { const id = decodeURIComponent(favorite[1]); result = await manager.favoriteSet({ ...(await body(req)), id }); }
          const used = url.pathname.match(/^\/api\/skills\/([^/]+)\/use$/);
          if (used && req.method === 'POST') { const id = decodeURIComponent(used[1]); await body(req); result = await manager.recordUse({ id }); }
          const m = url.pathname.match(/^\/api\/skills\/([^/]+)(?:\/restore)?$/);
          if (m) { let id; try { id = decodeURIComponent(m[1]); } catch { throw Object.assign(new Error('Malformed URL encoding'), {status:400}); } if (url.pathname.endsWith('/restore') && req.method === 'POST') result = await manager.restore({id}); else if (req.method === 'POST') result = await manager.apply({ ...(await body(req)), id }); }
          const c = url.pathname.match(/^\/api\/categories\/([^/]+)\/rename$/);
          if (c && req.method === 'POST') { let id; try { id=decodeURIComponent(c[1]); } catch { throw Object.assign(new Error('Malformed URL encoding'), {status:400}); } result = await manager.categoriesRename({ ...(await body(req)), id }); }
        }
        if (result === undefined) { const allow = url.pathname === '/api/catalog' || url.pathname === '/api/usage' ? 'GET' : url.pathname === '/api/scan' ? 'POST' : url.pathname === '/api/categories' ? 'GET, POST' : /\/restore$|\/rename$|\/favorite$|\/use$|\/skills\//.test(url.pathname) ? 'POST' : null; if (allow) { res.setHeader('allow',allow); return json(res,405,{error:'Method not allowed',status:405}); } return json(res, 404, { error: 'Not found', status:404 }); }
        return json(res, 200, result);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('allow','GET, HEAD'); return json(res, 405, {error:'Method not allowed'}); }
      let target = await safePath(uiRoot, url.pathname === '/' ? '/index.html' : url.pathname);
      if (!target) return json(res, 404, {error:'Not found'});
      const info = await stat(target); if (!info.isFile()) throw Object.assign(new Error('Not found'), {status:404});
      const content = await readFile(target); const ext = path.extname(target); const type = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8'}[ext] ?? 'application/octet-stream'; res.writeHead(200, {'content-type':type,'content-length':content.length}); if (req.method === 'GET') res.end(content); else res.end();
    } catch (error) { const status = error.status ?? (error.code === 'ENOENT' ? 404 : /unknown|not found|no longer available/i.test(error.message) ? 404 : /policy|invalid|category|validation|unique|confirmation|conflict/i.test(error.message) ? 400 : 500); json(res, status, {error:error.message, status}); }
  });
}

export function startServer(options = {}) {
  const port = options.port ?? Number(process.env.SKILL_MANAGER_PORT ?? 0);
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') return Promise.reject(new Error('Skill manager server only permits host 127.0.0.1.'));
  const server = createServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { const port = Number(process.env.SKILL_MANAGER_PORT ?? 0); startServer({ port }).then((server) => console.log(`Skill manager: http://127.0.0.1:${server.address().port}`)); }
