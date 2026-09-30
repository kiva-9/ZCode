# Computer Use plugin (model-facing SDK shell)

The official `computer-use` plugin shell: the model-facing skill, the
argument-shape reference, and the `scripts/computer-use-client.mjs` SDK bootstrap
that binds `agent.computerUse` inside a fresh `node_repl` Worker. There is no
build step and no `node_modules`, and the package deliberately ships no
`package.json` so the directory stays outside the pnpm workspace. The `node_repl`
MCP runtime that runs the model's JavaScript is provided by
`@zcode/node-repl-host`; the desktop-control runtime that answers these methods
is `@zcode/zcode-cua`. This package defines the model-facing contract only — it
is not a runtime and must never install, vendor, or substitute one.

## Contents

| File | Role |
| --- | --- |
| `.zcode-plugin/plugin.json` | Manifest: `computer-use` 0.6.1, author Z.ai, `"license": "MIT"`, skills root `skills`. |
| `skills/computer-use/SKILL.md` | Resident skill (332 lines): bootstrap every `js` cell with `setupComputerUseRuntime()`, the accessibility-first observe → act loop, the `agent.computerUse` API, the low-level tool surface, error and stop rules. |
| `docs/computer-use.md` | On-demand reference (467 lines) via `agent.documentation.get("computer-use")`: argument shapes and response fields the skill page does not spell out. |
| `scripts/computer-use-client.mjs` | SDK bootstrap (1211 lines): `setupComputerUseRuntime({ globals })` binds `agent.computerUse` to bridge `Symbol.for("zcode.node-repl.computer-use-bridge")`; exports `ComputerUseError`, `COMPUTER_METHOD_NAMES`, `PLATFORM_EXCLUDED_METHODS`, `normalizeKeyChord`. |

## Provenance

All four files were copied verbatim (plus two documented additions: `agent.computerUse.capabilities()` / `diagnostics()` and the SKILL self-check section, both read-only) from the checkout below. The upstream
original was itself vendored from the official distribution package
`zcode-cua-plugin` 0.6.1.

| File | Source repository | Original path | License note | Modification status |
| --- | --- | --- | --- | --- |
| `.zcode-plugin/plugin.json` | `Zcode-CE/Zcode-CE` @ `f16bbc7f13b1201d4915702f76c2d4b1e16f7696` | `apps/zcode-cli/packages/zcode-cua-plugin/.zcode-plugin/plugin.json` | Upstream manifest declares `"license": "MIT"` with author Z.ai. This repository is the same upstream project (zai-org/ZCode, Apache-2.0 at root); the MIT attribution is preserved, not rewritten. | Copied verbatim |
| `skills/computer-use/SKILL.md` | `Zcode-CE/Zcode-CE` @ `f16bbc7f13b1201d4915702f76c2d4b1e16f7696` | `apps/zcode-cli/packages/zcode-cua-plugin/skills/computer-use/SKILL.md` | Same MIT attribution, preserved as declared. | Copied verbatim |
| `docs/computer-use.md` | `Zcode-CE/Zcode-CE` @ `f16bbc7f13b1201d4915702f76c2d4b1e16f7696` | `apps/zcode-cli/packages/zcode-cua-plugin/docs/computer-use.md` | Same MIT attribution, preserved as declared. | Copied verbatim |
| `scripts/computer-use-client.mjs` | `Zcode-CE/Zcode-CE` @ `f16bbc7f13b1201d4915702f76c2d4b1e16f7696` | `apps/zcode-cli/packages/zcode-cua-plugin/scripts/computer-use-client.mjs` | Same MIT attribution, preserved as declared. | Copied verbatim |

Version skew is intentional: the vendored distribution's plugin manifest version
(0.6.1) and the `official-plugin-definitions.ts` runtime version (0.6.3) differ —
the manifest tracks the vendored distribution, the definition tracks the upstream
`zcode-cua` runtime that plugin UI, cache paths, and marketplace entries align to.

## Consumer wiring

One source of truth per integration point; do not add others.

- `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` — `computer-use` plugin definition: `hostMcpServerNames`, `rootCandidates`, and `requiredSeedPaths` (`docs/computer-use.md`, `scripts/computer-use-client.mjs`, `skills/computer-use/SKILL.md`).
- `apps/zcode-cli/packages/bootstrap/src/app/built-in-node-repl.ts` — injects `ZCODE_CUA_PLUGIN_ROOT` into the bundled `node_repl` MCP runtime, and only when the plugin is enabled.
- `apps/zcode-cli/packages/node-repl-host/src/server.ts` — resolves the Computer Use documentation root from `ZCODE_CUA_PLUGIN_ROOT`, keeping CUA and Browser Use docs isolated from the shared host root.
- `apps/zcode-cli/packages/node-repl-host/src/cua-bridge.ts` — defines bridge symbol `zcode.node-repl.computer-use-bridge`, which `scripts/computer-use-client.mjs` looks up.

## Do not edit in two places

Skill, docs reference, and client bootstrap are the model-facing half of one
contract. Any change to it must also be reflected in `packages/zcode-cua` — the
runtime that answers these methods — and its regression tests under
`packages/zcode-cua/test/`. Editing this package alone yields a contract no
runtime implements: documented argument shapes, response fields, or error types
that no runtime version honors. Keep both halves in the same change, and keep the
provenance and version-skew notes above in sync when either side moves.
