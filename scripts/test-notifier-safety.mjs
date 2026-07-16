import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/notifier-safety.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const safety = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('protocol paths preserve already-decoded percent characters', () => {
  assert.equal(safety.normalizeNotifierProtocolPath('Inbox/100% Complete.md'), 'Inbox/100% Complete.md');
  assert.equal(safety.normalizeNotifierProtocolPath('Notes/Literal %20 token.md'), 'Notes/Literal %20 token.md');
  assert.equal(safety.normalizeNotifierProtocolPath('Folder\\Note.md'), 'Folder/Note.md');
  assert.equal(safety.normalizeNotifierProtocolPath('../Secret.md'), null);
  assert.equal(safety.normalizeNotifierProtocolPath('/Absolute.md'), null);
  assert.doesNotMatch(mainSource, /decodeURIComponent\(params\.(?:vault|file)\)/);
});

test('notification diagnostics omit topic, credentials, and full target URLs', () => {
  const target = 'https://user:password@ntfy.example/private_alerts';
  assert.deepEqual(safety.summarizeNotifierTarget(target), {
    serverHost: 'ntfy.example',
    secure: true,
    hasTopic: true,
  });

  const safeError = safety.sanitizeNotifierDeliveryError(
    new Error(`POST ${target} failed for private_alerts`),
    target,
  );
  assert.doesNotMatch(safeError.message, /private_alerts|user|password/);
  assert.doesNotMatch(safeError.stack || '', /private_alerts|user|password/);
  assert.match(safeError.message, /https:\/\/ntfy\.example\/\[redacted\]/);
  assert.doesNotMatch(mainSource, /url:\s*request\.url/);
  assert.doesNotMatch(mainSource, /title:\s*title\s*\|\|/);
});
