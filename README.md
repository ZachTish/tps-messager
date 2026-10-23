# TPS Notifier

## Built-in settings search

On Obsidian **1.13.0 or newer**, the global **Search settings** field finds controls across all this plugin's destinations, including sections that are not open. It searches the published control names, descriptions, option labels and help text. **All settings** is a native settings directory; activate a result there to open the existing destination and focus the matching control. Choosing a search result never runs its named action, saves preferences, enables a feature, or changes notes. Conditional controls remain conditional; when unavailable, the destination explains that a relevant feature or saved item must be selected first.

The existing **Choose what to configure** hub, default destination, one-level disclosures, controls and save/migration owners are preserved. Navigation and result focus are transient. Native settings pages provide the directory's desktop/mobile layout and keyboard navigation; existing destination styles and mobile controls remain unchanged. Older supported Obsidian versions retain their normal settings UI without native search integration. Physical-phone acceptance is separate from desktop QA.

Search metadata is generated at build time from the existing UI copy in `scripts/settings-search-config.mjs`'s source list. After editing settings copy or adding a route, run `npm run settings:search`; tests and builds reject a stale catalog. Configuration helpers and selectable property tables are included explicitly. Runtime definition enumeration reads no vault files, note bodies, credentials, network or hidden-page DOM. There is no new watcher, timer, scan or persisted index. Existing conditional editors still mount only through their original owner when their area is opened.

The settings/action inventory is preserved in source; focused regressions cover catalog freshness, every indexed entry and destination, description/placeholder aliases, read-only navigation, 1,000 metadata-enumeration calls without UI/I/O/saves, disclosure focus and disabled-control visibility. The full declared suite and separate final build remain required. Release notes record installed search, route, state-preservation and performance evidence.


Installed acceptance: all existing destinations were inspected in the reloaded desktop test vault. Native archive results and keyboard navigation were checked without executing maintenance actions or changing saved preferences. Conditional controls stay disabled/hidden until their existing prerequisites are selected. Existing mobile CSS is retained; physical phone acceptance remains separate.

## Development workflow

Run `npm test`, then `npm run build` for the separate final production-mode build. Both commands stay inside this checkout and never deploy or reload a vault. The build needs only this repository and its declared dependencies; no parent workspace helper is imported. Deployment is an explicit test-vault operation owned by the workspace release checklist. Runtime artifacts and private settings are never copied back into source. This tooling-only change does not alter the plugin version or runtime behavior.

Configured ntfy notification delivery and a manual composer for the TPS suite.

Current release: [1.1.5](https://github.com/ZachTish/tps-messager/releases/tag/1.1.5) · Obsidian 1.10.0+ · Desktop and mobile.

## Install with BRAT

Add `ZachTish/tps-messager` to BRAT. Use manual updates with `Latest`, or freeze an exact numeric tag for a controlled rollout. Each release supplies `main.js`, `manifest.json`, and `styles.css`; release notes record validation and artifact hashes. A published release is not evidence that any device has installed it.

## Configure delivery

The repository and plugin ID remain `tps-messager`; the display name is TPS Notifier. The `tps-notifier` URI remains a legacy alias.

Open **Delivery** to enable transport and configure ntfy server, topic, and priority. Fresh installations keep delivery off with no topic; sends remain blocked until the configuration is valid. **Composer** controls the manual command and conditional test-send action. **Diagnostics** provides logging and a no-network dry run.

Settings use a single visible destination with transient route state. Writes are serialized and preserve external/newer fields. Unreadable settings block persistence instead of overwriting stored configuration with defaults; unsupported future schema versions remain read-only.

## Commands and integrations

- **Send Custom Notification** sends the explicitly composed message when enabled.
- **Validate Notification Delivery Setup (Dry Run)** validates without network delivery.
- `sendNotification(title, body, file?)`, `sendMessage(text, file?, title?)`, and `dryRunMessage(text, file?, title?)` are the public delivery API.

Controller and other TPS consumers decide when to request a notification. This plugin owns transport, not reminder scheduling or status rules. See [the detailed reference](REFERENCE.md) for the settings inventory, protocol aliases, diagnostics, and validation history.

## Development and repository policy

`main` is the stable source line. Numeric tags identify immutable released artifacts. `optimization` is an unreleased work-in-progress lane; do not install it through BRAT or merge it into stable without separate validation.

Documentation-only maintenance does not create a new plugin version. Published release tags and assets are preserved. Do not rely on legacy version/release scripts without reviewing their current behavior. Production updates remain the user's BRAT handoff.

For prior feature details and release-specific evidence, see [REFERENCE.md](REFERENCE.md) and [GitHub releases](https://github.com/ZachTish/tps-messager/releases). The September 16 cleanup changes documentation and repository metadata, not shipped behavior.
