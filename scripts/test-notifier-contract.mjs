import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let requestModule;

async function loadRequestModule() {
  if (requestModule) return requestModule;
  const outdir = await mkdtemp(join(tmpdir(), 'tps-notifier-request-'));
  const outfile = join(outdir, 'ntfy-request.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/ntfy-request.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  requestModule = await import(pathToFileURL(outfile).href);
  test.after(async () => {
    await rm(outdir, { recursive: true, force: true });
  });
  return requestModule;
}

test('normalizes official ntfy topics and reverse-proxy base paths', async () => {
  const { buildNtfyUrl, validateNtfyTarget } = await loadRequestModule();

  assert.equal(buildNtfyUrl('https://ntfy.sh/', 'tps_topic-1'), 'https://ntfy.sh/tps_topic-1');
  assert.equal(buildNtfyUrl('https://push.example/api/ntfy///', '-_alerts'), 'https://push.example/api/ntfy/-_alerts');
  assert.equal(validateNtfyTarget('http://localhost:8080', '_').ok, true);
  assert.equal(buildNtfyUrl(' https://ntfy.example ', ' topic '), 'https://ntfy.example/topic');
});

test('rejects unsupported server URL components before constructing a target', async () => {
  const { buildNtfyUrl, validateNtfyTarget } = await loadRequestModule();
  const cases = [
    ['', 'topic', 'server-required'],
    ['not-a-url', 'topic', 'server-invalid'],
    ['ftp://ntfy.example', 'topic', 'protocol-unsupported'],
    ['https://user:secret@ntfy.example', 'topic', 'credentials-unsupported'],
    ['https://ntfy.example/base?token=secret', 'topic', 'query-unsupported'],
    ['https://ntfy.example/base?', 'topic', 'query-unsupported'],
    ['https://ntfy.example/base#fragment', 'topic', 'fragment-unsupported'],
    ['https://ntfy.example/base#', 'topic', 'fragment-unsupported'],
    ['https://ntfy.exa\nmple', 'topic', 'server-invalid'],
    ['https://ntfy.example/base\tpath', 'topic', 'server-invalid'],
    ['https://ntfy.example\\other', 'topic', 'server-invalid'],
    [`https://ntfy.example/${'a'.repeat(2048)}`, 'topic', 'server-too-long'],
  ];

  for (const [server, topic, reason] of cases) {
    assert.deepEqual(validateNtfyTarget(server, topic), { ok: false, reason });
    assert.equal(buildNtfyUrl(server, topic), null);
  }
});

test('enforces the exact ntfy topic alphabet and 64-character limit', async () => {
  const { buildNtfyUrl } = await loadRequestModule();

  assert.ok(buildNtfyUrl('https://ntfy.example', 'a'.repeat(64)));
  assert.ok(buildNtfyUrl('https://ntfy.example', '-leading-hyphen'));
  assert.ok(buildNtfyUrl('https://ntfy.example', '_leading_underscore'));
  for (const topic of ['', 'a'.repeat(65), 'topic.with.dot', '../topic', 'topic/path', 'topic with spaces', 'tópico']) {
    assert.equal(buildNtfyUrl('https://ntfy.example', topic), null, topic);
  }
});

test('request preparation fails on disabled delivery before URL or payload work', async () => {
  const { prepareNotifierRequest } = await loadRequestModule();
  assert.throws(
    () => prepareNotifierRequest({
      enabled: false,
      ntfyServer: '',
      ntfyTopic: '',
      ntfyPriority: 3,
    }, { not: 'text' }),
    (error) => error.code === 'delivery-disabled' && error.attempted === false,
  );
});

test('prepares an immutable request with explicit non-throwing HTTP semantics', async () => {
  const { prepareNotifierRequest } = await loadRequestModule();
  const request = prepareNotifierRequest(
    {
      enabled: true,
      ntfyServer: 'https://ntfy.example/',
      ntfyTopic: 'alerts_01',
      ntfyPriority: 4,
    },
    '',
    'Title ✓',
    'obsidian://tps-messager?vault=TPS&file=Inbox.md',
  );

  assert.deepEqual(request, {
    url: 'https://ntfy.example/alerts_01',
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Title': '=?UTF-8?B?VGl0bGUg4pyT?=',
      'Priority': '4',
      'Markdown': 'yes',
      'Click': 'obsidian://tps-messager?vault=TPS&file=Inbox.md',
    },
    body: '(empty message)',
    throw: false,
  });
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.headers), true);
});

test('rejects invalid payload types, priority, and header control characters locally', async () => {
  const { prepareNotifierRequest } = await loadRequestModule();
  const settings = {
    enabled: true,
    ntfyServer: 'https://ntfy.example',
    ntfyTopic: 'alerts',
    ntfyPriority: 3,
  };

  assert.throws(() => prepareNotifierRequest(settings, 42), /body must be text/i);
  assert.throws(() => prepareNotifierRequest(settings, 'body', { title: true }), /title must be text/i);
  assert.throws(() => prepareNotifierRequest(settings, 'body', 'bad\nheader'), /control characters/i);
  assert.throws(() => prepareNotifierRequest(settings, 'body', '\u0085'), /control characters/i);
  assert.throws(() => prepareNotifierRequest(settings, 'body', 'title', 42), /URL string/i);
  assert.throws(() => prepareNotifierRequest(settings, 'body', 'title', 'https://example.test/\runsafe'), /control characters/i);
  assert.throws(() => prepareNotifierRequest(settings, 'body', 'title', `obsidian://${'x'.repeat(4096)}`), /safety limit/i);
  assert.throws(
    () => prepareNotifierRequest({ ...settings, ntfyPriority: 3.5 }, 'body'),
    /integer from 1 to 5/i,
  );
  assert.throws(
    () => prepareNotifierRequest({ ...settings, ntfyPriority: 6 }, 'body'),
    /integer from 1 to 5/i,
  );
});

test('bounds titles and emits standards-sized RFC 2047 encoded words', async () => {
  const { NTFY_MAX_TITLE_BYTES, prepareNtfyTitle } = await loadRequestModule();

  assert.equal(NTFY_MAX_TITLE_BYTES, 512);
  assert.equal(prepareNtfyTitle('a'.repeat(512)), 'a'.repeat(512));
  assert.throws(() => prepareNtfyTitle('a'.repeat(513)), /512-byte safety limit/i);
  assert.equal(prepareNtfyTitle('😀'.repeat(128)).split(' ').every(word => word.length <= 75), true);
  assert.throws(() => prepareNtfyTitle('😀'.repeat(129)), /512-byte safety limit/i);
});

test('enforces the ntfy UTF-8 message boundary before it can become an attachment', async () => {
  const { NTFY_MAX_MESSAGE_BYTES, prepareNotifierRequest } = await loadRequestModule();
  const settings = {
    enabled: true,
    ntfyServer: 'https://ntfy.example',
    ntfyTopic: 'alerts',
    ntfyPriority: 3,
  };

  assert.equal(NTFY_MAX_MESSAGE_BYTES, 4096);
  assert.equal(prepareNotifierRequest(settings, 'a'.repeat(4096)).body.length, 4096);
  assert.equal(prepareNotifierRequest(settings, '😀'.repeat(1024)).body, '😀'.repeat(1024));
  assert.throws(() => prepareNotifierRequest(settings, 'a'.repeat(4097)), /treated as an attachment/i);
  assert.throws(() => prepareNotifierRequest(settings, '😀'.repeat(1025)), /treated as an attachment/i);
});
