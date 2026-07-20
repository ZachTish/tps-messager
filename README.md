# TPS Notifier

TPS Notifier is the outbound push transport for the TPS plugin suite. TPS Controller owns reminder evaluation and state; Notifier validates and publishes messages to an ntfy topic and optionally includes an Obsidian callback link.

## Development lanes and BRAT

- Stable source: `Plugin Development/tps-messager` on `main`.
- Optimization source: `Plugin Development/tps-messager (Optimize)` on `optimization`.
- Stable feature/fix agents may build into this test vault, validate, version, and publish a private GitHub release. BRAT on production devices pulls that release; an agent does not need to copy files into the production vault.
- Optimization builds are build-only (`[runtime-deploy] target=none lane=optimization`). They do not overwrite the test runtime, change a version, create a tag/release, merge to `main`, or touch production.
- Periodic alignment merges stable `main` into `optimization`. After the user accepts the optimization work, it is reconciled into `main`, fully revalidated, versioned, and published as a normal private BRAT-compatible release.

For BRAT, add the private repository `ZachTish/tps-messager` and track **Latest**. A fine-grained GitHub token, if required, needs only read access to repository contents. Never store that token in this repository or a synced note.

## Current features

### Transport

- HTTP(S) ntfy publishing through Obsidian `requestUrl`.
- Configurable server/reverse-proxy base path, topic, and priority.
- Delivery disabled by default until a valid target is applied and explicitly enabled.
- Message titles, Markdown bodies, and optional Obsidian callback links.
- Legacy `obsidian://tps-notifier` callback links remain accepted; newly generated links use `obsidian://tps-messager`.
- Four requests may be active concurrently. Up to 100 more wait in FIFO order rather than being dropped.
- Pending requests prepared for an older route are canceled as `delivery-invalidated` before network activity when delivery is disabled or an applied server/topic/priority changes. Already-started network requests continue because Obsidian exposes no supported cancellation.

### Settings safety

- Server/topic/priority edits live in an isolated draft.
- The previously applied route remains active while an enabled user edits a draft.
- **Apply** validates and durably saves one immutable snapshot. All transport controls lock while that transaction is pending.
- **Discard draft** returns to the active settings. Closing the settings tab discards only when no Apply is in progress.
- Enabling takes effect only after persistence succeeds.
- Disabling blocks new sends immediately while its save is pending and cancels queued, not-yet-attempted sends. It changes the active settings snapshot only after persistence succeeds. A failed save restores the prior settings snapshot and reports failure, but intentionally does not resurrect canceled queue entries.
- Settings writes are serialized. Every caller waits for its own save and receives its own failure.
- Future, malformed-version, and malformed-root settings documents are read-only and delivery-disabled. Malformed known fields and previously enabled targets outside the supported contract are disabled with an explicit startup/settings warning; field-level problems remain repairable only through an explicit valid **Apply**.
- Persisted priorities are never rounded or clamped while delivery remains active. Malformed targets never inherit the default public server.

### Delivery result contract

A successful structured send resolves only after a correlated ntfy message receipt is present:

```ts
{
  outcome: "accepted";
  httpStatus: number;
  providerMessageId: string;
}
```

Failures are structurally consumable across plugin bundles:

```ts
{
  code: TPSNotifierErrorCode;
  attempted: boolean;
  deliveryState: "not-attempted" | "rejected" | "unconfirmed";
  duplicateSafeToRetry: boolean; // duplicate safety, not timing/advisability
  httpStatus?: number;
}
```

- Local validation/lifecycle failures are `not-attempted`.
- `delivery-invalidated` means bounded queued work was canceled before a network attempt because the active route changed.
- A 4xx is `rejected` only when its JSON matches ntfy's structured error schema and its numeric code is in the reviewed publish-error allowlist. Unknown/future codes—including family-shaped proxy 499 responses—remain unconfirmed until deliberately reviewed. A confirmed rejection is duplicate-safe to retry only after the cause is corrected.
- Redirects, unstructured or malformed 4xx responses, transport exceptions, HTTP 408/5xx, and 2xx responses without a correlated ntfy message receipt are `unconfirmed`. Callers must check ntfy before retrying because acceptance cannot be ruled out.
- Provider response text is never propagated, logged, or displayed.

### Manual composer and diagnostics

- `Send Custom Notification` command, dynamically available only when the manual composer is enabled.
- Single-instance, labeled composer with initial focus, Ctrl/Cmd+Enter submit, inline live status, independently namespaced responsive mobile styling, locked inputs while sending, and duplicate-submit prevention.
- Closing a composer during delivery does not cancel the request. The plugin displays both an immediate “continues” notice and the eventual accepted/failure result when the plugin is still loaded.
- `Validate Notification Delivery Setup (Dry Run)` command validates the applied target without network traffic.
- Settings dry run validates the unsaved draft without persisting it or exposing the topic, full URL, note path, title, or body.
- A real settings test send appears whenever the applied transport is enabled; it is independent of manual-composer availability and is guarded against duplicate clicks across rerenders.

## Supported input contract

The transport intentionally accepts only forms it can validate consistently:

- Topic: 1–64 characters from `[-_A-Za-z0-9]`, matching the official ntfy topic contract.
- Server: absolute `http:` or `https:` URL of at most 2,048 characters, optionally with a reverse-proxy path.
- Server credentials, query strings, fragments, controls, and backslashes are rejected.
- Priority: integer 1–5.
- Body: text up to 4,096 UTF-8 bytes. Larger ntfy bodies become attachments, so Notifier rejects them instead of silently changing message type.
- Title: text up to 512 UTF-8 bytes. C0/C1 controls are rejected; non-ASCII titles use bounded RFC 2047 encoded words.
- Click header: text up to 4,096 characters with no header controls. Internally generated links must reference a current `TFile` in the active vault.

These restrictions remove previously tolerated inputs that were either outside ntfy's documented topic rules, could leak credentials, or could change semantics unexpectedly. An upgrade warning is shown if such a target had been enabled. Protected self-hosted topics need a future explicit authentication feature; embedding credentials in the server URL is not a supported substitute.

Plain HTTP remains supported for intentional local/self-hosted use, but it does not encrypt the topic, title, body, or callback link. When a caller supplies a file, the `Click` header sent to the configured ntfy server contains the vault name and full vault-relative note path so the subscriber can reopen it. That data is not logged by Notifier, but it is transmitted to the provider and subscriber; callers should omit `file` when that disclosure is not appropriate.

## API

`plugin.api` is exposed through a read-only getter. The API object, its capability object, and the active settings snapshot are frozen.

```ts
api.apiVersion === 2
api.capabilities === {
  structuredReceipts: true,
  redactedDiagnostics: true,
  stableSequenceIds: false,
}

api.send({ title?, body, file? })       // structured receipt
api.validate({ title?, body, file? })   // redacted, non-sending diagnostic
api.sendNotification(title, body, file?) // legacy Promise<void>
api.sendMessage(body, file?, title?)     // legacy Promise<void>
api.dryRunMessage(body, file?, title?)   // deprecated raw request
```

Suite consumers no longer need private registry discovery for v2. Notifier publishes the same frozen API descriptor through the public Obsidian Workspace event surface:

- `tps:notifier-api-request` lets a late-loading consumer supply a synchronous acceptance callback.
- `tps:notifier-api-available` announces the current descriptor after API exposure.
- `tps:notifier-api-unavailable` withdraws that exact descriptor during restart or unload.

The generated consumer adapter parses the provider ID, protocol, API version, capabilities, receipts, errors, and service requests into frozen snapshots. Every hostile getter is read at most once, and later routing consumes only normalized fields and captured methods rather than rereading a live event object. Compatibility Boolean guards remain exported, but event boundaries use the snapshot parsers. The adapter clears a cache only for the exact withdrawn descriptor or API, never falls through after an invocation begins, and permanently classifies malformed or ambiguous v2 outcomes as `unknown` for that occurrence. A lifecycle epoch prevents delayed acceptance callbacks and old available/unavailable handlers from repopulating a disposed or restarted client.

Consumer provider waits have a 60-second default deadline, configurable from 1 millisecond through 5 minutes in the generated client's optional third constructor argument. Expiry returns `state: "unknown"`, `evidence: "consumer-timeout"`, `attempted: "unknown"`, and the selected v1/v2 transport. It never falls through or retries that occurrence. This is an observation deadline only: the underlying provider call may still finish because neither the legacy API nor Obsidian `requestUrl` supports cancellation.

During the consumers-first BRAT transition, the adapter contains one explicit compatibility exception: when no v2 event provider exists, it reads only the old plugin's `plugin.api`, captures one legacy method, maps resolve to `legacy-accepted`, and maps every rejection to `unknown`. It never falls back to arbitrary plugin-instance methods. The compatibility lookup is removed after every device runs v2.

Cached methods fail closed permanently after unload, including after a same-instance reload; consumers must resolve the current API again. Structured v2 calls reject unknown request fields and blank/whitespace-only bodies. The two legacy send methods remain for compatibility, preserve their argument order and historical empty-body placeholder, and now reject unconfirmed delivery instead of treating an arbitrary 2xx response as accepted. Consumers should migrate to `apiVersion === 2`, `send()`, and structural error fields before this branch is promoted.

`stableSequenceIds` is deliberately `false`. ntfy sequence IDs update/replace notifications; they are not a general exact-once publishing guarantee. No automatic retry exists until caller correlation and partial-batch accounting are designed across the suite.

## Lifecycle and privacy

- A true initialization failure exposes no API. A settings-read failure intentionally reaches `ready` with defaults plus a settings-read-only API, so diagnostics can explain the block while all delivery and writes fail closed.
- Queued settings writes reject immediately on unload, while an already-started save retains ownership until it settles. Queued deliveries reject on unload or route invalidation. An already-started network call cannot be canceled by the supported Obsidian `requestUrl` API and may still return its actual result to the original caller.
- A same-instance reload waits for an active settings write before reading persisted state and creates fresh queues. Startup fails closed after 15 seconds instead of creating a second queue alongside a stuck persistence call; a later reload can succeed once that original call settles.
- Deferred or overlapping loads are epoch-gated after every asynchronous initialization boundary, so an unloaded/superseded load cannot register commands, re-enable logging, or expose an API.
- Debug logs contain structured lengths, booleans, status, host (only when debug logging is enabled), queue depth, and error classification.
- Errors are always logged as bounded classifications. Generic raw error messages and all stacks are omitted. Notification body/title, topic, credentials, provider response text, full delivery URLs, and vault-relative note paths are excluded from intentional log metadata.
- Dedupe logging state is bounded to 300 entries.

## Known limitations

- No first-class ntfy username/password or access-token setting. Do not embed credentials in the server URL.
- Obsidian `requestUrl` exposes no supported timeout or abort signal. If all four active provider requests hang, Notifier's internal delivery pool remains blocked.
- The consumer adapter's bounded observation deadline does not cancel provider I/O. It deliberately reports `consumer-timeout` as unknown and prohibits same-occurrence fallback; callers must durably retain that uncertainty and must not automatically resend.
- ntfy itself does not provide an exact-once guarantee for this workflow. `unconfirmed` must remain a real state.
- A reverse proxy must preserve the standard ntfy JSON message receipt. A stripped or rewritten 2xx body is intentionally `unconfirmed`.
- `dryRunMessage()` returns a sensitive raw request and remains only for compatibility. New code should use `validate()`.
- There is no per-message UI ledger or cross-restart reconciliation yet. Provider acceptance can be proved for a returned receipt, but exact-once delivery cannot be guaranteed after a lost response or crash.
- The optimization copies of Watchlist, AI Gateway completion delivery, and Controller hourly time-tracking now use the synchronized v2 client with durable outcome accounting. Controller's general reminder batches intentionally remain on their legacy path until they have stable per-occurrence identities and a reviewed batch-settlement policy; see `Audit.md`.
- Each repository build currently imports the adjacent workspace deployment helper and is not standalone-buildable in GitHub Actions.

## Source layout

```text
src/
  main.ts                    lifecycle, immutable API/settings exposure, protocol handling, delivery orchestration
  settings-tab.ts            draft/apply settings transaction UI and diagnostics
  manual-composer.ts         pure validation/result decisions
  manual-composer-modal.ts   accessible modal lifecycle and close-during-send reporting
  ntfy-url.ts                strict target validation and URL construction
  ntfy-request.ts            payload/header validation and immutable request preparation
  notifier-delivery.ts       response classification and correlated receipt validation
  notifier-errors.ts         typed/structural delivery failures
  notifier-safety.ts         callback-path validation and redacted target summaries
  settings-migration.ts      schema classification, safe defaults, and migration warnings
  serial-task-queue.ts       closeable FIFO settings transactions
  closable-task-pool.ts      bounded concurrent delivery with FIFO backpressure
  logger.ts                  bounded, privacy-conscious structured diagnostics
  tps-contracts.ts           TPS event compatibility plus Notifier API-v2 types
  tps-notifier-contract.ts   canonical generated inter-plugin service and result contract
  tps-notifier-client.ts     v2 event consumer plus isolated transition-only v1 adapter
```

Unused private-registry helpers, generic card/list utilities, and the BRAT-ignored `styles-ui.css` were removed from the optimization lane.

## Validation

Current optimization validation is intentionally isolated:

- 89 automated tests pass.
- TypeScript strict-null/no-implicit-any typecheck passes.
- Tests cover official topic/URL boundaries, Unicode/header limits, 4,096-byte bodies, correlated receipts, structured rejection vs ambiguous delivery, response privacy, public provider-first/consumer-first discovery, exact-provider withdrawal, single-read hostile descriptor/request/receipt/error snapshots, throwing event listeners, delayed old-epoch callbacks, bounded never-settling v1/v2 providers, v2/v1 route precedence, settings migration/version handling, exact settings-save ownership, immediate queue disposal, unload/overlapping-load races, permanently stale API references, route-generation invalidation, five-way concurrent delivery, strict v2 versus legacy compatibility, protocol paths, settings draft source invariants, modal accessibility/close behavior, and namespaced mobile CSS contracts.
- `npm test` ends with an isolated production-mode build. Optimization output must report `[runtime-deploy] target=none lane=optimization`.
- No provider request, Obsidian UI mutation/reload, test-runtime deployment, version bump, tag, GitHub release, or production action belongs to this optimization validation.
- Composer/settings assertions are synthetic and source-level; rendered desktop/iOS acceptance remains an explicit later gate.

See [Audit.md](Audit.md) for the remaining suite-wide risks and acceptance plan.
