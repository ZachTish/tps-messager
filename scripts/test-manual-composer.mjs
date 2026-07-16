import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

let composerModule;

async function loadComposerModule() {
  if (composerModule) return composerModule;
  const outdir = await mkdtemp(join(tmpdir(), 'tps-notifier-composer-'));
  const outfile = join(outdir, 'manual-composer.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/manual-composer.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  composerModule = await import(pathToFileURL(outfile).href);
  test.after(async () => {
    await rm(outdir, { recursive: true, force: true });
  });
  return composerModule;
}

test('manual composer requires title or body content', async () => {
  const { getManualComposerValidationMessage } = await loadComposerModule();

  assert.equal(
    getManualComposerValidationMessage('', '   '),
    'Please provide a title or message body.',
  );
  assert.equal(getManualComposerValidationMessage('Title', ''), null);
  assert.equal(getManualComposerValidationMessage('', 'Body'), null);
});

test('manual composer expands disabled-delivery guidance inline', async () => {
  const { getManualComposerFailureMessage } = await loadComposerModule();

  assert.equal(
    getManualComposerFailureMessage(new Error('TPS Notifier delivery is disabled in settings.')),
    'TPS Notifier delivery is disabled in settings. Enable delivery transport in TPS Notifier settings, then try again.',
  );
});

test('manual composer preserves other send failures with retry guidance', async () => {
  const { getManualComposerFailureMessage } = await loadComposerModule();

  assert.equal(
    getManualComposerFailureMessage(new Error('ntfy returned 500: unavailable')),
    'ntfy returned 500: unavailable Fix the settings or network issue, then try again.',
  );
});

test('manual composer submit lifecycle keeps modal open until send succeeds', async () => {
  const { submitManualComposerNotification } = await loadComposerModule();
  let calls = 0;
  const validation = await submitManualComposerNotification(' ', '\n', async () => {
    calls += 1;
  });
  assert.deepEqual(validation, {
    shouldClose: false,
    statusText: 'Please provide a title or message body.',
  });
  assert.equal(calls, 0, 'empty submissions must not call send');

  const failed = await submitManualComposerNotification('Title', 'Body', async () => {
    calls += 1;
    throw new Error('ntfy returned 500: unavailable');
  });
  assert.deepEqual(failed, {
    shouldClose: false,
    statusText: 'ntfy returned 500: unavailable Fix the settings or network issue, then try again.',
  });
  assert.equal(calls, 1);

  const sentPayloads = [];
  const sent = await submitManualComposerNotification('Title', 'Body', async (body, title) => {
    sentPayloads.push({ body, title });
  });
  assert.deepEqual(sent, {
    shouldClose: true,
    statusText: '',
    noticeText: 'Notification Sent',
  });
  assert.deepEqual(sentPayloads, [{ body: 'Body', title: 'Title' }]);
});

test('manual composer modal delegates close decision to submit helper', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

  assert.match(mainSource, /import \{ submitManualComposerNotification \} from '\.\/manual-composer';/);
  assert.match(mainSource, /const result = await submitManualComposerNotification\(/);
  assert.match(mainSource, /if \(result\.shouldClose\) \{/);
  assert.match(mainSource, /if \(result\.noticeText\) new Notice\(result\.noticeText\);/);
  assert.match(mainSource, /statusEl\.setText\(result\.statusText\);/);
});

test('settings test send reports the actionable send failure', () => {
  const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');

  assert.match(settingsTabSource, /import \{ getManualComposerFailureMessage \} from '\.\/manual-composer';/);
  assert.match(settingsTabSource, /catch \(e\) \{[\s\S]{0,180}new Notice\(getManualComposerFailureMessage\(e\)\);/);
  assert.doesNotMatch(settingsTabSource, /new Notice\('Failed to send test notification'\)/);
});

test('dry run command and settings button prepare without sending', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
  const contractsSource = readFileSync(new URL('../src/tps-contracts.ts', import.meta.url), 'utf8');

  assert.match(mainSource, /id: 'dry-run-notification-delivery'/);
  assert.match(mainSource, /name: 'Validate Notification Delivery Setup \(Dry Run\)'/);
  assert.match(mainSource, /dryRunMessage: \(text: string, file\?: TFile, title\?: string\) => this\.dryRunMessage\(text, file, title\)/);
  assert.match(mainSource, /dryRunMessage\(text: string, file\?: TFile, title\?: string\): PreparedNotifierRequest/);
  assert.match(mainSource, /const request = prepareNotifierRequest\(\s*this\.settings,\s*text,\s*title,\s*this\.buildObsidianLink\(file\),\s*\);/);
  assert.doesNotMatch(mainSource, /dryRunMessage[\s\S]{0,700}requestUrl\(/);

  assert.match(settingsTabSource, /setName\('Dry Run Delivery Setup'\)/);
  assert.match(settingsTabSource, /setButtonText\('Dry Run'\)/);
  assert.match(settingsTabSource, /const request = this\.plugin\.dryRunMessage\(/);
  assert.match(settingsTabSource, /new Notice\(`Dry run prepared: \$\{request\.url\}`\)/);
  assert.match(settingsTabSource, /new Notice\(getManualComposerFailureMessage\(e\)\)/);

  assert.match(contractsSource, /dryRunMessage\?: \(text: string, file\?: unknown, title\?: string\) => unknown;/);
});

test('settings UI fails closed when delivery enabled state is missing', () => {
  const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');

  assert.match(settingsTabSource, /setValue\(this\.plugin\.settings\.enabled === true\)/);
  assert.match(settingsTabSource, /if \(this\.plugin\.settings\.enabled === true\) \{/);
  assert.match(
    settingsTabSource,
    /if \(this\.plugin\.settings\.enabled === true && \(this\.plugin\.settings\.enableManualComposer \?\? true\)\) \{/,
  );
  assert.doesNotMatch(settingsTabSource, /settings\.enabled \?\? true/);
});

test('notifier diagnostics trace delivery and protocol decisions without logging bodies', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const settingsTabSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
  const loggerSource = readFileSync(new URL('../src/logger.ts', import.meta.url), 'utf8');

  for (const event of [
    "logger.flow('Delivery', 'send:start'",
    "logger.flow('Delivery', 'send:request'",
    "logger.flow('Delivery', 'send:done'",
    "logger.flowError('Delivery', 'send:prepare-failed'",
    "logger.flowError('Delivery', 'send:http-failed'",
    "logger.flowError('Delivery', 'send:failed'",
    "logger.flow('Delivery', 'dry-run:prepared'",
    "logger.flow('Protocol', 'open:start'",
    "logger.flowWarn('Protocol', 'open:blocked'",
    "logger.flowWarn('Protocol', 'open:missing-file'",
    "logger.flow('ManualComposer', 'submit:start'",
    "logger.flowError('Settings', 'save:failed'",
  ]) {
    assert.match(mainSource, new RegExp(event.replace(/[()'.]/g, '\\$&')));
  }

  for (const event of [
    "logger.flow('SettingsUI', 'logging-toggle'",
    "logger.flow('SettingsUI', 'dry-run:start'",
    "logger.flow('SettingsUI', 'dry-run:done'",
    "logger.flowError('SettingsUI', 'dry-run:failed'",
    "logger.flow('SettingsUI', 'test-send:start'",
    "logger.flow('SettingsUI', 'test-send:done'",
    "logger.flowError('SettingsUI', 'test-send:failed'",
  ]) {
    assert.match(settingsTabSource, new RegExp(event.replace(/[()'.]/g, '\\$&')));
  }

  assert.match(mainSource, /bodyLength: \(text \|\| ''\)\.length/);
  assert.match(mainSource, /bodyLength: request\.body\.length/);
  assert.doesNotMatch(mainSource, /body: request\.body/);
  assert.match(loggerSource, /export function flow\(scope: string, event: string/);
  assert.match(loggerSource, /export function flowWarn\(scope: string, event: string/);
  assert.match(loggerSource, /export function flowError\(scope: string, event: string, err: unknown/);
});
