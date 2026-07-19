# TPS Notifier

## Development and deployment

Canonical source, tests, Git metadata, and dependencies live in `/Users/zachtisherman/TishOS Plugin Development/tps-messager`, outside both vaults. `npm run build` and watch builds deploy byte-changed runtime artifacts by default only to `/Users/zachtisherman/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Plugin Test Vault/.obsidian/plugins/tps-messager`; `npm test` is therefore isolated even though it ends with a production-mode build. Promotion to `/Users/zachtisherman/TishOS v0.1/.obsidian/plugins/tps-messager` is an explicit guarded post-validation action. Neither target overwrites `data.json` or other runtime-owned state.

- 2026-07-16 isolation validation: all 21 declared tests and the required final `npm run build` passed with `[runtime-deploy] target=test ... unchanged`. Obsidian 1.12.7 loaded Notifier disabled in the registered test vault, with no copied topic and no outbound notification. No live promotion occurred, and production runtime checksums remained unchanged.

## Install with BRAT

Add the private repository `ZachTish/tps-messager` to BRAT and select **Latest** tracking so BRAT follows the newest GitHub release. For private-repository access, give BRAT a fine-grained GitHub token scoped to this repository with **Contents: Read-only** permission. Never commit the token to this repository, an Obsidian vault, or any synced note.

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

Debug logging is gated behind `Enable Logging`; errors always log. When enabled, Notifier traces plugin load/unload, settings load/save queueing and failures, settings dry-run/test-send button clicks, manual composer opens/submits, dry-run preparation, delivery preparation failures, sanitized ntfy host/security/topic-presence metadata, priority/click-link presence, HTTP status failures, and protocol callback open decisions. Message bodies, custom title text, ntfy topics, URL credentials, and full delivery URLs are not logged. Provider errors are redacted before they reach Notifier diagnostics or downstream retry UI.

Obsidian passes protocol query values to handlers already decoded. Notifier validates and normalizes that decoded path exactly once, preserving legitimate percent characters such as `100% Complete.md` or a literal `%20`, rejecting traversal/absolute paths, and converting an unexpected open failure into an actionable notice instead of an unhandled callback rejection.

## Settings

Settings use direct collapsible sections with descriptive titles for the ntfy delivery toggle, server/topic/priority, manual composer/logging, and test notification controls.

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

- Add bounded retry with backoff for failed ntfy pushes.
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

## Settings layout

The delivery toggle, ntfy server, topic, and priority are root-level core controls. Manual composer, logging, dry-run, and delivery testing are optional collapsed controls; the test-send subsection is the second and final collapse level. A fresh settings open closes every optional section.

- 2026-07-13: Promoted transport configuration to the root, nested the optional test sender under diagnostics, and enforced a fully collapsed first-open state with a maximum depth of two. Validation: settings hierarchy audit, full test suite, production build/deploy, and Obsidian reload.
