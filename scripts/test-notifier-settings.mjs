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
    enabled: true,
    enableManualComposer: false,
    ntfyServer: ' https://ntfy.example/base/ ',
    ntfyTopic: ' topic ',
    ntfyPriority: 5,
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
  assert.equal(settings.enabled, true, 'valid legacy transport remains enabled');
  assert.equal(settings.ntfyPriority, 5);
  assert.equal(settings.ntfyServer, 'https://ntfy.example/base/');
  assert.equal(settings.ntfyTopic, 'topic');
});

test('fails malformed persisted fields closed without constructing a public route', async () => {
  const { hasMalformedNotifierSettingsFields, sanitizeNotifierSettings } = await loadMigrationModule();
  const raw = {
    settingsVersion: 1,
    enabled: 'yes',
    enableManualComposer: 1,
    ntfyServer: 42,
    ntfyTopic: 'private_topic',
    ntfyPriority: 'urgent',
    enableLogging: 'true',
  };
  const settings = sanitizeNotifierSettings({
    ...raw,
  });

  assert.equal(hasMalformedNotifierSettingsFields(raw), true);
  assert.equal(settings.enabled, false);
  assert.equal(settings.enableManualComposer, true);
  assert.equal(settings.ntfyServer, '');
  assert.equal(settings.ntfyTopic, 'private_topic');
  assert.equal(settings.ntfyPriority, 3);
  assert.equal(settings.enableLogging, false);
});

test('never rounds or clamps malformed priority while leaving delivery active', async () => {
  const { hasMalformedNotifierSettingsFields, sanitizeNotifierSettings } = await loadMigrationModule();
  for (const ntfyPriority of [0, 2.5, 6, 99, Number.NaN, '3']) {
    const raw = {
      settingsVersion: 1,
      enabled: true,
      ntfyServer: 'https://ntfy.example',
      ntfyTopic: 'private_topic',
      ntfyPriority,
    };
    assert.equal(hasMalformedNotifierSettingsFields(raw), true);
    assert.equal(sanitizeNotifierSettings(raw).enabled, false);
    assert.equal(sanitizeNotifierSettings(raw).ntfyPriority, 3);
  }
});

test('current-schema documents cannot silently default missing required fields while enabled', async () => {
  const { hasMalformedNotifierSettingsFields, sanitizeNotifierSettings } = await loadMigrationModule();
  const partial = {
    settingsVersion: 1,
    enabled: true,
    ntfyServer: 'https://ntfy.example',
    ntfyTopic: 'private_topic',
  };

  assert.equal(hasMalformedNotifierSettingsFields(partial), true);
  assert.equal(sanitizeNotifierSettings(partial).enabled, false);
  assert.equal(sanitizeNotifierSettings(partial).ntfyPriority, 3);
});

test('never carries enabled delivery onto an implicit or invalid transport target', async () => {
  const { sanitizeNotifierSettings } = await loadMigrationModule();
  const invalidTargets = [
    { ntfyTopic: 'private_topic' },
    { ntfyServer: 'https://self-hosted.example' },
    { ntfyServer: 42, ntfyTopic: 'private_topic' },
    { ntfyServer: 'https://self-hosted.example', ntfyTopic: null },
    { ntfyServer: 'https://self-hosted.example', ntfyTopic: 'contains.dot' },
    { ntfyServer: 'https://user:secret@self-hosted.example', ntfyTopic: 'private_topic' },
  ];

  for (const target of invalidTargets) {
    const settings = sanitizeNotifierSettings({ enabled: true, ...target });
    assert.equal(settings.enabled, false, JSON.stringify(target));
    if (typeof target.ntfyServer !== 'string') {
      assert.equal(settings.ntfyServer, '', 'an enabled malformed target must not fall back to public ntfy.sh');
    }
  }
});

test('future-version settings remain readable but fail closed for delivery and writes', async () => {
  const {
    NOTIFIER_SETTINGS_VERSION,
    classifyNotifierSettingsVersion,
    sanitizeNotifierSettings,
  } = await loadMigrationModule();
  const raw = {
    settingsVersion: NOTIFIER_SETTINGS_VERSION + 1,
    enabled: true,
    ntfyServer: 'https://self-hosted.example',
    ntfyTopic: 'private_topic',
    ntfyPriority: 3,
  };

  assert.equal(classifyNotifierSettingsVersion(raw), 'future');
  assert.equal(sanitizeNotifierSettings(raw).enabled, false);
  assert.equal(classifyNotifierSettingsVersion({ settingsVersion: NOTIFIER_SETTINGS_VERSION }), 'current');
  assert.equal(classifyNotifierSettingsVersion(null), 'legacy');
});

test('present malformed settings versions are read-only and delivery-disabled', async () => {
  const { classifyNotifierSettingsVersion, sanitizeNotifierSettings } = await loadMigrationModule();
  const base = {
    enabled: true,
    ntfyServer: 'https://self-hosted.example',
    ntfyTopic: 'private_topic',
    ntfyPriority: 3,
  };

  assert.equal(classifyNotifierSettingsVersion(base), 'legacy');
  assert.equal(sanitizeNotifierSettings(base).enabled, true);
  for (const settingsVersion of ['2', null, {}, -1, 0, 1.5, Number.NaN]) {
    const raw = { ...base, settingsVersion };
    assert.equal(classifyNotifierSettingsVersion(raw), 'invalid-version');
    assert.equal(sanitizeNotifierSettings(raw).enabled, false);
  }
});

test('non-object settings documents are classified as invalid data', async () => {
  const { classifyNotifierSettingsVersion, sanitizeNotifierSettings } = await loadMigrationModule();

  assert.equal(classifyNotifierSettingsVersion(null), 'legacy');
  assert.equal(classifyNotifierSettingsVersion(undefined), 'legacy');
  assert.equal(classifyNotifierSettingsVersion({}), 'legacy');
  for (const value of ['corrupt', 42, true, []]) {
    assert.equal(classifyNotifierSettingsVersion(value), 'invalid-data');
    assert.equal(sanitizeNotifierSettings(value).enabled, false);
  }
});

test('flags a formerly tolerated enabled target for explicit migration UX', async () => {
  const { hasInvalidEnabledTransport } = await loadMigrationModule();

  assert.equal(hasInvalidEnabledTransport({
    enabled: true,
    ntfyServer: 'https://ntfy.example',
    ntfyTopic: 'contains.dot',
  }), true);
  assert.equal(hasInvalidEnabledTransport({
    enabled: false,
    ntfyServer: 'https://ntfy.example',
    ntfyTopic: 'contains.dot',
  }), false);
  assert.equal(hasInvalidEnabledTransport({
    enabled: true,
    ntfyServer: 'https://ntfy.example',
    ntfyTopic: 'valid_topic',
  }), false);
});
