# TPS Notifier

## 1.1.3

- High-cardinality diagnostic cleanup now scans the dedupe map only when its oldest retained key can actually expire. The released path rescanned every retained key after each accepted message once the map exceeded 300 entries, even when time had not advanced.
- The cleanup deadline follows accepted timestamps, handles clock regressions, and resets when cleanup drops below the threshold. Dedupe keys, the exact 3,000 ms boundary, console levels/arguments, debug gating, always-on errors, and expiry behavior remain unchanged.
- In the focused 1,000-message regression, full-map scans fell from 700 to one without changing 1,000 emitted errors. One million released-vs-candidate events produced zero output or retained-map differences; an 8,000-key burst reduced scans from 7,700 to one and median time from 217.50 ms to 3.06 ms (98.59%).
- Delivery, ntfy requests, manual composer behavior, protocols, settings, public APIs, commands, and persisted data are unchanged. This backward-compatible patch keeps the minimum supported Obsidian version at 1.10.0 and requires no migration.

## 1.1.2

- Delivery now requests documented non-throwing HTTP responses from Obsidian so every non-2xx ntfy status follows the same structured status path.
- HTTP failures and transport failures are classified, sanitized, and logged exactly once instead of allowing redirects to be double-logged or ordinary 4xx/5xx responses to bypass status handling.
- Successful sends, rejection behavior, delivery settings, request preparation, dry runs, manual composer behavior, protocols, public APIs, and minimum Obsidian compatibility are unchanged. Automatic retries were not added because repeating a notification POST can duplicate delivery.

## 1.1.1

- Debug enablement announcements now occur only when logging actually changes from disabled to enabled, eliminating duplicate console writes from ordinary settings saves.
- Unload emits its final diagnostic before resetting logger state, so a later plugin lifecycle can announce one fresh activation.
- Delivery, ntfy requests, manual composer behavior, protocols, settings, public APIs, and minimum Obsidian compatibility are unchanged.

## 1.1.0

- Settings now use three clean destinations for delivery, the manual composer, and diagnostics, rendering only the selected page.
- Conditional transport and composer controls retain the active destination, useful scroll context, and keyboard focus; mobile uses a compact horizontal destination strip.
- Existing ntfy, composer, logging, and safety settings are unchanged. This backward-compatible minor release keeps the minimum supported Obsidian version at 1.10.0 and requires no migration.

## Development and deployment

Canonical source, tests, Git metadata, and dependencies live in `/Users/zachtisherman/TishOS Plugin Development/tps-messager`, outside both vaults. `npm run build` and watch builds deploy byte-changed runtime artifacts by default only to `/Users/zachtisherman/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Plugin Test Vault/.obsidian/plugins/tps-messager`; `npm test` is therefore isolated even though it ends with a production-mode build. Promotion to `/Users/zachtisherman/TishOS v0.1/.obsidian/plugins/tps-messager` is an explicit guarded post-validation action. Neither target overwrites `data.json` or other runtime-owned state.

- 2026-07-16 isolation validation: all 21 declared tests and the required final `npm run build` passed with `[runtime-deploy] target=test ... unchanged`. Obsidian 1.12.7 loaded Notifier disabled in the registered test vault, with no copied topic and no outbound notification. No live promotion occurred, and production runtime checksums remained unchanged.
- 2026-07-24 settings-release validation: all 26 contract, persistence, routed-settings, composer, and safety tests passed. The required final standalone build deployed only to `[runtime-deploy] target=test`. Obsidian 1.12.7 was reloaded with `Reload app without saving`; all three settings destinations and the shared nine-plugin `Choose what to configure` pattern were inspected in the registered test vault with delivery disabled and without changing settings, running the dry-run action, or sending a notification. Runtime-owned state remained absent and production was not accessed or promoted.
- 2026-07-30 logger-release validation: the released logger emitted 100 enablement announcements for a synthetic burst of 100 redundant `setLoggingEnabled(true)` calls; version 1.1.1 emits one, a 99% reduction for that redundant-announcement path. Focused tests also preserved enabled/disabled diagnostic gating, reactivation, and unload ordering. All 28 tests and the required final build passed. Obsidian 1.12.7 was reloaded in the registered test vault, and all settings destinations rendered with delivery disabled and without changing settings, running the dry-run action, or sending a notification. Runtime-owned state remained absent, and production was not accessed.
- 2026-07-30 delivery-status validation: the exact 1.1.1 path omitted the documented non-throwing request option, classified a returned 307 twice, and reduced an ordinary 503 rejection to a generic transport failure. Version 1.1.2 sends `throw: false`; synthetic 204, 307, 503, and network outcomes each followed the expected single route with sanitized diagnostics. All 29 tests and the required final build passed. Obsidian 1.12.7 reloaded the registered test vault and exposed both Notifier commands; the palette was dismissed without running the dry run, opening the composer, or sending a notification. Runtime-owned state remained absent, and production was not accessed.
- 2026-07-31 logger-cleanup validation: exact public `1.1.2` and `1.1.3` produced identical output and retained-map state across one million deterministic events, including exact window boundaries and adversarial clock movement. The 8,000-key burst reduced scans from 7,700 to one and median time by 98.59%. All 30 declared checks and the required separate build passed. Obsidian 1.12.7 reloaded the registered test vault and exposed both Notifier commands; the palette was dismissed without running either command, opening the composer, changing settings, or sending a notification. Runtime `data.json` remained absent, and production was not accessed.

## Install with BRAT

Add the public repository `ZachTish/tps-messager` to BRAT and select **Latest** so BRAT follows numbered releases without a private-repository token. Freeze a numeric version when a device should remain pinned.

## Mobile modal contract

Notifier input modals use `tps-keyboard-aware-modal`, reusing TPS GCM's shared visible-viewport behavior on mobile.

Sends push notifications from the vault to any device using ntfy.sh or a self-hosted ntfy server.

TPS Controller owns reminder evaluation, overdue state, snoozing, and the in-vault notification view. TPS Notifier is the delivery transport that Controller calls when a reminder needs to leave Obsidian.

## What It Does

### Push Notifications

- Delivers notifications through the ntfy HTTP API.
- Fresh installs start with delivery disabled until you explicitly enable transport.
- Supports configurable server URL, topic, and priority.
- Supports a master transport enable/disable toggle.
- Includes an Obsidian callback link when Controller passes a source file.
- Uses Obsidian `requestUrl` for plugin-safe delivery.
- Treats every 2xx response as success, reports every other HTTP status through one sanitized `ntfy returned <status>` failure, and keeps DNS/TLS/timeout failures on a separate transport path.
- Includes a dry-run command and settings diagnostic that validate the prepared ntfy URL, headers, priority, callback link, and fallback body without sending a network request.

### Manual Composer

- Command: Send Custom Notification.
- Can be disabled from settings.
- Includes a settings-based test send button when transport and manual composer are enabled; failed test sends report the actionable delivery/configuration error instead of a generic failure notice.
- Composer submit lifecycle is centralized in `submitManualComposerNotification()` so validation, send failure, and success/close behavior use one tested decision path.
- Composer send failures stay open and render inline status beside the send controls so the user can correct settings and retry.
- Successful sends are the only path that closes the composer and shows `Notification Sent`.

### Controller Integration

- Reminder rules and polling intervals live in TPS Controller settings.
- Controller calls `sendNotification()` or `sendMessage()` through this plugin's API.
- Notifier itself does not poll and does not evaluate reminders.
- Notification links use `obsidian://tps-messager`; the legacy `obsidian://tps-notifier` protocol remains accepted for existing messages.

## Source Layout

```text
src/
  main.ts                  - Plugin entry, API exposure, ntfy delivery, protocol handling, manual composer modal
  manual-composer.ts       - Manual composer validation, failure messages, and submit lifecycle decisions
  settings-tab.ts          - Settings UI for transport, diagnostics, and advanced protocol notes
  settings-migration.ts    - Defaults and persisted settings sanitization
  ntfy-url.ts              - ntfy server/topic validation and URL construction
  notifier-safety.ts       - decoded protocol-path validation and credential-safe delivery diagnostics
  types.ts                 - Settings type
  tps-contracts.ts         - Shared TPS event and API contracts
  logger.ts                - Debug logging wrapper with dedupe
```

## Diagnostics

Debug logging is gated behind `Enable Logging`; errors always log. The enablement announcement occurs once per disabled-to-enabled transition rather than on every settings-save synchronization, and unload resets the logger after its final trace. Dedupe-map cleanup begins above 300 retained keys and is guarded by the earliest possible expiry, avoiding repeated full scans before any key can expire while preserving the exact 3,000 ms boundary. When enabled, Notifier traces plugin load/unload, settings load/save queueing and failures, settings dry-run/test-send button clicks, manual composer opens/submits, dry-run preparation, delivery preparation failures, sanitized ntfy host/security/topic-presence metadata, priority/click-link presence, exactly one HTTP-status or transport failure classification, and protocol callback open decisions. Message bodies, custom title text, ntfy topics, URL credentials, and full delivery URLs are not logged. Delivery errors are redacted before they reach Notifier diagnostics or downstream retry UI.

Obsidian passes protocol query values to handlers already decoded. Notifier validates and normalizes that decoded path exactly once, preserving legitimate percent characters such as `100% Complete.md` or a literal `%20`, rejecting traversal/absolute paths, and converting an unexpected open failure into an actionable notice instead of an unhandled callback rejection.

## Settings

Settings use a shallow destination hub for delivery transport, the manual composer, and diagnostics. Only the selected destination is rendered, so connection fields and test actions remain easy to find without nested disclosures.

Persistence is serialized and read/merge/write safe. Each edit reloads the latest plugin data and applies only values changed in the current Notifier instance, preserving settings synced from another device and unknown extension/newer-release fields. A higher `settingsVersion` remains read-only instead of being downgraded. If the plugin cannot read `data.json`, it may use defaults for the current session but blocks all settings writes until a successful reload, so a temporary iCloud/read failure cannot replace valid configuration with defaults. Server and topic edits await the same durable save queue on every change; they are not left in a settings-tab debounce timer.

- `Enable delivery transport`: master outbound delivery toggle. Default: `off` on fresh installs.
- `ntfy Server`: base server URL such as `https://ntfy.sh`. Default: `https://ntfy.sh`.
- `ntfy Topic`: required topic name used as the POST target. Default: blank, so sends remain blocked until you provide a topic.
- `Priority`: integer slider from `1` to `5`.
- `Enable manual composer command`: registers the command palette action.
- `Enable Logging`: enables verbose console logging; errors still log when disabled.

Fresh-install safety contract:

- No notification can be sent until delivery is enabled.
- Even after enabling delivery, sends remain blocked until server and topic resolve to a valid ntfy URL.
- The settings test button only appears when delivery and manual composer are both enabled.
- Settings UI gates fail closed when the delivery enabled state is missing or malformed: transport-only server/topic/priority controls and the test-send section render only when delivery is explicitly enabled.

## Commands and API

- Command: `Send Custom Notification`
- Command: `Validate Notification Delivery Setup (Dry Run)`
- Exposed API:
  - `sendNotification(title, body, file?)`
  - `sendMessage(text, file?, title?)`
  - `dryRunMessage(text, file?, title?)`
- Supported protocol handlers:
  - `obsidian://tps-messager`
  - `obsidian://tps-notifier` (legacy alias)

## Naming

The plugin is named TPS Notifier. Its package, manifest, and protocol id is `tps-messager`; `tps-notifier` remains a compatibility protocol alias only.

## Planned Improvements

- Evaluate retries only if a future delivery contract can prove idempotency; the current plugin deliberately avoids automatic POST retries that could duplicate notifications.
- Add a rolling delivery log for troubleshooting.

## Integration

| Plugin | Relationship |
| --- | --- |
| TPS Controller | Primary dependency. Controller drives reminder evaluation and calls Notifier for delivery. |
| TPS GCM | Writes item metadata that Controller reads. |
| TPS Calendar Base | Independent except for file links passed through Controller notifications. |

## Validation Notes

- Current validation includes CLI tests/builds and targeted Obsidian settings UI checks after plugin reload.
- Commands run:
  - `npm test`
  - `npm run build`
- 2026-07-07: Added structured TPS Notifier delivery diagnostics. The plugin now logs flow events for plugin/settings lifecycle and save failures, settings dry-run/test-send clicks, manual composer open/submit decisions, dry-run preparation, send preparation/request/status/failure, and protocol callback blocks or file opens while avoiding message-body logging. Regression coverage updated in `scripts/test-manual-composer.mjs`. Validation: focused manual-composer diagnostics test and production build.
- 2026-07-11: Fixed notification callback paths so already-decoded percent characters are preserved and protocol open failures are caught. Delivery diagnostics now record only sanitized host/security/topic-presence metadata and redact topics, credentials, and full target URLs from propagated errors. Validation: focused protocol/diagnostic safety tests, full `npm test`, and production build.
- 2026-06-29: Simplified the Notifier settings tab by removing the search field, wrapper categories, and empty protocol-links section. Validation: `npm test`; Obsidian settings UI reload check.
- 2026-06-29: Settings saves are serialized and coalesced so rapid text edits persist the latest full value instead of an earlier one-character write. Validation: `npm run build` and shared save-queue simulation; Controller settings UI was reloaded and checked as the representative TPS settings persistence path.
- 2026-07-04: Settings test-send failures now reuse the manual composer failure message so disabled delivery, missing topic, and ntfy/network failures show actionable guidance. Validation: `npm test`, Obsidian reload and Home/command surface smoke check.
- 2026-07-04: Manual composer submit lifecycle now keeps the modal open for validation and send failures, closes only after a successful send, and ignores duplicate in-flight clicks. Validation: `node --test scripts/test-manual-composer.mjs`, `npm test`, Obsidian reload, command palette registration check, and open/cancel UI smoke check.
- 2026-07-04: Delivery settings UI now treats missing `enabled` state as disabled, hides transport-only fields and the test-send section unless delivery is explicitly enabled, and keeps the disabled explanatory copy visible. Validation: `node --test scripts/test-manual-composer.mjs`, `npm test`, Obsidian reload, settings UI toggle-off/toggle-on check without pressing Send Test, and live `data.json` restored to `enabled: true`.
- 2026-07-04: Added `Validate Notification Delivery Setup (Dry Run)` and `dryRunMessage()` so TPS plugins can verify the exact prepared ntfy request without calling `requestUrl`. Validation: `node --test scripts/test-manual-composer.mjs`, `npm test`, Obsidian reload, command palette registration check, and live dry-run command notice `Dry run prepared: https://ntfy.sh/obsidian_alerts`.
- Current automated coverage:
  - TPS event/legacy contract names
  - ntfy URL normalization and rejection cases
  - request preparation ordering for disabled delivery before network/config use
  - fake ntfy request contract for URL, headers, click link, and body fallback
  - settings sanitization and migration behavior
  - manual composer validation, failure messages, submit close decisions, and modal delegation to the submit helper
  - dry-run command/API/settings diagnostics prepare requests without sending
  - already-decoded protocol paths preserve literal percent characters and reject traversal/absolute paths
  - delivery diagnostics redact ntfy topics, URL credentials, full targets, and custom title text
  - 2xx, redirect, 4xx/5xx, and transport outcomes use documented request semantics and exactly one failure route
  - logger enablement is transition-aware, preserves diagnostic gating, and resets after the unload trace
  - high-cardinality logger cleanup preserves dedupe output and exact time boundaries while avoiding scans before any retained key can expire

## Version notes

- 1.1.3: Guarded high-cardinality logger cleanup by the earliest possible expiry, eliminating repeated full-map scans without changing diagnostic output or delivery behavior.
- 1.1.2: Made ntfy HTTP handling deterministic with documented non-throwing responses, one sanitized failure classification per request, and no automatic retry or public-contract change.
- 1.1.1: Made logger activation idempotent across repeated settings saves while preserving one announcement per real activation and resetting state after unload.
- 1.1.0: Reorganized settings into a shallow accessible destination hub, removed nested settings disclosures, and added conditional focus restoration plus mobile-safe controls without changing delivery behavior or data.
- 1.0.1: Made settings persistence merge local intent into the newest data, preserve unknown fields, fail closed after read errors, and durably save server/topic edits without an unload-unsafe timer.
- 1.0.0: Established the transport-only TPS Notifier contract with ntfy delivery, manual composer, dry-run diagnostics, safe protocol links, and Controller integration.

## Settings layout

Settings open on three destinations:

- **Delivery** (default): the transport toggle and, when enabled, ntfy server, topic, and priority.
- **Composer**: the manual composer command toggle and the test-send action when both transport and composer are enabled.
- **Diagnostics**: privacy-safe logging and the no-network dry-run action.

The route selection is transient and does not alter persisted settings. Conditional delivery/composer refreshes retain the active destination, scroll position, and keyboard focus. Native `aria-pressed` buttons and visible focus styling support keyboard and assistive use; narrow screens switch to a horizontal route strip and stacked, full-width controls. There are no nested settings disclosures, and the existing fail-closed delivery/test-send safety gates are unchanged.

- 2026-07-13: Promoted transport configuration to the root, nested the optional test sender under diagnostics, and enforced a fully collapsed first-open state with a maximum depth of two. Validation: settings hierarchy audit, full test suite, production build/deploy, and Obsidian reload.
