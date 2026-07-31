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
const loggerModuleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`;
const logger = await import(loggerModuleUrl);
let loggerInstance = 0;

const importFreshLogger = () => import(`${loggerModuleUrl}#${loggerInstance += 1}`);

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

test('logger cleanup avoids repeated scans while preserving output and dedupe boundaries', async () => {
  const cleanupLogger = await importFreshLogger();
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
      cleanupLogger.error(`cleanup burst ${index}`, { index });
    }
    assert.equal(calls.length, 1_000);
    assert.equal(cleanupScans, 1);
    assert.deepEqual(calls[0], ['[TPS Notifier] cleanup burst 0', { index: 0 }]);

    cleanupLogger.error('cleanup burst 999', { index: 999 });
    now += 2_999;
    cleanupLogger.error('cleanup burst 999', { index: 999 });
    assert.equal(calls.length, 1_000);

    now += 1;
    cleanupLogger.error('cleanup burst 999', { index: 999 });
    assert.equal(calls.length, 1_001);
    assert.equal(cleanupScans, 1);

    now += 1;
    cleanupLogger.error('cleanup expiry trigger');
    assert.equal(calls.length, 1_002);
    assert.equal(cleanupScans, 2);

    now = 500_000;
    for (let index = 0; index < 250; index += 1) {
      cleanupLogger.error(`regressed clock ${index}`);
    }
    assert.equal(cleanupScans, 2);

    now = 510_000;
    for (let index = 250; index < 300; index += 1) {
      cleanupLogger.error(`regressed clock ${index}`);
    }
    assert.equal(cleanupScans, 3);

    const callCountBeforeRegression = calls.length;
    now = 500_100;
    cleanupLogger.error('regressed clock 0');
    assert.equal(calls.length, callCountBeforeRegression + 1);
  } finally {
    Map.prototype.entries = originalMapEntries;
    Date.now = originalDateNow;
    console.error = originalConsoleError;
  }
});

test('logger reanchors dedupe after a backward clock movement', () => {
  const calls = [];
  const originalConsoleError = console.error;
  const originalDateNow = Date.now;
  let now = 0;

  console.error = (...args) => calls.push(args);
  Date.now = () => now;

  try {
    logger.error('clock rollback diagnostic');
    logger.error('clock rollback diagnostic');
    assert.equal(calls.length, 1, 'timestamp zero must still deduplicate');

    now = 10_000_000;
    logger.error('clock rollback diagnostic');
    assert.equal(calls.length, 2);

    now -= 3_600_000;
    logger.error('clock rollback diagnostic');
    assert.equal(calls.length, 3, 'a backward jump must start a new dedupe window');

    now += 2_999;
    logger.error('clock rollback diagnostic');
    assert.equal(calls.length, 3);

    now += 1;
    logger.error('clock rollback diagnostic');
    assert.equal(calls.length, 4, 'the exact 3,000 ms boundary must still emit');
  } finally {
    Date.now = originalDateNow;
    console.error = originalConsoleError;
  }

  assert.deepEqual(
    calls.map(([message]) => message),
    Array(4).fill('[TPS Notifier] clock rollback diagnostic'),
  );
});

test('logger cleanup drops future-dated history after a backward clock movement', async () => {
  const rollbackLogger = await importFreshLogger();
  const originalConsoleError = console.error;
  const originalDateNow = Date.now;
  const originalMapEntries = Map.prototype.entries;
  const originalMapDelete = Map.prototype.delete;
  const cleanupSizes = [];
  let deleteCalls = 0;
  let now = 10_000_000;

  console.error = () => {};
  Date.now = () => now;
  Map.prototype.entries = function (...args) {
    if (this.size > 300) cleanupSizes.push(this.size);
    return originalMapEntries.apply(this, args);
  };
  Map.prototype.delete = function (...args) {
    deleteCalls += 1;
    return originalMapDelete.apply(this, args);
  };

  try {
    for (let index = 0; index < 1_000; index += 1) {
      rollbackLogger.error(`pre-rollback ${index}`);
    }
    assert.deepEqual(cleanupSizes, [301]);

    now = 6_400_000;
    rollbackLogger.error('post-rollback 0');
    now += 3_001;
    rollbackLogger.error('post-rollback 1');
    assert.deepEqual(cleanupSizes, [301, 1_002]);
    assert.equal(deleteCalls, 1_001);

    now += 3_001;
    rollbackLogger.error('post-rollback 2');
    assert.deepEqual(cleanupSizes, [301, 1_002], 'stale future history must not be rescanned');
  } finally {
    Map.prototype.delete = originalMapDelete;
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
