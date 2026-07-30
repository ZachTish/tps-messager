import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/notifier-safety.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const safety = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

async function importNotifierPlugin() {
  const pluginBundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [{
      name: 'obsidian-stub',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^obsidian$/ }, () => ({
          path: 'obsidian-stub',
          namespace: 'stub',
        }));
        esbuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          loader: 'js',
          contents: `
            export class App {}
            export class Modal {}
            export class Notice {}
            export class Plugin {}
            export class PluginSettingTab {}
            export class Setting {}
            export class TFile {}
            export async function requestUrl(request) {
              return globalThis.__tpsNotifierRequestUrl(request);
            }
          `,
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(pluginBundle.outputFiles[0].text).toString('base64')}`);
}

async function runDeliveryScenario(NotifierPlugin, name, result) {
  const plugin = Object.create(NotifierPlugin.prototype);
  plugin.settings = {
    enabled: true,
    ntfyServer: 'https://user:password@ntfy.example',
    ntfyTopic: `private-${name}`,
    ntfyPriority: 3,
  };
  const errorCalls = [];
  const originalConsoleError = console.error;
  let sentRequest;
  let thrown;
  globalThis.__tpsNotifierRequestUrl = async (request) => {
    sentRequest = request;
    if (result instanceof Error) throw result;
    if (result.status >= 400 && request.throw !== false) {
      throw new Error(`requestUrl rejected HTTP ${result.status}`);
    }
    return result;
  };
  console.error = (...args) => errorCalls.push(args);

  try {
    await plugin.sendMessage('Synthetic notification');
  } catch (error) {
    thrown = error;
  } finally {
    console.error = originalConsoleError;
    delete globalThis.__tpsNotifierRequestUrl;
  }

  return {
    throwOption: sentRequest?.throw,
    events: errorCalls
      .map(([message]) => String(message).match(/send:[a-z-]+/)?.[0])
      .filter(Boolean),
    errorMessage: thrown?.message ?? null,
    diagnostics: JSON.stringify(errorCalls),
  };
}

test('protocol paths preserve already-decoded percent characters', () => {
  assert.equal(safety.normalizeNotifierProtocolPath('Inbox/100% Complete.md'), 'Inbox/100% Complete.md');
  assert.equal(safety.normalizeNotifierProtocolPath('Notes/Literal %20 token.md'), 'Notes/Literal %20 token.md');
  assert.equal(safety.normalizeNotifierProtocolPath('Folder\\Note.md'), 'Folder/Note.md');
  assert.equal(safety.normalizeNotifierProtocolPath('../Secret.md'), null);
  assert.equal(safety.normalizeNotifierProtocolPath('/Absolute.md'), null);
  assert.doesNotMatch(mainSource, /decodeURIComponent\(params\.(?:vault|file)\)/);
});

test('notification diagnostics omit topic, credentials, and full target URLs', () => {
  const target = 'https://user:password@ntfy.example/private_alerts';
  assert.deepEqual(safety.summarizeNotifierTarget(target), {
    serverHost: 'ntfy.example',
    secure: true,
    hasTopic: true,
  });

  const safeError = safety.sanitizeNotifierDeliveryError(
    new Error(`POST ${target} failed for private_alerts`),
    target,
  );
  assert.doesNotMatch(safeError.message, /private_alerts|user|password/);
  assert.doesNotMatch(safeError.stack || '', /private_alerts|user|password/);
  assert.match(safeError.message, /https:\/\/ntfy\.example\/\[redacted\]/);
  assert.doesNotMatch(mainSource, /url:\s*request\.url/);
  assert.doesNotMatch(mainSource, /title:\s*title\s*\|\|/);
});

test('delivery classifies each HTTP or transport failure exactly once', async () => {
  const { default: NotifierPlugin } = await importNotifierPlugin();
  const success = await runDeliveryScenario(NotifierPlugin, 'success', {
    status: 204,
    text: '',
  });
  const redirect = await runDeliveryScenario(NotifierPlugin, 'redirect', {
    status: 307,
    text: 'temporary redirect',
  });
  const unavailable = await runDeliveryScenario(NotifierPlugin, 'unavailable', {
    status: 503,
    text: 'service unavailable',
  });
  const network = await runDeliveryScenario(
    NotifierPlugin,
    'network',
    new Error('network unavailable'),
  );

  assert.deepEqual(
    [success, redirect, unavailable, network].map(({ throwOption, events, errorMessage }) => ({
      throwOption,
      events,
      errorMessage,
    })),
    [
      { throwOption: false, events: [], errorMessage: null },
      {
        throwOption: false,
        events: ['send:http-failed'],
        errorMessage: 'ntfy returned 307: temporary redirect',
      },
      {
        throwOption: false,
        events: ['send:http-failed'],
        errorMessage: 'ntfy returned 503: service unavailable',
      },
      {
        throwOption: false,
        events: ['send:failed'],
        errorMessage: 'network unavailable',
      },
    ],
  );

  for (const scenario of [redirect, unavailable, network]) {
    assert.doesNotMatch(scenario.diagnostics, /private-|user|password/);
  }
});
