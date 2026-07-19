import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/tps-contracts.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

function hasExportedValue(key, value) {
  const pattern = new RegExp(`${key}:\\s*["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`);
  return pattern.test(source);
}

test('shared TPS contract exports stable namespaced events', () => {
  assert.equal(hasExportedValue('CONTROLLER_SETTINGS_CHANGED', 'tps:controller-settings-changed'), true);
  assert.equal(hasExportedValue('CALENDAR_SYNC_COMPLETED', 'tps:calendar-sync-completed'), true);
  assert.equal(hasExportedValue('FILES_UPDATED', 'tps:files-updated'), true);
  assert.equal(hasExportedValue('GCM_EXPLICIT_ACTION', 'tps:gcm-explicit-action'), true);
  assert.equal(hasExportedValue('CALENDAR_EXPLICIT_REFRESH', 'tps:calendar-explicit-refresh'), true);
});

test('shared TPS contract keeps legacy aliases for migration', () => {
  assert.equal(hasExportedValue('GCM_FILES_UPDATED', 'tps-gcm-files-updated'), true);
  assert.equal(hasExportedValue('GCM_EXPLICIT_ACTION', 'tps-gcm-explicit-action'), true);
  assert.equal(hasExportedValue('CALENDAR_SETTINGS_CHANGED', 'tps-calendar-settings-changed'), true);
  assert.equal(hasExportedValue('CALENDAR_EXPLICIT_REFRESH', 'tps-calendar-explicit-refresh'), true);
});

test('notifier API v2 exposes receipts and redacted diagnostics while retaining legacy calls', () => {
  assert.match(source, /readonly apiVersion: 2;/);
  assert.match(source, /structuredReceipts: true;/);
  assert.match(source, /redactedDiagnostics: true;/);
  assert.match(source, /stableSequenceIds: false;/);
  assert.match(source, /export interface TPSNotifierErrorShape extends Error/);
  assert.match(source, /readonly duplicateSafeToRetry: boolean;/);
  assert.match(source, /send\(request:[\s\S]{0,180}Promise<TPSNotifierDeliveryReceipt>/);
  assert.match(source, /validate\(request:[\s\S]{0,180}TPSNotifierDiagnostic/);
  assert.match(source, /sendNotification\(title: string, body: string, file\?: TFile\): Promise<void>/);
  assert.match(source, /sendMessage\(text: string, file\?: TFile, title\?: string\): Promise<void>/);
  assert.match(source, /@deprecated Sensitive compatibility surface\. Prefer validate\(\)\./);
});

test('runtime API is frozen, lifecycle-gated, and validates structured requests', () => {
  assert.match(mainSource, /const api: TPSNotifierApi<TFile> = \{/);
  assert.match(mainSource, /this\.exposedApi = Object\.freeze\(api\);/);
  assert.match(mainSource, /get api\(\): Readonly<TPSNotifierApi<TFile>> \| undefined/);
  assert.match(mainSource, /get settings\(\): Readonly<TPSNotifierSettings>/);
  assert.match(mainSource, /private readStructuredApiRequest\(request: unknown\)/);
  assert.match(mainSource, /if \(!request \|\| typeof request !== 'object' \|\| Array\.isArray\(request\)\)/);
  assert.match(mainSource, /if \(this\.lifecycleState !== 'ready'\)/);
  assert.match(mainSource, /this\.exposedApi = undefined;/);
  assert.match(mainSource, /this\.settingsQueue\.close\(disposedError\)/);
  assert.match(mainSource, /this\.deliveryPool\.close\(disposedError\)/);
});
