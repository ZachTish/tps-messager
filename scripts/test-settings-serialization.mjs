import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let queueModule;

async function loadQueueModule() {
  if (queueModule) return queueModule;
  const outdir = await mkdtemp(join(tmpdir(), 'tps-notifier-queue-'));
  const outfile = join(outdir, 'serial-task-queue.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/serial-task-queue.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  queueModule = await import(pathToFileURL(outfile).href);
  test.after(async () => {
    await rm(outdir, { recursive: true, force: true });
  });
  return queueModule;
}

test('each queued settings caller waits for its own transaction', async () => {
  const { RecoverableSerialTaskQueue } = await loadQueueModule();
  const queue = new RecoverableSerialTaskQueue();
  const events = [];
  let releaseFirst;
  let releaseSecond;

  const first = queue.run(async () => {
    events.push('first:start');
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push('first:done');
    return 'first-result';
  });
  const second = queue.run(async () => {
    events.push('second:start');
    await new Promise((resolve) => { releaseSecond = resolve; });
    events.push('second:done');
    return 'second-result';
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  assert.equal(await first, 'first-result');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start', 'first:done', 'second:start']);

  let secondSettled = false;
  void second.finally(() => { secondSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  releaseSecond();
  assert.equal(await second, 'second-result');
  assert.deepEqual(events, ['first:start', 'first:done', 'second:start', 'second:done']);
});

test('a caller receives its own failure and later transactions still run', async () => {
  const { RecoverableSerialTaskQueue } = await loadQueueModule();
  const queue = new RecoverableSerialTaskQueue();
  const ownFailure = new Error('second save failed');
  const events = [];

  const first = queue.run(async () => {
    events.push('first');
    return 1;
  });
  const second = queue.run(async () => {
    events.push('second');
    throw ownFailure;
  });
  const third = queue.run(async () => {
    events.push('third');
    return 3;
  });

  assert.equal(await first, 1);
  await assert.rejects(second, (error) => error === ownFailure);
  assert.equal(await third, 3);
  assert.deepEqual(events, ['first', 'second', 'third']);
});

test('closing rejects work that has not started and waits for the active task', async () => {
  const { RecoverableSerialTaskQueue } = await loadQueueModule();
  const queue = new RecoverableSerialTaskQueue();
  const closed = new Error('plugin disposed');
  let releaseFirst;
  let secondStarted = false;
  const first = queue.run(async () => {
    await new Promise((resolve) => { releaseFirst = resolve; });
    return 'persisted';
  });
  const second = queue.run(async () => {
    secondStarted = true;
    return 'must-not-run';
  });

  await new Promise((resolve) => setImmediate(resolve));
  queue.close(closed);
  await assert.rejects(second, (error) => error === closed);
  assert.equal(secondStarted, false);

  let idleSettled = false;
  void queue.whenIdle().then(() => { idleSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idleSettled, false, 'active work still owns queue idleness');
  releaseFirst();
  assert.equal(await first, 'persisted');
  await queue.whenIdle();
  assert.equal(secondStarted, false);
  await assert.rejects(queue.run(async () => 'late'), (error) => error === closed);
});

test('timed-out idle waits remove their resolver while active work remains stuck', async () => {
  const { RecoverableSerialTaskQueue } = await loadQueueModule();
  const queue = new RecoverableSerialTaskQueue();
  let release;
  const active = queue.run(async () => {
    await new Promise((resolve) => { release = resolve; });
  });
  await new Promise((resolve) => setImmediate(resolve));

  for (let index = 0; index < 3; index += 1) {
    const timeout = new Error(`idle timeout ${index}`);
    await assert.rejects(
      queue.whenIdle({ timeoutMs: 1, timeoutReason: timeout }),
      (error) => error === timeout,
    );
    assert.equal(queue.idleWaiters.length, 0, 'expired idle waiters must not be retained');
  }

  release();
  await active;
  await queue.whenIdle();
});
