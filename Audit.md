# tps-messager — Audit

Scope
- Reviewed files: [`src/main.ts`](/Users/zachtisherman/TishOS%20v0.1/.obsidian/plugins/tps-messager/src/main.ts), [`src/tps-contracts.ts`](/Users/zachtisherman/TishOS%20v0.1/.obsidian/plugins/tps-messager/src/tps-contracts.ts), [`src/ntfy-request.ts`](/Users/zachtisherman/TishOS%20v0.1/.obsidian/plugins/tps-messager/src/ntfy-request.ts), [`src/core/type-guards.ts`](/Users/zachtisherman/TishOS%20v0.1/.obsidian/plugins/tps-messager/src/core/type-guards.ts).

Where issues are
- High: URL/protocol handler input parsing is tolerant with limited schema validation; malformed or partially malicious callback payloads can enter the dispatch path.
- High: Callback dispatch does not carry a stable request identifier and lacks a single envelope contract, reducing traceability across plugin boundaries.
- Medium: Error responses are not normalized; downstream callers cannot reliably distinguish malformed payload from unsupported action.
- Medium: Version compatibility is handled largely by in-tree assumptions and implicit path matching.
- Low: Contract constants and command IDs are duplicated rather than shared with callers.

User interaction risks
- Users may click protocol links that fail silently or route to a fallback action when only one parameter is missing.
- Debugging broken integration calls is difficult because failures are not correlated across sender and receiver.
- Upgrades can break old callers without clear migration path.

Improvements
- Add explicit runtime schema parsing for incoming protocol parameters before any side effect.
- Introduce and require a strict envelope shape: `requestId`, `action`, `version`, `payload`.
- Return deterministic error codes from handler functions and convert failures to user-facing, actionable notices.
- Add allowlist checks for callback sources and command namespaces.
- Introduce one command registry file used by sender and receiver.

How to simplify/centralize
- Create a shared protocol package for all TPS link-based commands:
  - constant registry
  - request parser/serializer
  - shared validation and versioning
- Add shared logging fields (`requestId`, `caller`, `target`, `result`) to make cross-plugin flows diagnosable in one place.
