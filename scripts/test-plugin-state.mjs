import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const outdir = await mkdtemp(join(tmpdir(), 'tps-notifier-main-'));
const outfile = join(outdir, 'main.mjs');
const obsidianStub = `
export class TFile {
  constructor(path) { this.path = path; }
}
globalThis.__tpsTFileClass = TFile;
export class Plugin {
  constructor() {
    this.app = {
      vault: {
        getName: () => 'Synthetic Test Vault',
        getAbstractFileByPath: () => null,
      },
      workspace: { getLeaf: () => null },
    };
  }
  async loadData() { return null; }
  async saveData() {}
  addCommand(command) { (this.__commands ||= []).push(command); }
  addSettingTab(tab) { this.__settingTab = tab; }
  registerObsidianProtocolHandler(name, callback) { (this.__protocols ||= new Map()).set(name, callback); }
}
export class Notice {
  constructor(message) { (globalThis.__tpsNotices ||= []).push(String(message)); }
}
export class Modal {
  constructor(app) { this.app = app; }
  open() {}
  close() { this.onClose?.(); }
}
export class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = {}; }
  hide() {}
}
export class Setting {}
export class ButtonComponent {}
export class App {}
export async function requestUrl(request) {
  if (typeof globalThis.__tpsRequestUrl !== 'function') throw new Error('Unexpected requestUrl call');
  return await globalThis.__tpsRequestUrl(request);
}
`;

await build({
  entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'synthetic-obsidian',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'synthetic' }));
      buildApi.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({
        contents: obsidianStub,
        loader: 'js',
      }));
    },
  }],
});

const { default: TPSNotifier } = await import(pathToFileURL(outfile).href);
test.after(async () => {
  delete globalThis.__tpsRequestUrl;
  delete globalThis.__tpsNotices;
  delete globalThis.__tpsTFileClass;
  await rm(outdir, { recursive: true, force: true });
});

const validSettings = Object.freeze({
  settingsVersion: 1,
  enabled: true,
  enableManualComposer: true,
  ntfyServer: 'https://ntfy.example',
  ntfyTopic: 'private_topic',
  ntfyPriority: 3,
  enableLogging: false,
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function loadPlugin({
  data = validSettings,
  saveData = async () => undefined,
  requestUrl = async () => ({
    status: 200,
    json: { id: 'message_id', event: 'message', topic: 'private_topic' },
  }),
} = {}) {
  globalThis.__tpsNotices = [];
  globalThis.__tpsRequestUrl = requestUrl;
  const plugin = new TPSNotifier();
  plugin.loadData = async () => (
    data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : data
  );
  plugin.saveData = saveData;
  await plugin.onload();
  return plugin;
}

test('failed disable is atomic even when queued behind another settings save', async () => {
  let saveCall = 0;
  let releaseFirst;
  const plugin = await loadPlugin({
    saveData: async () => {
      saveCall += 1;
      if (saveCall === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      if (saveCall === 2) throw new Error('disable persistence failed');
    },
  });
  const api = plugin.api;
  const first = plugin.setLoggingEnabled(true);
  await tick();
  const disable = plugin.setDeliveryEnabled(false);
  const disableFailure = assert.rejects(
    disable,
    (error) => error.code === 'internal-error' && !/disable persistence failed/.test(error.message),
  );

  assert.throws(
    () => api.validate({ body: 'while disable is pending' }),
    (error) => error.code === 'delivery-disabled' && error.attempted === false,
  );
  assert.equal(plugin.settings.enabled, true);
  assert.equal(plugin.settings.enableLogging, false);

  releaseFirst();
  await first;
  await disableFailure;
  assert.equal(plugin.settings.enabled, true, 'failed disable must not alter durable in-memory settings');
  assert.equal(plugin.settings.enableLogging, true, 'the prior successful transaction keeps its own result');
  assert.equal(api.validate({ body: 'delivery resumed after explicit save failure' }).valid, true);
  plugin.onunload();
});

test('unsupported enabled transport is disabled with a warning and no public-server fallback', async () => {
  const plugin = await loadPlugin({
    data: {
      settingsVersion: 1,
      enabled: true,
      enableManualComposer: true,
      ntfyTopic: 'private_topic',
      ntfyPriority: 3,
      enableLogging: false,
    },
  });

  assert.equal(plugin.settings.enabled, false);
  assert.equal(plugin.settings.ntfyServer, '');
  assert.match(plugin.getSettingsWarningReason(), /Saved delivery was disabled/);
  assert.equal(globalThis.__tpsNotices.some((message) => /unsupported or malformed saved delivery target/.test(message)), true);
  plugin.onunload();
});

test('malformed present settings version blocks delivery and all writes', async () => {
  const plugin = await loadPlugin({ data: { ...validSettings, settingsVersion: '2' } });

  assert.equal(plugin.settings.enabled, false);
  assert.match(plugin.getSettingsWriteBlockedReason(), /invalid schema version/);
  assert.throws(
    () => plugin.api.validate({ body: 'blocked' }),
    (error) => error.code === 'settings-read-only',
  );
  await assert.rejects(
    plugin.setLoggingEnabled(true),
    (error) => error.code === 'settings-read-only',
  );
  plugin.onunload();
});

test('malformed root settings are read-only through the real plugin load path', async () => {
  const plugin = await loadPlugin({ data: ['corrupt-root'] });

  assert.equal(plugin.settings.enabled, false);
  assert.match(plugin.getSettingsWriteBlockedReason(), /data is malformed/);
  assert.throws(
    () => plugin.api.validate({ body: 'blocked' }),
    (error) => error.code === 'settings-read-only',
  );
  await assert.rejects(
    plugin.setLoggingEnabled(true),
    (error) => error.code === 'settings-read-only',
  );
  assert.equal(globalThis.__tpsNotices.some((message) => /read-only and delivery is disabled/.test(message)), true);
  plugin.onunload();
});

test('settings read failure exposes only a fail-closed API and redacts the raw storage error', async () => {
  globalThis.__tpsNotices = [];
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args);
  const plugin = new TPSNotifier();
  plugin.loadData = async () => {
    throw new Error('secret filesystem path /private/vault/data.json');
  };
  plugin.saveData = async () => undefined;
  try {
    await plugin.onload();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(plugin.isReadyForUiFeedback(), true);
  assert.ok(plugin.api, 'a diagnostics-capable API remains discoverable');
  assert.match(plugin.getSettingsWriteBlockedReason(), /could not be read/);
  assert.throws(
    () => plugin.api.validate({ body: 'blocked' }),
    (error) => error.code === 'settings-read-only',
  );
  assert.equal(globalThis.__tpsNotices.some((message) => /could not read its settings/.test(message)), true);
  assert.doesNotMatch(JSON.stringify(logged), /secret filesystem|private\/vault|data\.json/);
  plugin.onunload();
});

test('malformed saved fields disable delivery but remain repairable only through explicit Apply', async () => {
  const writes = [];
  const plugin = await loadPlugin({
    data: { ...validSettings, ntfyPriority: 99 },
    saveData: async (snapshot) => { writes.push(snapshot); },
  });

  assert.equal(plugin.settings.enabled, false);
  assert.equal(plugin.settings.ntfyPriority, 3);
  assert.match(plugin.getSettingsWarningReason(), /setting values are malformed/);
  await assert.rejects(
    plugin.setDeliveryEnabled(true),
    (error) => error.code === 'invalid-configuration',
  );
  await assert.rejects(
    plugin.setLoggingEnabled(true),
    (error) => error.code === 'invalid-configuration',
  );
  await assert.rejects(
    plugin.setManualComposerEnabled(false),
    (error) => error.code === 'invalid-configuration',
  );
  assert.equal(writes.length, 0, 'unrelated toggles cannot silently normalize malformed storage');
  await plugin.applyTransportSettings({
    ntfyServer: plugin.settings.ntfyServer,
    ntfyTopic: plugin.settings.ntfyTopic,
    ntfyPriority: 3,
  });
  assert.equal(writes.length, 1);
  await plugin.setDeliveryEnabled(true);
  assert.equal(plugin.settings.enabled, true);
  assert.equal(plugin.getSettingsWarningReason(), '');
  plugin.onunload();
});

test('unload during deferred settings read cannot resurrect commands, handlers, logging, or API', async () => {
  globalThis.__tpsNotices = [];
  let releaseLoad;
  const plugin = new TPSNotifier();
  plugin.loadData = async () => await new Promise((resolve) => { releaseLoad = resolve; });
  plugin.saveData = async () => undefined;

  const loading = plugin.onload();
  await tick();
  plugin.onunload();
  releaseLoad({ ...validSettings, enableLogging: true });

  await assert.rejects(loading, (error) => error.code === 'not-ready');
  assert.equal(plugin.api, undefined);
  assert.equal(plugin.isReadyForUiFeedback(), false);
  assert.equal(plugin.__commands?.length || 0, 0);
  assert.equal(plugin.__protocols?.size || 0, 0);
  assert.equal(globalThis.__tpsNotices.length, 0, 'stale load must not emit startup UI after unload');
});

test('a newer same-instance load supersedes a deferred older load without duplicate registration', async () => {
  globalThis.__tpsNotices = [];
  let releaseFirstLoad;
  let loadCalls = 0;
  const plugin = new TPSNotifier();
  plugin.loadData = async () => {
    loadCalls += 1;
    if (loadCalls === 1) {
      return await new Promise((resolve) => { releaseFirstLoad = resolve; });
    }
    return { ...validSettings };
  };
  plugin.saveData = async () => undefined;

  const olderLoad = plugin.onload();
  await tick();
  await plugin.onload();
  const currentApi = plugin.api;
  releaseFirstLoad({ ...validSettings, enableLogging: true });

  await assert.rejects(olderLoad, (error) => error.code === 'not-ready');
  assert.equal(plugin.api, currentApi);
  assert.equal(plugin.__commands.length, 2);
  assert.equal(plugin.__protocols.size, 2);
  assert.equal(plugin.settings.enableLogging, false, 'stale settings never overwrite the current load');
  plugin.onunload();
});

test('structured API rejects blank bodies and unknown fields while legacy empty-body behavior remains explicit', async () => {
  const requests = [];
  const plugin = await loadPlugin({
    requestUrl: async (request) => {
      requests.push(request);
      return {
        status: 200,
        json: { id: 'legacy_empty', event: 'message', topic: 'private_topic' },
      };
    },
  });

  await assert.rejects(
    plugin.api.send({ body: '   ' }),
    (error) => error.code === 'invalid-payload',
  );
  assert.throws(
    () => plugin.api.validate({ body: 'valid', titel: 'typo' }),
    (error) => error.code === 'invalid-payload',
  );
  assert.throws(
    () => plugin.api.validate(Object.create({ body: 'inherited body' })),
    (error) => error.code === 'invalid-payload',
  );
  await plugin.api.sendNotification('Title only', '');
  assert.equal(requests[0].body, '(empty message)');
  plugin.onunload();
});

test('successful disable blocks sends immediately and installs only after persistence', async () => {
  let releaseSave;
  const plugin = await loadPlugin({
    saveData: async () => new Promise((resolve) => { releaseSave = resolve; }),
  });
  const api = plugin.api;
  const disable = plugin.setDeliveryEnabled(false);
  await tick();

  assert.equal(plugin.settings.enabled, true, 'snapshot remains unchanged while save is pending');
  assert.throws(
    () => api.validate({ body: 'blocked during save' }),
    (error) => error.code === 'delivery-disabled',
  );
  releaseSave();
  await disable;
  assert.equal(plugin.settings.enabled, false);
  assert.throws(
    () => api.validate({ body: 'disabled after commit' }),
    (error) => error.code === 'delivery-disabled',
  );
  plugin.onunload();
});

test('unload rejects queued settings work and prevents post-save state installation', async () => {
  let releaseSave;
  let writes = 0;
  let persisted;
  const plugin = await loadPlugin({
    saveData: async (snapshot) => {
      writes += 1;
      persisted = snapshot;
      await new Promise((resolve) => { releaseSave = resolve; });
    },
  });
  const cachedApi = plugin.api;
  const first = plugin.setLoggingEnabled(true);
  await tick();
  const second = plugin.setManualComposerEnabled(false);
  const secondFailure = assert.rejects(second, (error) => error.code === 'not-ready');
  plugin.onunload();

  assert.throws(() => cachedApi.validate({ body: 'after unload' }), (error) => error.code === 'not-ready');
  releaseSave();
  await first;
  await secondFailure;
  assert.equal(writes, 1);
  assert.equal(persisted.enableLogging, true);
  assert.equal(plugin.settings.enableLogging, false, 'disposed plugin must not install the completed write');

  plugin.loadData = async () => ({ ...persisted });
  plugin.saveData = async () => undefined;
  await plugin.onload();
  assert.equal(plugin.settings.enableLogging, true, 'same-instance reload waits for and then reads the completed write');
  assert.throws(
    () => cachedApi.validate({ body: 'old API remains invalid after reload' }),
    (error) => error.code === 'not-ready',
  );
  assert.equal(plugin.api.validate({ body: 'new API works after reload' }).valid, true);
  plugin.onunload();
});

test('API and settings exposure cannot be replaced or mutated', async () => {
  const plugin = await loadPlugin();
  const api = plugin.api;

  assert.equal(Object.isFrozen(api), true);
  assert.equal(Object.isFrozen(api.capabilities), true);
  assert.equal(Object.isFrozen(plugin.settings), true);
  assert.throws(() => { plugin.api = {}; }, TypeError);
  assert.throws(() => { plugin.settings.enabled = false; }, TypeError);
  assert.equal(plugin.api, api);
  plugin.onunload();
  assert.equal(plugin.api, undefined);
  assert.throws(() => api.validate({ body: 'cached API' }), (error) => error.code === 'not-ready');
});

test('UI lifecycle tokens remain stale after reload while an old network call returns normally', async () => {
  let releaseRequest;
  const plugin = await loadPlugin({
    requestUrl: async () => await new Promise((resolve) => { releaseRequest = resolve; }),
  });
  const oldUiToken = plugin.getUiLifecycleToken();
  const send = plugin.api.send({ body: 'old lifecycle send' });
  await tick();

  plugin.onunload();
  plugin.loadData = async () => ({ ...validSettings });
  await plugin.onload();
  const newUiToken = plugin.getUiLifecycleToken();
  assert.notEqual(newUiToken, oldUiToken);
  assert.equal(plugin.isReadyForUiFeedback(oldUiToken), false);
  assert.equal(plugin.isReadyForUiFeedback(newUiToken), true);

  releaseRequest({
    status: 200,
    json: { id: 'old_lifecycle_id', event: 'message', topic: 'private_topic' },
  });
  assert.equal((await send).outcome, 'accepted');
  plugin.onunload();
});

test('fifth concurrent delivery waits for capacity instead of being dropped', async () => {
  const requests = [];
  const releases = [];
  const plugin = await loadPlugin({
    requestUrl: async (request) => {
      const index = requests.length;
      requests.push(request);
      return await new Promise((resolve) => {
        releases[index] = () => resolve({
          status: 200,
          json: { id: `message_${index}`, event: 'message', topic: 'private_topic' },
        });
      });
    },
  });
  const sends = Array.from({ length: 5 }, (_, index) => plugin.api.send({ body: `body ${index}` }));
  await tick();
  assert.equal(requests.length, 4);

  releases[0]();
  assert.equal((await sends[0]).outcome, 'accepted');
  await tick();
  assert.equal(requests.length, 5);
  for (let index = 1; index < releases.length; index += 1) releases[index]();
  const receipts = await Promise.all(sends);
  assert.equal(receipts.length, 5);
  assert.equal(receipts.every((receipt) => receipt.outcome === 'accepted'), true);
  plugin.onunload();
});

test('disabling immediately rejects every queued not-yet-attempted delivery while active calls finish', async () => {
  const requests = [];
  const releases = [];
  const plugin = await loadPlugin({
    requestUrl: async (request) => {
      const index = requests.length;
      requests.push(request);
      return await new Promise((resolve) => {
        releases[index] = () => resolve({
          status: 200,
          json: { id: `active_${index}`, event: 'message', topic: 'private_topic' },
        });
      });
    },
  });
  const sends = Array.from({ length: 5 }, (_, index) => plugin.api.send({ body: `disable ${index}` }));
  const queuedFailure = assert.rejects(
    sends[4],
    (error) => error.code === 'delivery-invalidated'
      && error.attempted === false
      && error.deliveryState === 'not-attempted',
  );
  await tick();
  assert.equal(requests.length, 4);

  await plugin.setDeliveryEnabled(false);
  await queuedFailure;
  assert.equal(requests.length, 4, 'the queued request never reaches the transport');
  for (const release of releases) release();
  assert.equal((await Promise.all(sends.slice(0, 4))).every((receipt) => receipt.outcome === 'accepted'), true);
  plugin.onunload();
});

test('applying a new target invalidates queued requests prepared for the prior target', async () => {
  const requests = [];
  const releases = [];
  const plugin = await loadPlugin({
    requestUrl: async (request) => {
      const index = requests.length;
      requests.push(request);
      const topic = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
      return await new Promise((resolve) => {
        releases[index] = () => resolve({
          status: 200,
          json: { id: `route_${index}`, event: 'message', topic },
        });
      });
    },
  });
  const sends = Array.from({ length: 5 }, (_, index) => plugin.api.send({ body: `route ${index}` }));
  const queuedFailure = assert.rejects(
    sends[4],
    (error) => error.code === 'delivery-invalidated' && error.attempted === false,
  );
  await tick();

  await plugin.applyTransportSettings({
    ntfyServer: 'https://new-ntfy.example/proxy',
    ntfyTopic: 'new_topic',
    ntfyPriority: 4,
  });
  await queuedFailure;
  assert.equal(requests.length, 4);
  assert.equal(plugin.settings.ntfyTopic, 'new_topic');
  for (const release of releases) release();
  await Promise.all(sends.slice(0, 4));
  plugin.onunload();
});

test('queued file links are rebuilt after rename and rejected before I/O after deletion', async () => {
  const requests = [];
  const releases = [];
  const plugin = await loadPlugin({
    requestUrl: async (request) => {
      const index = requests.length;
      requests.push(request);
      const topic = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
      return await new Promise((resolve) => {
        releases[index] = () => resolve({
          status: 200,
          json: { id: `file_${index}`, event: 'message', topic },
        });
      });
    },
  });
  const activeFiles = new Map();
  plugin.app.vault.getAbstractFileByPath = (path) => activeFiles.get(path) || null;
  const renamedFile = new globalThis.__tpsTFileClass('Inbox/original.md');
  const deletedFile = new globalThis.__tpsTFileClass('Inbox/deleted.md');
  activeFiles.set(renamedFile.path, renamedFile);
  activeFiles.set(deletedFile.path, deletedFile);

  const active = Array.from({ length: 4 }, (_, index) => plugin.api.send({ body: `active file ${index}` }));
  const renamedSend = plugin.api.send({ body: 'renamed link', file: renamedFile });
  const deletedSend = plugin.api.send({ body: 'deleted link', file: deletedFile });
  const deletedFailure = assert.rejects(
    deletedSend,
    (error) => error.code === 'invalid-payload' && error.attempted === false,
  );
  await tick();
  assert.equal(requests.length, 4);

  activeFiles.delete(renamedFile.path);
  renamedFile.path = 'Inbox/renamed.md';
  activeFiles.set(renamedFile.path, renamedFile);
  activeFiles.delete(deletedFile.path);

  releases[0]();
  await active[0];
  await tick();
  assert.equal(requests.length, 5);
  assert.match(requests[4].headers.Click, /file=Inbox%2Frenamed\.md$/);

  releases[1]();
  await active[1];
  await deletedFailure;
  assert.equal(requests.length, 5, 'deleted file never reaches requestUrl');
  releases[2]();
  releases[3]();
  releases[4]();
  await Promise.all([...active, renamedSend]);
  plugin.onunload();
});

test('queued file-link rebuild normalizes unexpected vault lookup failures before network I/O', async () => {
  const requests = [];
  const releases = [];
  const plugin = await loadPlugin({
    requestUrl: async (request) => {
      const index = requests.length;
      requests.push(request);
      const topic = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
      return await new Promise((resolve) => {
        releases[index] = () => resolve({
          status: 200,
          json: { id: `lookup_${index}`, event: 'message', topic },
        });
      });
    },
  });
  const file = new globalThis.__tpsTFileClass('Inbox/private-path.md');
  plugin.app.vault.getAbstractFileByPath = () => file;

  const active = Array.from({ length: 4 }, (_, index) => plugin.api.send({ body: `active lookup ${index}` }));
  const queued = plugin.api.send({ body: 'queued lookup', file });
  await tick();
  assert.equal(requests.length, 4);
  plugin.app.vault.getAbstractFileByPath = () => {
    throw new Error('raw vault failure at Inbox/private-path.md');
  };

  releases[0]();
  await active[0];
  await assert.rejects(
    queued,
    (error) => error.code === 'internal-error'
      && error.attempted === false
      && !error.message.includes('private-path')
      && !error.message.includes('raw vault failure'),
  );
  assert.equal(requests.length, 4, 'unexpected local lookup failure never reaches requestUrl');
  releases[1]();
  releases[2]();
  releases[3]();
  await Promise.all(active);
  plugin.onunload();
});

test('legacy wrappers retain argument order but use structured delivery semantics', async () => {
  const requests = [];
  const plugin = await loadPlugin({
    requestUrl: async (request) => {
      requests.push(request);
      return {
        status: 200,
        json: { id: 'legacy_id', event: 'message', topic: 'private_topic' },
      };
    },
  });

  assert.equal(await plugin.api.sendNotification('Legacy title', 'Legacy body'), undefined);
  assert.equal(requests[0].body, 'Legacy body');
  assert.equal(requests[0].headers.Title, 'Legacy title');
  assert.equal(await plugin.api.sendMessage('Message body', undefined, 'Message title'), undefined);
  assert.equal(requests[1].body, 'Message body');
  assert.equal(requests[1].headers.Title, 'Message title');

  globalThis.__tpsRequestUrl = async () => ({ status: 200, json: {} });
  await assert.rejects(
    plugin.api.sendNotification('Unknown title', 'Unknown body'),
    (error) => error.code === 'delivery-unconfirmed'
      && error.deliveryState === 'unconfirmed'
      && error.duplicateSafeToRetry === false,
  );
  globalThis.__tpsRequestUrl = async () => ({
    status: 401,
    json: { code: 40101, http: 401, error: 'unauthorized' },
  });
  await assert.rejects(
    plugin.api.send({ body: 'Rejected body' }),
    (error) => error.code === 'delivery-rejected'
      && error.deliveryState === 'rejected'
      && error.duplicateSafeToRetry === true,
  );
  plugin.onunload();
});
