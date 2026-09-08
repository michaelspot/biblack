const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { normalizeScrapUrl, isScrapJobId, isScrapPending, scrapProgress } = require('../src/scrap.ts');

// Compile the Worker route without loading Cloudflare's container runtime.
const filename = path.resolve(__dirname, '../cloudflare/scrap.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const route = new Module(filename, module);
route.filename = filename;
route.paths = module.paths;
route.require = name => name === '../src/scrap' ? require('../src/scrap.ts') : require(name);
route._compile(compiled, filename);
const { handleScrap } = route.exports;
const id = 'test-job-0123456789abcdef0123456789';
const env = { SCRAP_SERVICE_URL: 'https://test.modal.run', SCRAP_SERVICE_TOKEN: 'server-only-secret' };
const makeRequest = (body) => new Request('https://scaylit.example/api/scrap', {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});

test('accepts shared social links and refuses deceptive hosts, credentials and local URLs', () => {
  assert.equal(normalizeScrapUrl('Regarde cette vidéo https://vm.tiktok.com/abc/'), 'https://vm.tiktok.com/abc/');
  assert.equal(normalizeScrapUrl('https://www.instagram.com/reel/abc/?igsh=foo'), 'https://www.instagram.com/reel/abc/?igsh=foo');
  for (const url of ['https://tiktok.com.evil.test/video/1', 'https://tiktok.com@evil.test/a', 'http://tiktok.com/a', 'https://localhost/a', 'https://tiktok.com/', 'https://www.instagram.com:9000/reel/a']) {
    assert.throws(() => normalizeScrapUrl(url));
  }
  assert.ok(isScrapJobId(id));
  assert.equal(isScrapJobId('../secret'), false);
});

test('invalid payload never reaches a provider', async () => {
  for (const body of [{ id, url: 'https://localhost/a', removeText: true }, { id, url: 'https://tiktok.com/video/1', removeText: 'false' }]) {
    const response = await handleScrap(makeRequest(body), env, () => assert.fail('provider must not be called'));
    assert.equal(response.status, 400);
  }
});

test('unconfigured backend explains what is missing', async () => {
  const response = await handleScrap(makeRequest({ id, url: 'https://vm.tiktok.com/abc/', removeText: false }), {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Cobalt.*Modal/);
});

test('both checkbox choices are forwarded unchanged without exposing the service token', async () => {
  for (const removeText of [false, true]) {
    const response = await handleScrap(makeRequest({ id, url: 'https://vm.tiktok.com/abc/', removeText }), env, async (url, init) => {
      assert.equal(url, 'https://test.modal.run/jobs');
      assert.equal(init.headers.Authorization, 'Bearer server-only-secret');
      assert.equal(JSON.parse(init.body).removeText, removeText);
      return Response.json({ id, status: 'queued', removeText, sourceUrl: 'private source' });
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { id, status: 'queued', removeText });
  }
});

test('completed jobs return the exact final R2 video and reject unrelated keys', async () => {
  const request = new Request(`https://scaylit.example/api/scrap?id=${id}`);
  for (const key of [`scrap/results/${id}.mp4`, 'hooks/unrelated.mp4', `scrap/results/${id}/../../other.mp4`]) {
    const response = await handleScrap(request, env, async () => Response.json({ id, status: 'completed', removeText: true, key, expiresAt: 2000000000 }));
    if (key === `scrap/results/${id}.mp4`) {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).url, `https://scaylit.example/media/${key}`);
    } else assert.equal(response.status, 502);
  }
});

test('stage progress reaches the app and invalid percentages are omitted', async () => {
  const request = new Request(`https://scaylit.example/api/scrap?id=${id}`);
  for (const progress of [0, 38.5, 100, -1, 101, '50']) {
    const response = await handleScrap(request, env, async () => Response.json({ id, status: 'detecting', removeText: true, progress }));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.progress, typeof progress === 'number' && progress >= 0 && progress <= 100 ? Math.floor(progress) : undefined);
  }
});

test('provider failures and rate limits are actionable and do not start duplicate work', async () => {
  const request = makeRequest({ id, url: 'https://tiktok.com/@a/video/1', removeText: false });
  const limited = await handleScrap(request, { ...env, SCRAP_RATE_LIMIT: { limit: async () => ({ success: false }) } }, () => assert.fail());
  assert.equal(limited.status, 429);
  const unavailable = await handleScrap(new Request(`https://scaylit.example/api/scrap?id=${id}`), env, async () => { throw new Error('network secret'); });
  assert.equal(unavailable.status, 502);
  assert.doesNotMatch(JSON.stringify(await unavailable.json()), /secret/);
});

test('Stop reaches the provider with DELETE and bypasses the creation rate limit', async () => {
  const response = await handleScrap(new Request(`https://scaylit.example/api/scrap?id=${id}`, { method: 'DELETE' }),
    { ...env, SCRAP_RATE_LIMIT: { limit: () => assert.fail('Stop must remain available') } }, async (url, init) => {
      assert.equal(url, `https://test.modal.run/jobs/${id}`);
      assert.equal(init.method, 'DELETE');
      return Response.json({ id, status: 'cancelled', removeText: true, cpuCall: 'private', gpuCall: 'private' });
    });
  assert.equal(response.status, 200);
  const job = await response.json();
  assert.equal(job.status, 'cancelled');
  assert.equal(isScrapPending(job), false);
  assert.equal(isScrapPending({ ...job, status: 'cancelling' }), true);
  assert.doesNotMatch(JSON.stringify(job), /private/);
});

test('ETA and measured progress are forwarded, while malformed values are discarded', async () => {
  const request = new Request(`https://scaylit.example/api/scrap?id=${id}`);
  const response = await handleScrap(request, env, async () => Response.json({ id, status: 'cleaning', removeText: true,
    overallProgress: 57, etaSeconds: 13, etaUpdatedAt: 110, updatedAt: 110, createdAt: 100 }));
  const job = await response.json();
  assert.equal(job.overallProgress, 57);
  assert.equal(job.etaSeconds, 13);
  assert.equal(scrapProgress(job, 112).estimate, 'Encore environ 15 s');
  assert.equal(scrapProgress(job, 112).elapsed, '12 s');
  assert.equal(scrapProgress(job, 140).percent, 57); // The clock cannot invent progress.
  assert.match(scrapProgress(job, 140).estimate, /réajustement/);
  const invalid = await handleScrap(request, env, async () => Response.json({ id, status: 'starting', removeText: true,
    overallProgress: 101, etaSeconds: -1, etaUpdatedAt: 'now', createdAt: -100 }));
  assert.equal((await invalid.json()).etaSeconds, undefined);
});
