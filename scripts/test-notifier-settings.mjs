import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
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

test('preserves extension settings and never downgrades a future schema', async () => {
  const { isFutureNotifierSettings, sanitizeNotifierSettings } = await loadMigrationModule();
  const current = sanitizeNotifierSettings({
    settingsVersion: 1,
    enabled: true,
    extensionOwnedSetting: { nested: ['keep-me'] },
  });
  assert.deepEqual(current.extensionOwnedSetting, { nested: ['keep-me'] });

  const future = sanitizeNotifierSettings({
    settingsVersion: 9,
    enabled: true,
    futureOnlySetting: { mode: 'new' },
  });
  assert.equal(isFutureNotifierSettings(future), true);
  assert.equal(future.settingsVersion, 9);
  assert.deepEqual(future.futureOnlySetting, { mode: 'new' });
});

test('merges only intended local edits over externally updated settings', async () => {
  const { changedNotifierSettingsKeys, mergeNotifierSettingsChanges, sanitizeNotifierSettings } = await loadMigrationModule();
  const baseline = sanitizeNotifierSettings({
    settingsVersion: 1,
    ntfyServer: 'https://old.example',
    ntfyTopic: 'old-topic',
  });
  const local = sanitizeNotifierSettings({ ...baseline, ntfyTopic: 'local-topic' });
  const latest = {
    settingsVersion: 1,
    ntfyServer: 'https://synced.example',
    ntfyTopic: 'old-topic',
    extensionOwnedSetting: { preserved: true },
  };
  const merged = mergeNotifierSettingsChanges(latest, local, changedNotifierSettingsKeys(baseline, local));
  assert.equal(merged.ntfyServer, 'https://synced.example');
  assert.equal(merged.ntfyTopic, 'local-topic');
  assert.deepEqual(merged.extensionOwnedSetting, { preserved: true });
});

test('an uncertain Notifier write forces a same-as-baseline revert', async () => {
  const { mergeNotifierSettingsChanges, sanitizeNotifierSettings } = await loadMigrationModule();
  const baseline = sanitizeNotifierSettings({ ntfyTopic: 'old-topic', ntfyServer: 'https://old.example' });
  const first = sanitizeNotifierSettings({ ...baseline, ntfyTopic: 'new-topic' });
  // Model a provider error reported after the write reached disk.
  const uncertainDisk = mergeNotifierSettingsChanges(baseline, first, ['ntfyTopic']);
  const reverted = sanitizeNotifierSettings({ ...baseline, ntfyTopic: 'old-topic' });
  const repaired = mergeNotifierSettingsChanges(uncertainDisk, reverted, ['ntfyTopic']);
  assert.equal(repaired.ntfyTopic, 'old-topic');
  assert.equal(repaired.ntfyServer, 'https://old.example');

  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(mainSource, /uncertainSettingsSaveKeys/);
  assert.match(mainSource, /for \(const key of changedKeys\) this\.uncertainSettingsSaveKeys\.add\(key\)/);
  assert.match(mainSource, /if \(!this\.settingsSavePending\) throw error/);
});

test('settings persistence fails closed after a read failure and text edits use durable saves', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
  const loadFailure = mainSource.slice(mainSource.indexOf("logger.flowError('Settings', 'load:failed'"), mainSource.indexOf('async saveSettings()'));
  const saveSettings = mainSource.slice(mainSource.indexOf('async saveSettings()'), mainSource.indexOf('log(message: string'));

  assert.match(loadFailure, /this\.settingsPersistenceBlocked = true/);
  assert.match(loadFailure, /this\.settingsPersistenceBlockedReason = 'load-failed'/);
  assert.match(saveSettings, /if \(this\.settingsPersistenceBlocked\) \{\s*this\.notifySettingsPersistenceBlocked\(\);\s*return;/);
  assert.match(saveSettings, /latestStored = await this\.loadData\(\)/);
  assert.doesNotMatch(settingsTabSource, /\bdebounce\b|debouncedSave/);
  assert.match(settingsTabSource, /this\.plugin\.settings\.ntfyServer = value;\s*await this\.plugin\.saveSettings\(\)/);
  assert.match(settingsTabSource, /this\.plugin\.settings\.ntfyTopic = value;\s*await this\.plugin\.saveSettings\(\)/);
});
