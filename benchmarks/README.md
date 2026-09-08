# Benchmarks

`npm run bench`

Architecture spec RULE 31 and §25: *"Do not optimize blindly. Measure first."*

---

## What these measure

**Scaling**, not absolute milliseconds.

An absolute number from a CI runner depends on the machine, the other jobs on
it, and the JIT's mood. Asserting one turns a busy minute on a shared runner
into a failed build, and the usual response is to loosen the threshold until it
never fails — and never means anything either.

A scaling exponent is a property of the **algorithm**. Double the input: if the
time roughly doubles it is O(n); if it quadruples it is O(n²). That holds on a
slow runner and a fast laptop alike.

They are deliberately **not** part of `npm test`. A timing suite on a shared
runner is noise, and a noisy suite stops being read.

---

## What they found

The conformance audit named two suspects. Measuring settled both — one was
innocent, one was guilty.

### `unionAll` was quadratic — confirmed, and fixed

The obvious loop `accumulated = union(accumulated, next)` looks linear and is
not. The accumulator **grows**: unioning two adjacent parcels keeps the
collinear vertices where the shared seam was, so after *k* merges the shape
carries roughly 2*k* vertices, and each further union re-sweeps all of them.

Fixed with a **balanced reduction** — union neighbours, then pairs of pairs,
like a merge tree — so both operands stay about the same size at every step.
Union is associative, so only the *order* of the same merges changed; all 121
geometry tests pass unchanged.

| Pieces | Before | After |
|---|---|---|
| 32 parcels | 0.15 ms | 0.31 ms |
| 64 parcels | 0.64 ms | 0.75 ms |
| 128 parcels | 2.69 ms | **1.53 ms** |
| **growth per doubling** | **≈4.2×** (O(n²)) | **≈2.0×** (near-linear) |

Small inputs are marginally *slower* — the tree does a little more bookkeeping,
and below about 64 pieces the accumulator never grows enough to matter. That
trade is worth taking: the crossover is early, and past it the old curve runs
away.

### Buffering inherited it — 7.7× faster

A buffer sweeps one capsule per segment and folds them, so it was paying the
quadratic cost once per vertex. Nothing in `buffer.ts` changed.

| Traverse | Before | After | |
|---|---|---|---|
| 64 vertices | 17.9 ms | 7.2 ms | 2.5× |
| 128 vertices | 61.0 ms | 16.4 ms | 3.7× |
| 256 vertices | 281.6 ms | **36.6 ms** | **7.7×** |
| 128 at 1 mm tolerance | 374 ms | **124 ms** | 3.0× |
| **growth per doubling** | ≈4.6× | **≈2.25×** | |

### The boolean sweep was innocent

`StatusLine` is a sorted array with `splice` insertion, O(n) each, so the sweep
is O(n²) in the worst case and the audit flagged it. On real boundaries it is
not the worst case:

| Ring size | Time | |
|---|---|---|
| 256 vertices | 0.50 ms | |
| 512 vertices | 1.07 ms | 2.1× |
| 1024 vertices | 2.19 ms | 2.05× |

Near-linear. A balanced tree would be the textbook fix and would not pay for
itself here — for the parcel and boundary work this tool does, an array is
faster in practice than a tree with better asymptotics. **Left alone, on
evidence.** That is the whole point of measuring first.

### The control

Andrew's monotone chain is provably O(n log n), and reads that way:

| Points | Time | |
|---|---|---|
| 10,000 | 3.44 ms | |
| 20,000 | 7.29 ms | 2.1× |
| 40,000 | 16.05 ms | 2.2× |

It is here so the other numbers can be read against something known. If the hull
scales cleanly on a given runner and a sweep does not, the difference is the
algorithm rather than the machine.

---

## Reading a run

```
· dissolve 128 adjacent parcels   654.79 hz   mean 1.53 ms   ±1.17%   328 samples
```

`hz` is operations per second — **higher is better**. Compare the *ratios*
between sizes in one run, never a number from one machine against another.

`rme` above about 10% means the run was noisy; re-run before drawing a
conclusion from it.

---

## Adding one

Put it in `benchmarks/*.bench.ts`, use `bench()` from `vitest`, and build the
fixture **outside** the benchmarked function — otherwise the measurement
includes constructing the input, which is usually the larger cost.

Always include at least three sizes. One number tells you nothing; three tell
you the shape of the curve, which is the only thing that survives moving to a
different machine.
