# MT-only FFmpeg core (no single-threaded build on 8.x)

- **Status**: Accepted
- **Date**: 2026-07-07

## Context

This fork moved FFmpeg from 5.1.4 to 8.1.2, whose `fftools` CLI frontend runs a
thread-per-stage scheduler (`thread_queue` on `libavutil/container_fifo`) and is
thread-based by design — there is no viable single-threaded 8.1.2 core. Upstream
ffmpeg.wasm publishes both a single-threaded `@ffmpeg/core` and a multi-threaded
`@ffmpeg/core-mt`, and on 5.1.4 the single-threaded core is a valid way to avoid the
cross-origin isolation the MT core needs (COOP/COEP + `SharedArrayBuffer`). A proposal
surfaced to "switch to the single-threaded core" to shed that isolation requirement; it
conflates threading (a wasm build detail) with cross-origin isolation (a deployment
header posture), and the upstream heuristic does not carry to 8.x.

## Decision

Ship an **MT-only** core (`@ffmpeg/core-mt`) that requires cross-origin isolation, and
treat isolation as an infrastructure/header concern solved at the serving layer. Reject
adopting a single-threaded core, for reasons that are non-obvious and worth recording:

- **No single-threaded 8.x core exists here.** A `build-st`/`prd-st` target survives in
  the `Makefile` (inherited from upstream; `FFMPEG_ST` gates
  `--disable-pthreads --disable-w32threads --disable-os2threads` in `build/ffmpeg.sh`),
  but CI only runs `prd-mt` and `prd-mt-slim` (`.github/workflows/CI.yml`), `packages/core/dist`
  is empty, and no ST core is built or shipped.
- **"Switch to ST" means "downgrade the engine to 5.1.4."** The only real single-threaded
  `@ffmpeg/core` is upstream's 0.12.10 = FFmpeg 5.1.4 (what `tests/test-helper-st.js`
  resolves to). Taking it re-inherits the CVEs this fork patched (zlib 1.3.1, pinned
  x264/lame SHAs) and discards the lean/slim codec allowlist and characterized capability
  map.
- **ST does not fix the deadlock people hope it fixes.** Multi-input filtergraphs
  (`overlay`, `xfade`, concat *filter*) deadlock as a wasm-scheduler limitation, not a
  thread-count one (confirmed on 8.1.2 in `FORK.md`). Single-threading changes nothing here.
- **ST is materially slower** (~2×+ on the browser re-encode path per upstream perf docs),
  which is the already-slow part of the clipping workflow.

Cross-origin isolation is handled where it belongs: set COOP/COEP at the serving layer,
prefer `credentialless` when the page loads cross-origin source video, and keep clipping
on a dedicated isolated route to bound COEP `require-corp`'s effect on third-party
subresources. `live-clipping-poc` already ships `COOP: same-origin` + `COEP: credentialless`.

## Consequences

### Pros
- Keeps the hardened 8.1.2 engine — CVE fixes, pinned supply-chain SHAs, and the slim
  (`--disable-everything` + allowlist) codec set.
- Single ABI and test surface: MT-only, gated by `tests/ffmpeg-slim.test.js` (and the MT
  suite), with no second single-threaded path to maintain across two FFmpeg majors.
- The isolation requirement is already satisfied in production, so no consumer-facing
  regression.

### Cons
- Consumers must serve COOP/COEP and run cross-origin isolated to load the core.
- COEP `require-corp` blocks cross-origin subresources (third-party images, ads, analytics,
  embeds) unless they send CORP/CORS; `credentialless` relaxes this for no-CORS resources
  at the cost of un-credentialed fetches (signed-cookie CDN paths won't authenticate).
- No single-threaded fallback exists for a surface that genuinely cannot be isolated; such
  a case must run the operation server-side rather than downgrade the core.

## Links
- `FORK.md` — MT-only rationale, the 8.x threaded-frontend requirement, required headers,
  and the multi-input filtergraph deadlock capability map.
- `build/ffmpeg.sh` (`FFMPEG_ST` → `--disable-pthreads` gating), `Makefile`
  (`build-st`/`build-mt`/`build-mt-slim` targets), `.github/workflows/CI.yml`
  (`prd-mt`/`prd-mt-slim` only).
- `tests/test-helper-st.js` / `packages/core` — the single-threaded path resolves to
  upstream `@ffmpeg/core@0.12.10` (FFmpeg 5.1.4).
