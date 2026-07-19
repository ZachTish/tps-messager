import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let poolModule;

async function loadPoolModule() {
  if (poolModule) return poolModule;
  const outdir = await mkdtemp(join(tmpdir(), 'tps-notifier-pool-'));
  const outfile = join(outdir, 'closable-task-pool.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/closable-task-pool.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  poolModule = await import(pathToFileURL(outfile).href);
  test.after(async () => {
    await rm(outdir, { recursive: true, force: true });
  });
  return poolModule;
}

test('queues beyond the active concurrency limit instead of dropping work', async () => {
  const { ClosableTaskPool } = await loadPoolModule();
  const pool = new ClosableTaskPool(4, 10);
  const releases = [];
  const starts = [];
  const work = Array.from({ length: 6 }, (_, index) => pool.run(async () => {
    starts.push(index);
    await new Promise((resolve) => { releases[index] = resolve; });
    return index;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, 1, 2, 3]);
  assert.equal(pool.activeCount, 4);
  assert.equal(pool.pendingCount, 2);

  releases[0]();
  assert.equal(await work[0], 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, 1, 2, 3, 4]);
  releases[1]();
  releases[2]();
  releases[3]();
  releases[4]();
  await new Promise((resolve) => setImmediate(resolve));
  releases[5]();
  assert.deepEqual(await Promise.all(work), [0, 1, 2, 3, 4, 5]);
});

test('close rejects queued work but lets already-started work report its result', async () => {
  const { ClosableTaskPool } = await loadPoolModule();
  const pool = new ClosableTaskPool(1, 2);
  const closed = new Error('plugin unloaded');
  let release;
  const active = pool.run(async () => {
    await new Promise((resolve) => { release = resolve; });
    return 'accepted';
  });
  const queued = pool.run(async () => 'must-not-run');
  pool.close(closed);
  release();

  assert.equal(await active, 'accepted');
  await assert.rejects(queued, (error) => error === closed);
  await assert.rejects(pool.run(async () => 'late'), (error) => error === closed);
});

test('bounds the pending queue with a distinct capacity error', async () => {
  const { ClosableTaskPool, TaskPoolCapacityError } = await loadPoolModule();
  const pool = new ClosableTaskPool(1, 1);
  let release;
  const active = pool.run(async () => {
    await new Promise((resolve) => { release = resolve; });
  });
  const queued = pool.run(async () => undefined);
  await assert.rejects(pool.run(async () => undefined), (error) => error instanceof TaskPoolCapacityError);
  pool.close(new Error('done'));
  release();
  await active;
  await assert.rejects(queued);
});

test('can invalidate pending work without closing the pool or disturbing active work', async () => {
  const { ClosableTaskPool } = await loadPoolModule();
  const pool = new ClosableTaskPool(1, 2);
  const invalidated = new Error('transport changed');
  let release;
  const active = pool.run(async () => {
    await new Promise((resolve) => { release = resolve; });
    return 'active-result';
  });
  const stale = pool.run(async () => 'stale');

  pool.cancelPending(invalidated);
  await assert.rejects(stale, (error) => error === invalidated);
  const fresh = pool.run(async () => 'fresh');
  release();
  assert.equal(await active, 'active-result');
  assert.equal(await fresh, 'fresh');
});
