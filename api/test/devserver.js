// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — local dev server.
//
// Serves the static site from the repo root and routes /api/* to the real
// Azure Functions handlers, using the same @azure/functions stub as
// api/test/smoke.js. This is NOT how the app runs in Azure (Static Web
// Apps does both jobs there) — it exists so the front end can be opened
// and driven in a browser without deploying.
//
//   DATABASE_URL=... JWT_SECRET=dev node api/test/devserver.js
//   → http://localhost:8080
// ─────────────────────────────────────────────────────────────
const http = require('http');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROUTES = [];
const azureStub = {
  app: {
    http(name, cfg) { ROUTES.push({ name, ...cfg }); },
    hook: { postInvocation() {} },
  },
};
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@azure/functions') return '@azure/functions';
  return realResolve.call(this, request, ...rest);
};
require.cache['@azure/functions'] = { id: '@azure/functions', filename: '@azure/functions', loaded: true, exports: azureStub };

const fnDir = path.join(__dirname, '..', 'src', 'functions');
for (const f of fs.readdirSync(fnDir).filter(f => f.endsWith('.js'))) require(path.join(fnDir, f));

const ROOT = path.join(__dirname, '..', '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function matchRoute(method, urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  for (const r of ROUTES) {
    if (!r.methods.includes(method)) continue;
    const rp = r.route.split('/').filter(Boolean);
    if (rp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rp.length; i++) {
      const m = /^\{(.+)\}$/.exec(rp[i]);
      if (m) params[m[1]] = decodeURIComponent(parts[i]);
      else if (rp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const apiPath = url.pathname.slice(5);
    const hit = matchRoute(req.method, apiPath);
    if (!hit) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"No such route"}'); }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();

    const request = {
      method: req.method,
      url: `http://localhost${req.url}`,
      params: hit.params,
      headers: { get: k => req.headers[k.toLowerCase()] ?? null },
      json: async () => JSON.parse(raw),
    };
    try {
      const out = await hit.route.handler(request, { functionName: hit.route.name });
      res.writeHead(out.status || 200, out.headers || { 'Content-Type': 'application/json' });
      return res.end(out.body ?? '');
    } catch (e) {
      console.error('[api]', hit.route.name, e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(process.env.PORT || 8080, () => {
  console.log(`dev server on http://localhost:${process.env.PORT || 8080} — ${ROUTES.length} API routes`);
});
