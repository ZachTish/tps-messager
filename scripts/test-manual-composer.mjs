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
    stdin: {
      contents: "export * from './manual-composer'; export { NotifierError } from './notifier-errors';",
      resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
      sourcefile: 'manual-composer-test-entry.ts',
      loader: 'ts',
    },
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

  assert.equal(getManualComposerValidationMessage('', '   '), 'Please provide a title or message body.');
  assert.equal(getManualComposerValidationMessage('Title', ''), null);
  assert.equal(getManualComposerValidationMessage('', 'Body'), null);
});

test('manual composer gives targeted guidance for typed local failures', async () => {
  const { getManualComposerFailureMessage, NotifierError } = await loadComposerModule();

  assert.equal(
    getManualComposerFailureMessage(new NotifierError(
      'delivery-disabled',
      'TPS Notifier delivery is disabled in settings. Enable delivery transport before trying again.',
    )),
    'TPS Notifier delivery is disabled in settings. Enable delivery transport before trying again.',
  );
  assert.equal(
    getManualComposerFailureMessage(new NotifierError(
      'delivery-disabled',
      'Notification delivery is paused while a disable request is being saved.',
    )),
    'Notification delivery is paused while a disable request is being saved.',
  );
  assert.equal(
    getManualComposerFailureMessage(new NotifierError('invalid-configuration', 'Configure a valid target.')),
    'Configure a valid target. Correct the issue, then try again.',
  );
});

test('manual composer preserves unconfirmed-delivery duplicate warning', async () => {
  const { getManualComposerFailureMessage, NotifierError } = await loadComposerModule();
  const message = 'Notification delivery was not confirmed. Check ntfy before retrying to avoid a duplicate.';

  assert.equal(
    getManualComposerFailureMessage(new NotifierError(
      'delivery-unconfirmed',
      message,
      true,
      'unconfirmed',
    )),
    message,
  );
});

test('manual composer does not append contradictory retry text to explicit rejections', async () => {
  const { getManualComposerFailureMessage, NotifierError } = await loadComposerModule();
  const message = 'ntfy rejected the notification (HTTP 401). Correct the delivery configuration or payload before retrying.';

  assert.equal(
    getManualComposerFailureMessage(new NotifierError(
      'delivery-rejected',
      message,
      true,
      'rejected',
      401,
    )),
    message,
  );
});

test('manual composer never surfaces arbitrary raw transport failures', async () => {
  const { getManualComposerFailureMessage } = await loadComposerModule();
  const message = getManualComposerFailureMessage(
    new Error('ntfy returned private body for https://user:secret@example.test/private_topic'),
  );

  assert.equal(
    message,
    'Notification delivery failed before a result was available. Review the settings and logs before trying again.',
  );
  assert.doesNotMatch(message, /private|secret|example\.test/);
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
  assert.equal(calls, 0);

  const failed = await submitManualComposerNotification('Title', 'Body', async () => {
    calls += 1;
    throw new Error('raw provider secret');
  });
  assert.deepEqual(failed, {
    shouldClose: false,
    statusText: 'Notification delivery failed before a result was available. Review the settings and logs before trying again.',
  });
  assert.equal(calls, 1);

  const sentPayloads = [];
  const sent = await submitManualComposerNotification('Title', 'Body', async (body, title) => {
    sentPayloads.push({ body, title });
  });
  assert.deepEqual(sent, {
    shouldClose: true,
    statusText: '',
    noticeText: 'Notification accepted by ntfy.',
  });
  assert.deepEqual(sentPayloads, [{ body: 'Body', title: 'Title' }]);
});

test('manual composer modal is single-instance, accessible, and unload-safe', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const modalSource = readFileSync(new URL('../src/manual-composer-modal.ts', import.meta.url), 'utf8');

  assert.match(mainSource, /private readonly manualComposerModals = new Set<ManualComposerModal>\(\)/);
  assert.match(mainSource, /if \(this\.manualComposerModals\.size > 0\)/);
  assert.match(modalSource, /this\.setTitle\('Send Custom Notification'\)/);
  assert.match(modalSource, /titleLabel\.setAttr\('for', titleInput\.id\)/);
  assert.match(modalSource, /bodyLabel\.setAttr\('for', bodyInput\.id\)/);
  assert.match(modalSource, /statusEl\.setAttr\('role', 'status'\)/);
  assert.match(modalSource, /statusEl\.setAttr\('aria-live', 'polite'\)/);
  assert.match(modalSource, /container\.setAttr\('aria-busy', 'true'\)/);
  assert.match(modalSource, /titleInput\.disabled = true/);
  assert.match(modalSource, /bodyInput\.disabled = true/);
  assert.doesNotMatch(modalSource, /maxLength = NTFY_MAX_TITLE_BYTES/);
  assert.doesNotMatch(modalSource, /tps-keyboard-aware-modal/);
  assert.match(modalSource, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(modalSource, /Notification sending continues/);
  assert.match(modalSource, /Notification accepted by ntfy after the composer was closed/);
  assert.match(mainSource, /canShowResult: \(\) => this\.isReadyForUiFeedback\(uiLifecycleToken\)/);
  assert.match(mainSource, /this\.closeManualComposerModals\(\)/);
});

test('settings use a separate apply/discard transport draft and redacted dry run', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const settingsSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');

  assert.match(settingsSource, /private transportDraft: TransportSettingsDraft \| null = null/);
  assert.match(settingsSource, /this\.plugin\.setTransportConfigurationDirty\(this\.transportDraftDirty\)/);
  assert.match(settingsSource, /setName\('Apply transport configuration'\)/);
  assert.match(settingsSource, /setButtonText\('Discard draft'\)/);
  assert.match(settingsSource, /const snapshot = \{ \.\.\.draft \}/);
  assert.match(settingsSource, /this\.plugin\.applyTransportSettings\(snapshot\)/);
  assert.match(settingsSource, /private transportCommitInFlight = false/);
  assert.match(settingsSource, /private settingsActionInFlight = false/);
  assert.match(settingsSource, /private readonly uiLifecycleToken: number/);
  assert.match(settingsSource, /isReadyForUiFeedback\(this\.uiLifecycleToken\)/);
  assert.match(settingsSource, /private testSendInFlight = false/);
  assert.match(settingsSource, /this\.setSettingsControlsDisabled\(true\)/);
  assert.match(settingsSource, /data-tps-notifier-focus/);
  assert.match(settingsSource, /!this\.transportDraftDirty && !warningReason/);
  assert.match(settingsSource, /Explicitly apply this repaired transport configuration/);
  assert.match(settingsSource, /\|\| !!warningReason/);
  assert.match(settingsSource, /redisplayIfVisible\(applied \? 'server' : 'apply'\)/);
  assert.match(settingsSource, /this\.testSendButton\?\.setButtonText\('Send Test'\)/);
  assert.match(settingsSource, /if \(!this\.transportCommitInFlight\) this\.resetTransportDraft\(true\)/);
  assert.doesNotMatch(settingsSource, /this\.plugin\.settings\.(?:ntfyServer|ntfyTopic|ntfyPriority)\s*=/);
  assert.match(settingsSource, /this\.plugin\.validateTransportSettingsDraft\(\{ \.\.\.draft \}\)/);
  assert.match(settingsSource, /new Notice\(this\.plugin\.diagnosticNotice\(diagnostic\)\)/);
  assert.doesNotMatch(settingsSource, /Dry run prepared:.*request\.url/);
  assert.doesNotMatch(mainSource, /deliverySuspended \|\| this\.transportConfigurationDirty/);
  assert.doesNotMatch(mainSource, /if \(this\.transportConfigurationDirty\).*accept delivery/s);
  assert.match(settingsSource, /enabled transport continues using its last applied target/);
  assert.match(settingsSource, /if \(this\.plugin\.settings\.enabled\) \{/);
});

test('composer and settings styles are scoped and self-contained on mobile', () => {
  const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  assert.match(styles, /\.tps-notifier-settings \.tps-notifier-collapsible-section/);
  assert.doesNotMatch(styles, /\.tps-notifier-settings \.tps-collapsible-section/);
  assert.match(styles, /\.tps-messager-composer \.tps-messager-field input/);
  assert.match(styles, /\.tps-messager-composer \.tps-messager-status\.is-error/);
  assert.match(styles, /body\.is-mobile \.modal\.tps-messager-composer/);
  assert.match(styles, /100dvh/);
});

test('core delivery owns no UI notice and settings test send reports one result', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const settingsSource = readFileSync(new URL('../src/settings-tab.ts', import.meta.url), 'utf8');
  const sendBody = mainSource.slice(
    mainSource.indexOf('async sendMessage('),
    mainSource.indexOf('dryRunMessage(', mainSource.indexOf('async sendMessage(')),
  );

  assert.doesNotMatch(sendBody, /new Notice\(/);
  assert.match(settingsSource, /new Notice\(getManualComposerFailureMessage\(error\)\)/);
  assert.match(settingsSource, /new Notice\('Test notification accepted by ntfy\.'\)/);
});
