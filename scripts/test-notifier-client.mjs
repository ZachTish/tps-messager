import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let clientModule;

async function loadClientModule() {
  if (clientModule) return clientModule;
  const outdir = await mkdtemp(join(tmpdir(), 'tps-notifier-client-'));
  const outfile = join(outdir, 'notifier-client.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/tps-notifier-client.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  clientModule = await import(pathToFileURL(outfile).href);
  test.after(async () => {
    await rm(outdir, { recursive: true, force: true });
  });
  return clientModule;
}

class FakeWorkspace {
  listeners = new Map();

  on(name, callback) {
    const ref = { name, callback };
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(ref);
    this.listeners.set(name, listeners);
    return ref;
  }

  offref(ref) {
    this.listeners.get(ref.name)?.delete(ref);
  }

  trigger(name, ...args) {
    for (const ref of Array.from(this.listeners.get(name) || [])) ref.callback(...args);
  }
}

function createV2Api(send) {
  return Object.freeze({
    apiVersion: 2,
    capabilities: Object.freeze({
      structuredReceipts: true,
      redactedDiagnostics: true,
      stableSequenceIds: false,
    }),
    send,
    validate: () => ({
      valid: true,
      serverHost: 'redacted.example',
      secure: true,
      priority: 3,
      hasClick: false,
      bodyBytes: 1,
    }),
  });
}

function createDescriptor(api) {
  return Object.freeze({
    protocolVersion: 1,
    providerPluginId: 'tps-messager',
    api,
  });
}

async function createClient({ legacyPlugin, clientOptions } = {}) {
  const { TPSNotifierClient } = await loadClientModule();
  const workspace = new FakeWorkspace();
  const refs = [];
  const app = {
    workspace,
    plugins: {
      getPlugin: (id) => id === 'tps-messager' ? legacyPlugin : undefined,
    },
  };
  const client = new TPSNotifierClient(app, 'test-consumer', clientOptions);
  client.start((ref) => refs.push(ref));
  return { client, workspace, refs };
}

test('request handshake resolves a provider that loaded before the consumer', async () => {
  const { TPSNotifierClient } = await loadClientModule();
  const workspace = new FakeWorkspace();
  const api = createV2Api(async (request) => ({
    outcome: 'accepted',
    httpStatus: 200,
    providerMessageId: `receipt:${request.body}`,
  }));
  const descriptor = createDescriptor(api);
  workspace.on('tps:notifier-api-request', (request) => request.accept(descriptor));
  const client = new TPSNotifierClient({ workspace }, 'late-consumer');
  client.start(() => undefined);

  const result = await client.send({ body: 'handshake' });
  assert.deepEqual(result, {
    state: 'accepted',
    transport: 'notifier-v2',
    evidence: 'structured-receipt',
    attempted: true,
    httpStatus: 200,
    providerMessageId: 'receipt:handshake',
  });
});

test('available and unavailable events use exact provider identity', async () => {
  const { client, workspace } = await createClient();
  let provider = 'A';
  const descriptorA = createDescriptor(createV2Api(async () => ({
    outcome: 'accepted', httpStatus: 200, providerMessageId: 'A',
  })));
  const descriptorB = createDescriptor(createV2Api(async () => ({
    outcome: 'accepted', httpStatus: 200, providerMessageId: provider,
  })));

  workspace.trigger('tps:notifier-api-available', descriptorA);
  workspace.trigger('tps:notifier-api-available', descriptorB);
  workspace.trigger('tps:notifier-api-unavailable', descriptorA);
  provider = 'B';
  assert.equal((await client.send({ body: 'current' })).providerMessageId, 'B');

  workspace.trigger('tps:notifier-api-unavailable', descriptorB);
  assert.deepEqual(await client.send({ body: 'none' }), {
    state: 'not-attempted',
    transport: 'unavailable',
    evidence: 'service-unavailable',
    attempted: false,
  });
});

test('malformed and spoofed descriptors are ignored', async () => {
  const { client, workspace } = await createClient();
  assert.doesNotThrow(() => workspace.trigger('tps:notifier-api-available', new Proxy({}, {
    get: () => { throw new Error('hostile descriptor getter'); },
  })));
  workspace.trigger('tps:notifier-api-available', { providerPluginId: 'other', api: createV2Api(async () => ({})) });
  workspace.trigger('tps:notifier-api-available', {
    protocolVersion: 1,
    providerPluginId: 'tps-messager',
    api: { apiVersion: 2, capabilities: {}, send: async () => ({}) },
  });
  assert.equal((await client.send({ body: 'ignored' })).state, 'not-attempted');
});

test('throwing request listeners cannot fail discovery or prevent the isolated v1 route', async () => {
  const { TPSNotifierClient } = await loadClientModule();
  const workspace = new FakeWorkspace();
  workspace.on('tps:notifier-api-request', () => {
    throw new Error('hostile request listener');
  });
  let legacyCalls = 0;
  const client = new TPSNotifierClient({
    workspace,
    plugins: {
      getPlugin: () => ({ api: { sendNotification: async () => { legacyCalls += 1; } } }),
    },
  }, 'throw-safe-consumer');
  assert.doesNotThrow(() => client.start(() => undefined));
  assert.equal((await client.send({ body: 'fallback remains available' })).state, 'legacy-accepted');
  assert.equal(legacyCalls, 1);
});

test('descriptor and API snapshots consume shape-shifting getters exactly once', async () => {
  const { client, workspace } = await createClient();
  const reads = new Map();
  const once = (scope, values) => new Proxy({}, {
    get(_target, key) {
      if (!(key in values)) return undefined;
      const id = `${scope}.${String(key)}`;
      const count = (reads.get(id) || 0) + 1;
      reads.set(id, count);
      if (count > 1) throw new Error(`re-read ${id}`);
      return values[key];
    },
  });
  const capabilities = once('capabilities', {
    structuredReceipts: true,
    redactedDiagnostics: true,
    stableSequenceIds: false,
  });
  const api = once('api', {
    apiVersion: 2,
    capabilities,
    send: async () => ({ outcome: 'accepted', httpStatus: 202, providerMessageId: 'snapshot-api' }),
    validate: () => ({ valid: true }),
  });
  const descriptor = once('descriptor', {
    protocolVersion: 1,
    providerPluginId: 'tps-messager',
    api,
  });

  assert.doesNotThrow(() => workspace.trigger('tps:notifier-api-available', descriptor));
  assert.equal((await client.send({ body: 'one read' })).providerMessageId, 'snapshot-api');
  for (const count of reads.values()) assert.equal(count, 1);
});

test('receipt snapshots cannot change after structural validation', async () => {
  const { client, workspace } = await createClient();
  const reads = new Map();
  const receipt = new Proxy({}, {
    get(_target, key) {
      if (!['outcome', 'httpStatus', 'providerMessageId'].includes(String(key))) return undefined;
      const count = (reads.get(key) || 0) + 1;
      reads.set(key, count);
      if (count > 1) throw new Error(`receipt ${String(key)} re-read`);
      return {
        outcome: 'accepted',
        httpStatus: 202,
        providerMessageId: 'snapshot-receipt',
      }[key];
    },
  });
  workspace.trigger('tps:notifier-api-available', createDescriptor(createV2Api(async () => receipt)));
  assert.deepEqual(await client.send({ body: 'receipt' }), {
    state: 'accepted',
    transport: 'notifier-v2',
    evidence: 'structured-receipt',
    attempted: true,
    httpStatus: 202,
    providerMessageId: 'snapshot-receipt',
  });
  for (const count of reads.values()) assert.equal(count, 1);
});

test('error snapshots cannot change after structural validation', async () => {
  const { client, workspace } = await createClient();
  const values = {
    code: 'delivery-rejected',
    attempted: true,
    deliveryState: 'rejected',
    duplicateSafeToRetry: true,
    httpStatus: 429,
  };
  const reads = new Map();
  const error = new Proxy({}, {
    get(_target, key) {
      if (!(key in values)) return undefined;
      const count = (reads.get(key) || 0) + 1;
      reads.set(key, count);
      if (count > 1) throw new Error(`error ${String(key)} re-read`);
      return values[key];
    },
  });
  workspace.trigger('tps:notifier-api-available', createDescriptor(createV2Api(async () => { throw error; })));
  assert.deepEqual(await client.send({ body: 'error' }), {
    state: 'rejected',
    transport: 'notifier-v2',
    evidence: 'structured-rejection',
    attempted: true,
    code: 'delivery-rejected',
    httpStatus: 429,
  });
  for (const count of reads.values()) assert.equal(count, 1);
});

test('v2 structurally maps every delivery state without leaking arbitrary failures', async () => {
  const cases = [
    {
      error: {
        code: 'delivery-disabled', attempted: false, deliveryState: 'not-attempted', duplicateSafeToRetry: true,
      },
      expected: ['not-attempted', 'structured-not-attempted', false],
    },
    {
      error: {
        code: 'delivery-rejected', attempted: true, deliveryState: 'rejected', duplicateSafeToRetry: true, httpStatus: 401,
      },
      expected: ['rejected', 'structured-rejection', true],
    },
    {
      error: {
        code: 'delivery-unconfirmed', attempted: true, deliveryState: 'unconfirmed', duplicateSafeToRetry: false, httpStatus: 503,
      },
      expected: ['unknown', 'unconfirmed', true],
    },
    {
      error: new Error('private provider detail'),
      expected: ['unknown', 'unclassified-v2-failure', 'unknown'],
    },
  ];

  for (const { error, expected } of cases) {
    const { client, workspace } = await createClient();
    workspace.trigger('tps:notifier-api-available', createDescriptor(createV2Api(async () => { throw error; })));
    const result = await client.send({ body: 'classified' });
    assert.deepEqual([result.state, result.evidence, result.attempted], expected);
    assert.equal(JSON.stringify(result).includes('private provider detail'), false);
  }
});

test('malformed v2 success is unknown and never falls back to legacy', async () => {
  let legacyCalls = 0;
  const legacyPlugin = {
    api: {
      sendNotification: async () => { legacyCalls += 1; },
    },
  };
  const { client, workspace } = await createClient({ legacyPlugin });
  workspace.trigger('tps:notifier-api-available', createDescriptor(createV2Api(async () => ({
    outcome: 'accepted', httpStatus: 200, providerMessageId: '',
  }))));
  const result = await client.send({ body: 'one route only' });
  assert.equal(result.state, 'unknown');
  assert.equal(result.evidence, 'malformed-v2-result');
  assert.equal(legacyCalls, 0);
});

test('stale v2 not-ready is cleared for later occurrences without retrying the current call', async () => {
  let v2Calls = 0;
  let legacyCalls = 0;
  const { client, workspace } = await createClient({
    legacyPlugin: {
      api: { sendNotification: async () => { legacyCalls += 1; } },
    },
  });
  workspace.trigger('tps:notifier-api-available', createDescriptor(createV2Api(async () => {
    v2Calls += 1;
    throw {
      code: 'not-ready',
      attempted: false,
      deliveryState: 'not-attempted',
      duplicateSafeToRetry: true,
    };
  })));

  assert.equal((await client.send({ body: 'stale current occurrence' })).state, 'not-attempted');
  assert.equal(v2Calls, 1);
  assert.equal(legacyCalls, 0, 'the same occurrence never falls through after a v2 invocation');
  assert.equal((await client.send({ body: 'later occurrence' })).state, 'legacy-accepted');
  assert.equal(v2Calls, 1);
  assert.equal(legacyCalls, 1);
});

test('legacy compatibility invokes one plugin.api method and classifies rejection as unknown', async () => {
  let notificationCalls = 0;
  let messageCalls = 0;
  const legacyPlugin = {
    api: {
      sendNotification: async () => {
        notificationCalls += 1;
        if (notificationCalls === 2) throw new Error('ambiguous old failure');
      },
      sendMessage: async () => { messageCalls += 1; },
    },
  };
  const { client } = await createClient({ legacyPlugin });
  assert.equal((await client.send({ title: 'old', body: 'first' })).state, 'legacy-accepted');
  const failure = await client.send({ title: 'old', body: 'second' });
  assert.equal(failure.state, 'unknown');
  assert.equal(failure.evidence, 'legacy-rejection');
  assert.equal(notificationCalls, 2);
  assert.equal(messageCalls, 0, 'a rejection never falls through to the alternate legacy method');
});

test('plugin-instance methods are not an accepted legacy fallback', async () => {
  let calls = 0;
  const { client } = await createClient({
    legacyPlugin: { sendNotification: async () => { calls += 1; } },
  });
  assert.equal((await client.send({ body: 'no arbitrary instance' })).state, 'not-attempted');
  assert.equal(calls, 0);
});

test('delayed accepts and old event callbacks cannot repopulate a restarted client', async () => {
  const { TPSNotifierClient } = await loadClientModule();
  const workspace = new FakeWorkspace();
  const accepts = [];
  workspace.on('tps:notifier-api-request', (request) => accepts.push(request.accept));
  const refs = [];
  const client = new TPSNotifierClient({ workspace }, 'epoch-consumer');
  client.start((ref) => refs.push(ref));
  const oldAvailableRef = refs.find((ref) => ref.name === 'tps:notifier-api-available');
  client.dispose();
  client.start((ref) => refs.push(ref));

  const oldDescriptor = createDescriptor(createV2Api(async () => ({
    outcome: 'accepted', httpStatus: 200, providerMessageId: 'old',
  })));
  const newDescriptor = createDescriptor(createV2Api(async () => ({
    outcome: 'accepted', httpStatus: 200, providerMessageId: 'new',
  })));
  accepts[1](newDescriptor);
  accepts[0](oldDescriptor);
  oldAvailableRef.callback(oldDescriptor);

  assert.equal((await client.send({ body: 'current epoch' })).providerMessageId, 'new');
});

test('a never-settling v2 call reaches the consumer deadline without v1 fallback', async () => {
  const {
    TPS_NOTIFIER_DEFAULT_PROVIDER_DEADLINE_MS,
    TPS_NOTIFIER_MAX_PROVIDER_DEADLINE_MS,
  } = await loadClientModule();
  assert.equal(TPS_NOTIFIER_DEFAULT_PROVIDER_DEADLINE_MS, 60_000);
  assert.equal(TPS_NOTIFIER_MAX_PROVIDER_DEADLINE_MS, 5 * 60_000);
  let legacyCalls = 0;
  const { client, workspace } = await createClient({
    clientOptions: { providerDeadlineMs: 10 },
    legacyPlugin: {
      api: { sendNotification: async () => { legacyCalls += 1; } },
    },
  });
  workspace.trigger('tps:notifier-api-available', createDescriptor(createV2Api(async () => await new Promise(() => {}))));
  assert.deepEqual(await client.send({ body: 'bounded v2' }), {
    state: 'unknown',
    transport: 'notifier-v2',
    evidence: 'consumer-timeout',
    attempted: 'unknown',
  });
  assert.equal(legacyCalls, 0);
});

test('a never-settling v1 call reaches the consumer deadline', async () => {
  const { client } = await createClient({
    clientOptions: { providerDeadlineMs: 10 },
    legacyPlugin: {
      api: { sendNotification: async () => await new Promise(() => {}) },
    },
  });
  assert.deepEqual(await client.send({ body: 'bounded v1' }), {
    state: 'unknown',
    transport: 'notifier-v1',
    evidence: 'consumer-timeout',
    attempted: 'unknown',
  });
});

test('disposed clients fail closed without discovery or delivery', async () => {
  let calls = 0;
  const { client, workspace } = await createClient();
  workspace.on('tps:notifier-api-request', (request) => request.accept(createDescriptor(createV2Api(async () => {
    calls += 1;
    return { outcome: 'accepted', httpStatus: 200, providerMessageId: 'late' };
  }))));
  client.dispose();
  const result = await client.send({ body: 'disposed' });
  assert.equal(result.state, 'not-attempted');
  assert.equal(result.evidence, 'interrupted');
  assert.equal(calls, 0);
});
