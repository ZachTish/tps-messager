import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/logger.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const logger = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('logger announces only real disabled-to-enabled transitions', () => {
  const calls = [];
  const originalConsoleLog = console.log;
  console.log = (...args) => calls.push(args);

  try {
    logger.setLoggingEnabled(false);
    for (let index = 0; index < 100; index += 1) logger.setLoggingEnabled(true);

    const burstAnnouncements = calls.filter(([message]) =>
      String(message).includes('[Logger] Debug logging enabled')
    );
    assert.equal(burstAnnouncements.length, 1);

    logger.log('enabled diagnostic');
    logger.setLoggingEnabled(false);
    logger.log('suppressed diagnostic');
    logger.setLoggingEnabled(true);
    logger.log('re-enabled diagnostic');
  } finally {
    logger.setLoggingEnabled(false);
    console.log = originalConsoleLog;
  }

  const messages = calls.map(([message]) => String(message));
  assert.equal(messages.filter((message) => message.includes('[Logger] Debug logging enabled')).length, 2);
  assert.equal(messages.filter((message) => message === '[TPS Notifier] enabled diagnostic').length, 1);
  assert.equal(messages.filter((message) => message === '[TPS Notifier] suppressed diagnostic').length, 0);
  assert.equal(messages.filter((message) => message === '[TPS Notifier] re-enabled diagnostic').length, 1);
});

test('logger cleanup avoids repeated scans while preserving output and dedupe boundaries', () => {
  const calls = [];
  const originalConsoleError = console.error;
  const originalDateNow = Date.now;
  const originalMapEntries = Map.prototype.entries;
  let now = 1_000_000;
  let cleanupScans = 0;

  console.error = (...args) => calls.push(args);
  Date.now = () => now;
  Map.prototype.entries = function (...args) {
    if (this.size > 300) cleanupScans += 1;
    return originalMapEntries.apply(this, args);
  };

  try {
    for (let index = 0; index < 1_000; index += 1) {
      logger.error(`cleanup burst ${index}`, { index });
    }
    assert.equal(calls.length, 1_000);
    assert.equal(cleanupScans, 1);
    assert.deepEqual(calls[0], ['[TPS Notifier] cleanup burst 0', { index: 0 }]);

    logger.error('cleanup burst 999', { index: 999 });
    now += 2_999;
    logger.error('cleanup burst 999', { index: 999 });
    assert.equal(calls.length, 1_000);

    now += 1;
    logger.error('cleanup burst 999', { index: 999 });
    assert.equal(calls.length, 1_001);
    assert.equal(cleanupScans, 1);

    now += 1;
    logger.error('cleanup expiry trigger');
    assert.equal(calls.length, 1_002);
    assert.equal(cleanupScans, 2);

    now = 500_000;
    for (let index = 0; index < 250; index += 1) {
      logger.error(`regressed clock ${index}`);
    }
    assert.equal(cleanupScans, 2);

    now = 510_000;
    for (let index = 250; index < 300; index += 1) {
      logger.error(`regressed clock ${index}`);
    }
    assert.equal(cleanupScans, 3);

    const callCountBeforeRegression = calls.length;
    now = 500_100;
    logger.error('regressed clock 0');
    assert.equal(calls.length, callCountBeforeRegression + 1);
  } finally {
    Map.prototype.entries = originalMapEntries;
    Date.now = originalDateNow;
    console.error = originalConsoleError;
  }
});

test('plugin unload resets logger state after the final unload trace', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const unloadBody = mainSource.slice(
    mainSource.indexOf('onunload()'),
    mainSource.indexOf('async loadSettings()'),
  );

  assert.match(
    unloadBody,
    /logger\.flow\('Plugin', 'unload'\);\s*logger\.setLoggingEnabled\(false\);/,
  );
});
