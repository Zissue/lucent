# AGENTS.md

## Project

Lucent is a third-party toolkit for enhancing gameplay experiences in AdventureQuest Worlds (AQW).

## Priorities

Preserve correctness, reliability, and predictable behavior under load and during failures. Among designs that satisfy those requirements, prefer lower runtime and resource cost.

Prefer maintainable designs over short-term convenience. Extract shared logic when multiple call sites implement the same stable behavior and the abstraction improves ownership or testing. Do not generalize for speculative reuse.

Do not implement material changes outside the requested scope without approval.

## Validation

Run the smallest checks that prove the change works, including relevant focused tests.

Do not run repository-wide formatting, lint, typecheck, or test commands unless requested. CI owns the full suite.

## Package Roles

- `app/src/main`: Electron main process and native application services.
- `app/src/renderer`: SolidJS applications and client-side behavior.
- `app/src/shared`: IPC contracts and code shared between Electron processes.
- `packages/core`: Shared application schemas and domain types.
- `packages/game`: AQW game-domain models and types.
- `packages/ui`: Reusable SolidJS components, styles, and design tokens.
- `crates/bridge`: The Ruffle-free view of a running game that the rest of native Lucent uses.
- `crates/ruffle-host`: Runs Ruffle on a player thread and owns the game connection.
- `crates/js`: Embeds V8: one thread per isolate, its event loop, host ops, and the watchdog.
- `crates/scripting`: Runs each account's game runtime and the shared hub in V8, and serves their host ops.
- `crates/app`: The `lucent` GPUI app: the account manager and tabbed game windows.
- `app/src/native`: The TypeScript entries for the account and hub runtimes. `pnpm native:runtime` bundles them into `assets/native/`.

## Vendored Repositories

Treat `.repos/effect-smol/` as read-only reference material. Do not edit or import from it unless explicitly requested.

- When writing Effect (EffectTS) code, read `.repos/effect-smol/LLMS.md` first, then inspect `.repos/effect-smol/` for idiomatic APIs, tests, module structure, and patterns.
