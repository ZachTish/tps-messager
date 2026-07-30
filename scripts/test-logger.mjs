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
