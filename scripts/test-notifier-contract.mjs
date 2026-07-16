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

function buildNtfyUrl(server, topic) {
  const base = (server || '').replace(/\/+$/, '');
  const normalizedTopic = (topic || '').trim();
  if (!base || !normalizedTopic) return null;
  if (!/^https?:\/\//i.test(base)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalizedTopic)) return null;
  return `${base}/${normalizedTopic}`;
}

test('normalizes ntfy server and topic into request URL', () => {
  assert.equal(buildNtfyUrl('https://ntfy.sh/', 'tps_topic-1'), 'https://ntfy.sh/tps_topic-1');
});

test('rejects non-http ntfy servers', () => {
  assert.equal(buildNtfyUrl('ftp://ntfy.sh', 'topic'), null);
});

test('rejects topics that cannot be safely embedded in a URL path', () => {
  assert.equal(buildNtfyUrl('https://ntfy.sh', '../topic'), null);
  assert.equal(buildNtfyUrl('https://ntfy.sh', 'topic with spaces'), null);
});

test('request preparation fails on disabled delivery before any URL/config work', async () => {
  const { prepareNotifierRequest } = await loadRequestModule();
  assert.throws(
    () => prepareNotifierRequest({
      enabled: false,
      ntfyServer: '',
      ntfyTopic: '',
      ntfyPriority: 3,
    }, 'message'),
    /delivery is disabled/,
  );
});

test('request preparation builds the ntfy request contract without sending', async () => {
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
      'Title': 'Title ',
      'Priority': '4',
      'Markdown': 'yes',
      'Click': 'obsidian://tps-messager?vault=TPS&file=Inbox.md',
    },
    body: '(empty message)',
  });
});
