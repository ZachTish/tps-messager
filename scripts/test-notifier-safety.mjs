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
  logLevel: 'silent',
});
const safety = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const loggerSource = readFileSync(new URL('../src/logger.ts', import.meta.url), 'utf8');

test('protocol paths preserve already-decoded percent characters and normalize separators once', () => {
  assert.equal(safety.normalizeNotifierProtocolPath('Inbox/100% Complete.md'), 'Inbox/100% Complete.md');
  assert.equal(safety.normalizeNotifierProtocolPath('Notes/Literal %20 token.md'), 'Notes/Literal %20 token.md');
  assert.equal(safety.normalizeNotifierProtocolPath('Folder\\Note.md'), 'Folder/Note.md');
  assert.doesNotMatch(mainSource, /decodeURIComponent\(params\.(?:vault|file)\)/);
});

test('protocol path validation rejects traversal, absolute, empty, null, and abusive shapes', () => {
  for (const value of [
    '',
    '../Secret.md',
    'Folder/../Secret.md',
    './Note.md',
    '/Absolute.md',
    'Folder//Note.md',
    'Null\0Byte.md',
    'a'.repeat(4097),
    `${'a'.repeat(256)}.md`,
    Array.from({ length: 257 }, () => 'a').join('/'),
  ]) {
    assert.equal(safety.normalizeNotifierProtocolPath(value), null, value.slice(0, 80));
  }
  assert.ok(safety.normalizeNotifierProtocolPath(Array.from({ length: 256 }, () => 'a').join('/')));
});

test('notification diagnostics omit topic, credentials, and full target URLs', () => {
  const target = 'https://user:password@ntfy.example/private_alerts';
  assert.deepEqual(safety.summarizeNotifierTarget(target), {
    serverHost: 'ntfy.example',
    secure: true,
    hasTopic: true,
  });

  const safeError = safety.sanitizeNotifierDeliveryError(
    new Error(`POST ${target} failed for private body and private_alerts`),
  );
  assert.equal(safeError.code, 'delivery-unconfirmed');
  assert.equal(safeError.attempted, true);
  assert.doesNotMatch(safeError.message, /private|user|password|ntfy\.example/);
  assert.doesNotMatch(safeError.stack || '', /private_alerts|user|password|private body/);
  assert.doesNotMatch(mainSource, /url:\s*request\.url/);
  assert.doesNotMatch(mainSource, /body:\s*request\.body/);
  assert.doesNotMatch(mainSource, /(?:^|[,\s{])path:\s*(?:normalizedPath|file\.path)/m);
  assert.match(mainSource, /logger\.isLoggingEnabled\(\)[\s\S]{0,160}\{ secure: target\.secure, hasTopic: target\.hasTopic \}/);
});

test('delivery uses explicit response handling without reading raw provider text', () => {
  const deliverySource = mainSource.slice(
    mainSource.indexOf('private async executePreparedRequest('),
    mainSource.indexOf('dryRunMessage(', mainSource.indexOf('private async executePreparedRequest(')),
  );
  assert.match(mainSource, /throw: false/);
  assert.match(mainSource, /executeNotifierDelivery\(request/);
  assert.doesNotMatch(deliverySource, /response\.text/);
  assert.doesNotMatch(deliverySource, /Promise\.race/);
  assert.doesNotMatch(deliverySource, /setTimeout\(/);
});

test('always-on logging omits generic error messages and stacks and bounds dedupe state', () => {
  assert.match(loggerSource, /const MAX_RECENT_MESSAGES = 300/);
  assert.match(loggerSource, /while \(recentMessages\.size >= MAX_RECENT_MESSAGES\)/);
  assert.match(loggerSource, /err\.name === 'NotifierError'/);
  assert.doesNotMatch(loggerSource, /stack:\s*err\.stack/);
  assert.doesNotMatch(loggerSource, /message:\s*String\(err\)/);
});
