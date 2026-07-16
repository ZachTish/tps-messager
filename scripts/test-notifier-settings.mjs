import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let migrationModule;

async function loadMigrationModule() {
  if (migrationModule) return migrationModule;
  const outdir = await mkdtemp(join(tmpdir(), 'tps-notifier-settings-'));
  const outfile = join(outdir, 'settings-migration.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/settings-migration.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  migrationModule = await import(pathToFileURL(outfile).href);
  test.after(async () => {
    await rm(outdir, { recursive: true, force: true });
  });
  return migrationModule;
}

test('sanitizes legacy reminder-era data into transport-only settings', async () => {
  const { sanitizeNotifierSettings } = await loadMigrationModule();
  const settings = sanitizeNotifierSettings({
    enabled: false,
    enableManualComposer: false,
    ntfyServer: 'https://ntfy.example',
    ntfyTopic: 'topic',
    ntfyPriority: 9,
    enableLogging: true,
    alertState: { old: true },
    reminderRules: [{ old: true }],
    deviceRole: 'controller',
  });

  assert.deepEqual(Object.keys(settings).sort(), [
    'enableLogging',
    'enableManualComposer',
    'enabled',
    'ntfyPriority',
    'ntfyServer',
    'ntfyTopic',
    'settingsVersion',
  ]);
  assert.equal(settings.enabled, false);
  assert.equal(settings.ntfyPriority, 5);
  assert.equal(settings.ntfyServer, 'https://ntfy.example');
});

test('falls back to defaults for malformed persisted values', async () => {
  const { sanitizeNotifierSettings } = await loadMigrationModule();
  const settings = sanitizeNotifierSettings({
    enabled: 'yes',
    enableManualComposer: 1,
    ntfyServer: 42,
    ntfyTopic: null,
    ntfyPriority: 'urgent',
    enableLogging: 'true',
  });

  assert.equal(settings.enabled, false);
  assert.equal(settings.enableManualComposer, true);
  assert.equal(settings.ntfyServer, 'https://ntfy.sh');
  assert.equal(settings.ntfyTopic, '');
  assert.equal(settings.ntfyPriority, 3);
  assert.equal(settings.enableLogging, false);
});
