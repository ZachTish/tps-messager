import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let deliveryModule;

async function loadDeliveryModule() {
  if (deliveryModule) return deliveryModule;
  const outdir = await mkdtemp(join(tmpdir(), 'tps-notifier-delivery-'));
  const outfile = join(outdir, 'notifier-delivery.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/notifier-delivery.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  deliveryModule = await import(pathToFileURL(outfile).href);
  test.after(async () => {
    await rm(outdir, { recursive: true, force: true });
  });
  return deliveryModule;
}

const request = Object.freeze({
  url: 'https://ntfy.example/private_topic',
  method: 'POST',
  headers: Object.freeze({ Priority: '3' }),
  body: 'private body',
  throw: false,
});

test('returns a frozen accepted receipt only when ntfy supplies a valid message id', async () => {
  const { executeNotifierDelivery } = await loadDeliveryModule();
  let calls = 0;
  const receipt = await executeNotifierDelivery(request, async (received) => {
    calls += 1;
    assert.equal(received, request);
    return {
      status: 200,
      json: { id: 'AbC_123-x', event: 'message', topic: 'private_topic' },
    };
  });

  assert.deepEqual(receipt, {
    outcome: 'accepted',
    httpStatus: 200,
    providerMessageId: 'AbC_123-x',
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(calls, 1);
});

test('classifies transport rejection as attempted but unconfirmed without leaking the cause', async () => {
  const { executeNotifierDelivery } = await loadDeliveryModule();
  await assert.rejects(
    executeNotifierDelivery(request, async () => {
      throw new Error('socket failed while sending private body to private_topic');
    }),
    (error) => {
      assert.equal(error.code, 'delivery-unconfirmed');
      assert.equal(error.attempted, true);
      assert.equal(error.deliveryState, 'unconfirmed');
      assert.equal(error.httpStatus, undefined);
      assert.doesNotMatch(error.message, /private body|private_topic|socket/i);
      assert.match(error.message, /avoid a duplicate/i);
      return true;
    },
  );
});

test('does not inspect or propagate raw provider response text', async () => {
  const { executeNotifierDelivery } = await loadDeliveryModule();
  let textReads = 0;
  const response = {
    status: 503,
    json: { error: 'private body' },
    get text() {
      textReads += 1;
      return 'private body and private_topic';
    },
  };

  await assert.rejects(
    executeNotifierDelivery(request, async () => response),
    (error) => {
      assert.equal(error.code, 'delivery-unconfirmed');
      assert.equal(error.httpStatus, 503);
      assert.doesNotMatch(error.message, /private body|private_topic/);
      return true;
    },
  );
  assert.equal(textReads, 0);
});

test('treats success without a trustworthy provider id as unconfirmed', async () => {
  const { executeNotifierDelivery } = await loadDeliveryModule();
  const responses = [
    { status: 204 },
    { status: 200, json: {} },
    { status: 200, json: { id: 'contains spaces', event: 'message', topic: 'private_topic' } },
    { status: 200, json: { id: 'a'.repeat(129), event: 'message', topic: 'private_topic' } },
    { status: 200, json: { id: 'valid_id', event: 'error', topic: 'private_topic' } },
    { status: 200, json: { id: 'valid_id', event: 'message', topic: 'wrong_topic' } },
  ];

  for (const response of responses) {
    await assert.rejects(
      executeNotifierDelivery(request, async () => response),
      (error) => error.code === 'delivery-unconfirmed'
        && error.attempted === true
        && error.httpStatus === response.status,
    );
  }
});

test('trusts only structured ntfy client rejections and treats every ambiguous status as unconfirmed', async () => {
  const { executeNotifierDelivery } = await loadDeliveryModule();

  for (const status of [400, 401, 403, 404, 413, 429]) {
    await assert.rejects(
      executeNotifierDelivery(request, async () => ({
        status,
        json: { code: status * 100 + 1, http: status, error: 'provider rejection' },
      })),
      (error) => error.code === 'delivery-rejected'
        && error.deliveryState === 'rejected'
        && error.attempted === true
        && error.duplicateSafeToRetry === true
        && error.httpStatus === status,
    );
  }

  for (const status of [301, 400, 401, 403, 404, 408, 413, 429, 499, 500, 503]) {
    await assert.rejects(
      executeNotifierDelivery(request, async () => ({ status })),
      (error) => error.code === 'delivery-unconfirmed'
        && error.deliveryState === 'unconfirmed'
        && error.duplicateSafeToRetry === false
      && error.httpStatus === status,
    );
  }

  for (const json of [
    { code: 40101, http: 403, error: 'mismatch' },
    { code: 401, http: 401, error: 'wrong code family' },
    { code: 40101, http: 401 },
    { code: 40099, http: 400, error: 'unknown future code' },
    { code: 49901, http: 499, error: 'proxy timeout' },
  ]) {
    await assert.rejects(
      executeNotifierDelivery(request, async () => ({ status: json.http, json })),
      (error) => error.code === 'delivery-unconfirmed' && error.duplicateSafeToRetry === false,
    );
  }
});

test('treats a throwing response JSON accessor as unconfirmed', async () => {
  const { executeNotifierDelivery } = await loadDeliveryModule();
  const response = {
    status: 200,
    get json() {
      throw new Error('raw private response');
    },
  };
  await assert.rejects(
    executeNotifierDelivery(request, async () => response),
    (error) => error.code === 'delivery-unconfirmed' && error.httpStatus === 200,
  );
});
