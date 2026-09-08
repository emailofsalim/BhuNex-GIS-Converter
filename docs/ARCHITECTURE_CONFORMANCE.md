# Conformance with the Chrome + Edge architecture specification

An audit of this codebase against every rule in
[`CHROME_EDGE_ARCHITECTURE_SPEC.txt`](CHROME_EDGE_ARCHITECTURE_SPEC.txt).

The specification's own RULE 36 and §43 forbid rewriting stable architecture
without a technical reason, so this is an audit and a gap list — **not** a plan
to reshape a working, tested system into the document's example folder names.
Where this project's layout differs from the illustrative tree in §2, the
difference is naming, not structure, and the mapping is given below.

Every "Met" claim below was checked against the code, not assumed.

---

## Summary

| | Rules |
|---|---|
| **Met** | 34 of 40 |
| **Met, different naming** | 2 (RULE 04 output path, §2 folder names) |
| **Gap** | 4 — RULE 15, RULE 27/28, RULE 31, RULE 32 |

The four gaps are tracked in `BUILD_STATE.md` and listed at the end.

---

## One extension, one build (RULES 01–07)

| Rule | State | Evidence |
|---|---|---|
| 01 One extension for both browsers | **Met** | A single package; Chrome and Edge run the same Chromium extension system. |
| 02 One shared codebase | **Met** | `extension/src/` — no per-browser source. |
| 03 One Manifest V3 file | **Met** | `extension/manifest.json`, `manifest_version: 3`. No `manifest/chrome/`, no `manifest/edge/`. |
| 04 One production build | **Met, different path** | `dist/`, not `dist/universal/`. The rule's substance — one output, not `dist/chrome` + `dist/edge` — holds. Renaming would break the release workflow, the packager and both validators for no functional gain. |
| 05 No duplicate applications | **Met** | Verified: no browser-conditional source files. |
| 06 Standard WebExtension APIs | **Met** | `chrome.storage`, `chrome.sidePanel`, `chrome.downloads`, `chrome.runtime` — all Chromium-standard. |
| 07 Browser differences behind adapters | **Met** | `src/adapters/native-messaging/` is the only browser-integration boundary, and it degrades when the permission is absent. |

**The same build is what ships.** `npm run package` produces one ZIP;
`scripts/verify-package.mjs` asserts it loads unpacked in both browsers, and the
release workflow attaches exactly that artefact.

---

## Layer separation (RULES 08–13, 41)

| Rule | State | Evidence |
|---|---|---|
| 08 Business logic in Core | **Met** | Readers, writers, CRS, QA and the pipeline are all under `src/core`, `src/crs`, `src/engines`, `src/qa`. |
| 09/10 Maths and algorithms independent of UI | **Met** | Grepped: no `document.`, `window.` or `HTMLElement` reference in `core/`, `crs/`, `engines/` or `qa/`. The only matches are a local parameter named `document` in the XML parser and MIME strings. |
| 11 No heavy computation in the popup | **Met** | `src/popup/` opens the workspace and reports status. |
| 12 No heavy computation in content scripts | **Met** | There are no content scripts. This extension processes local files and requests no host permissions. |
| 13 Service Worker is not the computation engine | **Met** | `src/background/service-worker.ts` is **52 lines**: lifecycle, the side panel, and the keyboard command. |
| 41 Clean dependency direction | **Met** | Core imports no UI. Workers import no DOM — which is why `engines/xml.ts` is a hand-written parser rather than `DOMParser`, an API that does not exist in a Web Worker. |

### Folder mapping

The specification's §2 tree is illustrative. This project's equivalent:

| Specification | This project |
|---|---|
| `src/core/engine/` | `src/core/pipeline.ts` — the one dispatch point |
| `src/core/math/` | `src/crs/` (geodesy), `src/core/measure.ts`, `src/core/precision.ts` |
| `src/core/algorithms/`, `src/core/geometry/` | `src/core/geometry.ts`, `polygon-boolean.ts`, `buffer.ts`, `geometry-ops.ts`, `src/qa/` |
| `src/parsers/` | `src/core/expression.ts` |
| `src/formats/` | `src/engines/{vector,cad,raster,pointcloud,archives}/` |
| `src/storage/` | `src/state/store.ts` |
| `src/types/` | Types live beside the modules that own them, exported explicitly |

---

## Computation (RULES 14–17, 26)

| Rule | State | Evidence |
|---|---|---|
| 14 Web Workers for expensive work | **Met** | `src/workers/convert.worker.ts`; anything over 2 MB goes off-thread. |
| 15 Worker pools for parallel work | **GAP** | See below. |
| 16 WebAssembly where it helps | **Met by decision** | No WASM today. `wasm-unsafe-eval` is in the CSP so a decoder can be added; the specification says not to use WASM merely for complexity. |
| 17 Memory efficiency | **Met** | `estimatePeakBytes` / `preflight` refuse a job that would exhaust memory, with a message saying what to do instead. Buffers are transferred, not copied, across the worker boundary. |
| 26 Chunking / streaming | **Partly met** | Archives expand entry by entry and point clouds decimate on read. Vector readers load the whole file, which is documented per format. |

---

## Numerical correctness (RULES 18–21, 29, 30, §27)

| Rule | State | Evidence |
|---|---|---|
| 18 Numerical correctness | **Met** | Geodesy is anchored to published Vincenty vectors, not to the module itself. Boolean results are checked against set identities: `area(A∪B) + area(A∩B) = area(A) + area(B)`. |
| 19 No silent precision loss | **Met** | `core/precision.ts` carries an explicit policy; a coordinate is never rounded without the policy saying so. |
| 20 Explicit tolerances | **Met** | Every tolerance is a named parameter — `arcTolerance`, `snapTolerance`, `SLIVER_AREA`, buffer `tolerance`. |
| 21 Validate inputs | **Met** | Every reader treats its input as untrusted; every editing engine refuses rather than guesses. |
| 29/30 Numerical and edge-case tests | **Met** | 747 tests. The boolean suite is weighted deliberately towards degeneracies — shared edges, vertex-coincident intersections, point contact — because those are the normal case in cadastral work. |

**The CRS gate** is this project's largest numerical-correctness measure and has
no counterpart in the specification: a distance operation on a geographic CRS is
refused, because "10" would mean ten degrees — about 1,100 km — and the result
would be a plausible-looking polygon wrong by five orders of magnitude.

---

## Safety (RULES 22, 33, §29)

| Rule | State | Evidence |
|---|---|---|
| 22 Never execute user input as JavaScript | **Met** | `core/expression.ts` is a tokeniser → recursive-descent parser → AST → validation → tree-walking evaluator, exactly the §12 architecture. `eval` and `new Function` would additionally throw under Manifest V3's `script-src 'self'`, and an expression stored in a forwarded project file would otherwise be arbitrary code execution on open. Asserted by a test that greps the module's own source. |
| 33 No unnecessary dependencies | **Met** | **Zero runtime dependencies.** `npm audit --omit=dev` runs in CI and must stay clean; a runtime dependency creeping in fails the build. |
| §29 Minimum permissions | **Met** | `storage`, `unlimitedStorage`, `downloads`, `sidePanel`. No host permissions. `nativeMessaging` is optional and requested from a user gesture. |
| §30 Offline-first | **Met and enforced** | `scripts/assert-offline.mjs` fails the build if any remote script, style, font or fetch appears in `dist/`. |

---

## Contracts, storage, diagnostics (RULES 23–25, 34–37)

| Rule | State | Evidence |
|---|---|---|
| 23 Typed communication contracts | **Met** | `WorkerRequest` / `WorkerResponse`, `EditCommand`, `ConversionSettings`, `GeometryPlan` — every cross-boundary message is a named type. |
| 24 Centralised storage | **Met** | `src/state/store.ts` is the only writer. Large structured data stays in memory by design: writing a 400 MB point cloud to IndexedDB to read it straight back would be slower and would persist survey data the user did not ask to keep. |
| 25 Do not duplicate large datasets | **Met** | Worker payloads are transferred; the preview is capped at 5,000 features per layer. |
| 34 No manual edits to build output | **Met** | `dist/` is gitignored and produced only by `npm run build`. |
| 35 Do not break existing functionality | **Met** | Every change lands with tests, and CI runs all 747 on every push. |
| 36 No rewrite without technical reason | **Met** | This document exists to comply with it. |
| 37 Document architectural changes | **Met** | `docs/BUILD_STATE.md` records every session's decisions and the reasoning. |

**Error taxonomy (§28).** Every failure is a `ConversionError` carrying
`code`, `what`, `why` and `action` — a superset of the shape §28 asks for. No
operation returns a plausible wrong answer in place of a refusal.

---

## Extensibility (RULES 32, 40, §31, §32)

| Rule | State | Evidence |
|---|---|---|
| §31 New modules without rewriting | **Met** | A format is added by registering a reader and a writer; the pipeline and the UI pick it up. |
| §32 Registries | **Met** | `core/registry.ts` is the capability registry, and `docs/FORMAT_MATRIX.md` is generated from it — CI fails if they disagree, so the support table cannot drift from the truth. |
| §33 Execution strategy by workload | **Met** | Under 2 MB runs inline; larger goes to a worker. DWG stays on the main thread because native messaging is unreachable from a worker. |
| 40 New modules fit the architecture | **Met** | The five editing engines added most recently all use the same plan → apply → undo contract. |

---

## The four gaps

### 1. RULE 15 — worker pool

`AppSettings.parallelJobs` exists, and the batch runner starts that many
conversions concurrently. But `src/workers/client.ts` holds **one** module-level
`Worker`, so every concurrent job queues behind the same thread.

This is worse than not having the setting: it promises parallelism it cannot
deliver, and on an 8-core machine a 200-file batch runs at one-eighth of the
speed the control implies.

**Fix:** a pool sized from `navigator.hardwareConcurrency`, capped by
`parallelJobs`.

### 2. RULES 27, 28 — cancellation and progress

Neither exists. A conversion cannot be cancelled once started, and reports
nothing until it finishes. On a 400 MB point cloud that is minutes of a
progress bar that does not move and a button that does nothing.

**Fix:** a task ID per job, `postMessage` progress from the worker, and a
cancel that terminates the worker running that job — which the pool above makes
possible without killing the others.

### 3. RULE 31 — benchmarks

There is no `benchmarks/`. Specification §25 is explicit that performance must
be measured rather than assumed, and this project has one measured claim
(`npm run store:package` drops source maps: 1.1 MB → 303 KB) and no others.

Two things want measuring first: `StatusLine` in the boolean core is a sorted
array, O(n) per insert, and the buffer's `unionAll` folds pairwise.

**Fix:** `benchmarks/` with scaling runs for the boolean core, buffering and
whole-file conversion.

### 4. RULE 32, §42 — no giant files

`src/workspace/main.ts` is **4,609 lines**. The specification names this exact
case ("do not create one giant popup.ts"), and it is the one rule this codebase
clearly breaks.

Nothing computational lives there — it is entirely UI wiring, so RULES 09–11
still hold — but it is too large to navigate.

**Fix:** split by panel into `workspace/panels/*.ts`, leaving `main.ts` as the
wiring.

---

*Audited against the specification at `docs/CHROME_EDGE_ARCHITECTURE_SPEC.txt`.*
