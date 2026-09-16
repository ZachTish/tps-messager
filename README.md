# TPS Notifier

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

The supported build lives inside `Obsidian Plugin Test Vault/Plugin Development`, with `tps-messager` as the mapped stable source. These repositories depend on adjacent shared tooling including `deploy-runtime.mjs`; a standalone clone is not currently self-contained.

From the contained workspace, prepare dependencies using the shared helper, then run tests and a separate final build:

```sh
# From Plugin Development:
node ./prepare-dependencies.mjs "tps-messager"
cd "tps-messager"
npm test
npm run build
```

Dependencies stay in the vault's `.plugin-dev-cache.nosync` through a relative `node_modules` symlink. Use a clean, current checkout; preserve unrelated changes and never build an old dirty worktree into the test runtime. Stable builds deploy only shipped artifacts to the test vault. Optimization builds are build-only. Runtime `data.json`, secrets, caches, and session state never belong in Git.

Documentation-only maintenance does not create a new plugin version. Published release tags and assets are preserved. Do not rely on legacy version/release scripts without reviewing their current behavior. Production updates remain the user's BRAT handoff.

For prior feature details and release-specific evidence, see [REFERENCE.md](REFERENCE.md) and [GitHub releases](https://github.com/ZachTish/tps-messager/releases). The September 16 cleanup changes documentation and repository metadata, not shipped behavior.
