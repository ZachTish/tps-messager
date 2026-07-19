# TPS Notifier optimization audit and action plan

Audit date: 2026-07-19

Lane: `optimization`

Scope: canonical source and tests in this repository plus read-only review of known TPS consumers. No provider request, UI automation, runtime deployment, version/tag/release, merge, or production access.

## Executive assessment

The plugin's feature set is worth keeping. No major user-facing capability—ntfy delivery, self-hosted base URLs, manual composition, callback links, dry run, or legacy callers—needs wholesale removal.

The old implementation was nevertheless too optimistic at several boundaries: settings fields mutated the active route while the user typed, save callers could receive the wrong transaction result, any 2xx was called success, raw provider text could escape, stale API references could send after unload, a hard concurrency limit dropped work, and several unsupported inputs were silently tolerated.

The optimization branch addresses those issues without touching either runtime. It is materially cleaner and safer, but it is not yet a suite-wide release candidate. The principal remaining risk is consumer alignment: Controller, AI Gateway, and Watchlist still use legacy discovery/call patterns and do not consume `not-attempted`/`rejected`/`unconfirmed` outcomes. Updating Notifier alone would expose existing duplicate-or-loss behavior in those consumers even though their legacy method signatures still compile.

## Feature-impact decision

Most changes are stability-only from a valid configuration's perspective. These deliberate behavior changes must be treated as compatibility changes during acceptance:

1. A saved enabled target outside the official/supported contract is disabled with a visible warning. This includes dotted or over-64-character topics, URL-embedded credentials, and server query/fragment tricks. These were tolerated by old string concatenation, not reliably supported product features.
2. Bodies over 4,096 UTF-8 bytes are rejected rather than silently turning into ntfy attachments.
3. A 2xx response without a correlated ntfy `event:"message"`, matching topic, and valid message ID is `unconfirmed`, not accepted.
4. Legacy send promises now reject on unconfirmed delivery. That is more honest, but old consumers must not blindly reset and resend a partially delivered batch.
5. Persisted priorities are no longer rounded/clamped while delivery stays active; malformed fields disable delivery until the user explicitly applies a repaired transport.
6. Only a response matching ntfy's structured error schema is a definite `rejected` result. Redirects and unstructured/malformed 4xx responses are conservatively `unconfirmed`, so callers must not blindly retry them.
7. Structured API v2 rejects unknown keys and blank/whitespace-only bodies. Legacy wrappers retain the historical empty-body placeholder for the compatibility window.
8. Pending, not-yet-attempted sends are canceled when disabling begins or a newly applied route supersedes the route against which they were prepared. Already-started requests finish normally.

Do not remove self-hosted ntfy support. Instead, add explicit SecretStorage-backed authentication later if protected topics are required. Do not restore embedded credentials as a fallback.

## Findings resolved in this branch

### Settings and lifecycle

- Active settings are frozen and exposed through a getter; UI edits use a separate draft.
- The active route remains usable during ordinary draft editing.
- Apply captures one snapshot, locks all transport controls, and installs only after persistence.
- Disable uses an independent immediate pause token and changes the snapshot only after its save succeeds.
- Writes run FIFO, and each promise corresponds to its own transaction.
- Queue close immediately rejects not-started writes while preserving ownership of the active persistence call.
- Unload and overlapping load invalidate epochs at every awaited startup boundary, remove the API, suppress stale UI updates, and prevent a completed late read/save from resurrecting runtime state.
- Same-instance reload waits for the previous settings queue to become idle before reading data and fails closed after a bounded wait instead of overlapping a stuck save.
- Future/malformed schema roots and versions are read-only. Malformed known fields and unsupported enabled routes are disabled, warned, never rounded/clamped into active use, and never redirected to the default public server.

### Transport and delivery truth

- URL and topic validation now follows one strict helper.
- Request construction rejects header controls, unsafe lengths, invalid priority, and attachment-changing body size before network activity.
- `requestUrl` explicitly uses `throw:false`, so status handling is reachable and testable.
- Acceptance requires a correlated standard ntfy receipt.
- Failures distinguish `not-attempted`, `rejected`, and `unconfirmed`, with structural duplicate-safety fields. Only provider-shaped ntfy error JSON with a reviewed documented publish code establishes rejection; unknown/future codes and ambiguous HTTP responses remain unconfirmed.
- Raw response text is not read. Provider error-message content is never logged, propagated, or displayed; rejection validation inspects only bounded JSON receipt fields plus error-field type/nonempty status.
- Four active requests are preserved for throughput; later requests wait in a bounded FIFO instead of the fifth being discarded. Queued requests carry route-generation ownership and are invalidated before I/O when superseded.
- No delivery/network timeout or automatic retry was added. The separate 15-second startup wait fails closed if an earlier settings save is still active; it never claims the save was canceled.

### API, UI, privacy, and cleanup

- Frozen API v2 adds structured `send()` and redacted `validate()` while preserving legacy methods.
- Cached API methods remain permanently invalid after unload/reload, and the public API/settings slots are getter-only.
- Core delivery no longer creates Notices, eliminating double-reporting for callers.
- The manual composer is isolated into a class, is labeled/focusable, locks inputs while sending, reports close-during-send outcomes, and uses Notifier-owned mobile/CSS class names rather than hidden Global Context Menu coupling.
- Settings operations retain class-level in-flight guards across rerenders; draft edits dynamically lock invalid enable actions, test sends are independently guarded, and focus is restored to the initiating control after rerender.
- Logs bound dedupe memory, omit all stacks and generic raw error messages, avoid response/body/title/topic/path metadata, and redact hostnames from always-on delivery failures.
- Dead private-registry helpers, generic list/card utilities, duplicated unused styles, and the invalid npm `version` script were removed.

## Remaining issues, ranked

### P0 — required before accepting the optimization set

#### 1. Migrate every Notifier consumer as one cross-plugin contract change

Owners: TPS Controller, TPS AI Gateway, TPS Watchlist, TPS Notifier.

Current consumers still discover plugins through private registry access and commonly fall back from `plugin.api` to the plugin instance. They call `sendNotification()`/`sendMessage()` and treat any rejection as a total failure. That cannot safely represent a partial batch whose earlier messages were accepted and a later result is unconfirmed.

Concrete impact found in the read-only consumer audit:

- Controller sends alert batches sequentially, then restores the entire pre-run alert state on any later failure. If item one was accepted and item two is rejected/unconfirmed, the next run resends item one.
- Controller hourly time-tracking records dedupe only after the legacy promise resolves. An unconfirmed result can be retried during minutes 0, 1, and 2 of the same hour.
- Watchlist commits event/watch state before notifying, then treats notification rejection as a whole-check failure. It avoids the same duplicate pattern but can permanently lose a not-attempted notification.
- AI Gateway commits completion before notification and logs/drops every notification failure, leaving no accepted/rejected/unknown record.
- Controller, Calendar, and Kanban carry older copied notifier contracts; Watchlist and AI Gateway do not negotiate API v2 at all.

Action:

- Introduce the same structural `TPSNotifierApi` and `TPSNotifierErrorShape` in a single generated/shared contract source.
- Implement one runtime structural error guard (`code`, `attempted`, `deliveryState`, `duplicateSafeToRetry`, optional `httpStatus`) in every consumer adapter. Do not use `instanceof` across separately bundled plugins. Treat this flag only as duplicate evidence; 401 needs auth correction, 413 needs payload correction, and 429 needs deliberate backoff.
- Replace private `app.plugins.getPlugin` discovery with a suite-owned handshake over supported Obsidian events (request/accept plus ready/unavailable lifecycle events). During one compatibility window, isolate registry lookup in a single tested v1 adapter; do not spread the unsupported call or fall back to arbitrary plugin-instance methods.
- First publish consumer compatibility releases that feature-detect `apiVersion === 2 && capabilities.structuredReceipts && send`, while retaining an explicit, tested v1 policy.
- Define that v1 policy conservatively: legacy resolve records one `legacy-accepted` result and advances once; every legacy rejection becomes `unknown` with no automatic resend because v1 cannot prove whether delivery was attempted.
- Treat consumers-first as a hard BRAT deployment gate, not merely a tested rollout option: repository updates are independent and old Controller plus new strict Notifier is duplicate-prone. Confirm every device has the compatibility consumers before publishing/selecting Notifier v2. Only after all consumers are confirmed on v2 should a later cleanup remove registry fallback, `.api || plugin`, and legacy calls.
- Use `api.send()` and record each receipt against the exact item/batch member before advancing state.
- Persist each item's `accepted`, `rejected`, `not-attempted`, or `unknown` result before continuing. Add explicit schema migrations for Controller alert/hourly state, Watchlist state, and AI job JSON; an in-memory unknown result is insufficient because restart would recreate a blind retry.
- Persist `attempting` before starting network I/O. On restart, any leftover attempt migrates to durable `unknown` and is never automatically resent.
- On `not-attempted`, preserve state and allow retry after correction.
- On structured `rejected`, preserve state and allow a deliberate retry after fixing configuration/auth/payload.
- On `unconfirmed`, retain an explicit unknown state and do not automatically resend.
- Add mixed-version and cross-plugin tests for both rollout orders, accepted-first/unconfirmed-second, accepted-first/rejected-second, unload, and missing/old API.

Acceptance gate: no consumer may convert `unconfirmed` into “definitely failed” or blindly resend the full batch.

#### 2. Reconcile stable changes into every optimization worktree before integration

Feature/fix work continues on stable `main` while optimization continues on `optimization`. Before a suite preview, merge each current `origin/main` into its corresponding optimization branch one repository at a time. Resolve by behavior and rerun that plugin's complete isolated suite. Never copy source between runtime and worktrees.

Acceptance gate: every optimization branch records the stable commit it contains, is clean, and passes its own full build with `target=none`.

### P1 — high-value next work

#### 3. Add explicit ntfy authentication instead of URL tricks

If protected self-hosted topics are required, add username/password or access-token support using Obsidian SecretStorage where available. Never persist secrets in `data.json`, logs, URLs, notices, fixtures, or release artifacts. Define precedence and migration deliberately; do not parse embedded credentials as a fallback.

Acceptance gate: synthetic auth tests prove the Authorization header is correct and every diagnostic/error path is secret-free on desktop and mobile.

#### 4. Make callback-link disclosure and transport privacy explicit

When a caller supplies `file`, Notifier transmits the vault name and full vault-relative note path in the ntfy `Click` header. Plain HTTP also transmits topic/title/body/link without encryption. Add an explicit `include callback link` policy at the caller or Notifier boundary, consider an opaque lookup token if links must avoid paths, and show a clear warning for nonlocal HTTP. Do not confuse “not logged” with “not transmitted.”

Acceptance gate: tests cover link omitted/included behavior, settings copy clearly describes disclosure, and no identifier enters logs or notices.

#### 5. Design suite-level correlation without claiming exact-once delivery

ntfy sequence IDs update or replace notifications; they are not a universal idempotency key. Keep `stableSequenceIds:false` until the exact UX is chosen. A useful design would give each logical reminder/watch/AI event a stable caller correlation ID, persist provider receipt IDs per item, and expose an explicit unknown ledger for reconciliation.

Acceptance gate: crash/restart and partial-batch simulations demonstrate no automatic duplicate and no silent loss. Do not add retry first.

#### 6. Run serialized UI and mobile acceptance

The branch has source/CSS contracts but no real Obsidian UI or provider validation because optimization is build-only. When the user requests a preview, serialize it: record stable runtime hashes/state, deploy only this optimization artifact to the test vault, reload only the test plugin, use one safe dedicated test topic/endpoint to confirm actual `requestUrl` receipts and reverse-proxy behavior, test settings Apply/Discard/save failure and composer keyboard/mobile behavior, then restore the stable runtime byte-for-byte.

Acceptance gate: desktop and iOS test-vault evidence; production untouched.

### P2 — maintainability and performance

#### 7. Replace duplicated TPS contract files with generated artifacts

P0 establishes the minimal canonical Notifier API/error contract and a drift guard needed for safe consumers. This broader P2 item then replaces the remaining divergent `tps-contracts.ts` copies across the whole suite: generate/check copied artifacts, or publish a local workspace package that still bundles cleanly for Obsidian. Avoid a runtime dependency between plugins.

#### 8. Make repositories standalone-buildable

Every esbuild configuration currently imports `../deploy-runtime.mjs`. Split bundling from optional workspace deployment so a clean repository checkout can build and GitHub Actions can verify/release without reconstructing this vault layout. Keep local deploy guards in a wrapper.

#### 9. Add supported observability, not a message-content delivery log

Expose counts for active/pending requests and recent result classes without retaining bodies, titles, topics, or note paths. A rolling content log creates privacy and sync risk and is not recommended.

#### 10. Retire raw compatibility surfaces after consumers move

After all consumers use v2, deprecate then remove public plugin-instance send fallbacks and raw `dryRunMessage()`. Keep the legacy protocol alias longer because already-delivered notifications may still contain it.

#### 11. Add an explicit settings recovery workflow

Future-version/root-corrupt documents deliberately remain read-only to prevent destructive overwrite. Add a user-confirmed export/reset flow that first preserves the raw document for diagnosis, then writes known defaults. Never silently reset on load.

#### 12. Investigate genuine cancellation only if Obsidian adds support

Four permanently hung `requestUrl` calls block the queue. The current API has no supported timeout/AbortSignal. A local `Promise.race` would only stop waiting while the request continued and could create duplicates. Monitor the official API; do not simulate cancellation.

## Regression matrix for acceptance

| Area | Required evidence |
| --- | --- |
| Valid existing target | Remains enabled and sends through the same URL/topic/priority |
| Unsupported saved target | Starts disabled, shows migration warning, never redirects to public ntfy.sh |
| Draft edit | Applied route remains active; draft never leaks into a send |
| Apply | Inputs/Discard/hide cannot race; failure preserves active route and draft |
| Enable/disable | No activation before save; pending disable blocks and cancels queued work; failed disable restores prior settings without resurrecting canceled queue entries |
| Queue ownership | Two callers get their own success/failure; later work survives an earlier failure |
| Unload/reload | Queued work rejects immediately; late reads/saves do not reinstall; older cached APIs remain invalid after reload |
| Delivery receipt | Only matching message receipt accepts; wrong topic/event/ID is unconfirmed |
| HTTP failure | Structured ntfy 401/413/429 rejected; redirects/unstructured 4xx/408/5xx/transport exceptions unconfirmed |
| Concurrency | First four active, fifth waits, queued work closes on unload and invalidates on route change |
| Privacy | No body/title/topic/credential/raw response/note path in Notice/logs; callback/provider disclosure tested separately |
| Composer | Single instance, labeled, keyboard submit, no duplicate click, close outcome reported |
| Mobile | Namespaced standalone layout works without GCM CSS/JS injection |
| Consumers | Partial batches retain per-item accepted/rejected/unconfirmed state without blind retry |

## Feasibility and release posture

The technical work is feasible, but “100% guaranteed” is not a responsible claim for networked multi-plugin software. The branch can make state transitions deterministic and failures honest; it cannot make the network or ntfy exact-once.

The remaining P0 consumer/alignment work is bounded and should be completed before an acceptance build. Authentication and true cross-restart reconciliation are separate features and should not block the core stability merge unless protected topics or automatic retry are required now.

When accepted, merge/reconcile into stable source, choose the appropriate semantic version based on the final cross-plugin compatibility decision, rerun every affected repository's tests/builds, perform test-vault UI QA, publish private GitHub releases, and let BRAT pull them. Production direct deployment remains unnecessary and unauthorized.
