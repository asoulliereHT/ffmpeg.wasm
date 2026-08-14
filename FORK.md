# FloSports fork — FFmpeg 8.1.2 (MT) + 5.1.10 (ST)

This is a hardened fork of ffmpeg.wasm (upstream is on 5.1.4). The primary
cores are **FFmpeg 8.1.2, MT-only**; the branch also builds **ST 5.1.10**
cores for surfaces that cannot serve cross-origin isolation headers (see the
MT-only bullet below). It targets an internal **video clipping** use case:
cut, transcode, and losslessly stitch clips in the browser. Built for
**vendoring** (not npm-published).

## What changed vs upstream
- **FFmpeg 5.1.4 → 8.1.2**; **Emscripten 3.1.40 → 6.0.2** (digest-pinned, native arm64 + amd64).
- **Lean codec set**: kept x264, vpx, opus, mp3lame, webp, zimg + native AAC.
  Dropped x265, theora, vorbis/ogg, and the subtitle/text stack (libass, freetype,
  fribidi, harfbuzz) — no subtitles/text overlays. Core is **~25.3 MB** (was 32.7).
- **MT-only on 8.x.** fftools requires threads from FFmpeg **6.0** onward
  (`ffmpeg_deps` gains `threads`; `pthread_create` is unconditional in
  demux/mux), so no single-threaded core exists past the 5.1 branch. The MT
  core requires cross-origin isolation (see Headers below). This branch also
  builds **ST 5.1.10** cores from the same hardened dep pins — they need **no**
  isolation headers and support multi-input filtergraphs (see capability map):
  `make build-st` → `packages/core` (full, ~22.8 MB) and `make build-st-copy`
  → `packages/core-copy` (**2.6 MB**, stream-copy only: mov/mpegts/concat in,
  mp4 out, no encoders — sized to clipping-tool-ui's two `-c copy` commands).
  Vetting evidence is in-repo: `tests/ffmpeg-cliptool.test.js` (the two
  consumer commands verbatim, ST/copy/MT lanes),
  `tests/ffmpeg-multiinput.test.js` (the filtergraph probe), and
  `tests/ffmpeg-perf.test.js` (cross-engine timings). The standing decision
  this re-opens is `docs/adr/0001-mt-only-core.md`.
- Supply chain: floating lib branches (x264, lame) pinned to commit SHAs; zlib bumped
  to **1.3.1** (CVE-2018-25032, CVE-2022-37434) from upstream.
- **8.x frontend port**: the vendored `src/fftools` frontend was re-based onto 8.1.2.
  vs 7.1: `objpool.c` was dropped (`thread_queue` now uses `libavutil/container_fifo`),
  ffprobe's writers moved into `textformat/*`, and `libpostproc` is no longer linked.
  `graph/graphprint.c` (the `-print_graphs` diagnostic) is a fork **no-op stub** —
  upstream needs the `resources/resman` resource-bundling pipeline, which this
  hand-rolled build doesn't reproduce; the option parses but produces no output.

## Release variants

Each release ships two MT cores and one ST core. Pick the smallest that
covers your pipeline. (The **full** ST 5.1.10 core stays a local `make prd`
build — CI builds it as the cliptool-suite synthesizer but does not attach
it to releases.)

| Variant     | Build | Wasm size | Vendor asset | Use when |
|-------------|-------|-----------|--------------|----------|
| **full**    | all lean codecs enabled (x264, vpx, opus, mp3lame, webp, zimg + zlib + native AAC) | ~25.3 MB | `ffmpeg-core-mt-<tag>.tgz` | general use / unknown codec needs |
| **slim**    | `--disable-everything` + an allowlist for exactly one pipeline: H.264/AAC over mp4/ts | **~6 MB** | `ffmpeg-core-mt-slim-<tag>.tgz` | H.264+AAC only: stream-copy clip/concat, single-input x264 re-encode, re-encode stitch |
| **st-copy** | ST 5.1.10, `--disable-everything` + stream-copy allowlist (mov/mpegts/concat in, mp4 out, no encoders) | **~2.6 MB** | `ffmpeg-core-st-copy-<tag>.tgz` (from v0.15.1) | `-c copy` clip export + stitch with **no COOP/COEP** requirement |

All variants are identical at the wrapper/ABI level — same `_ffmpeg`/`_ffprobe`
ABI, same postMessage contract. The MT cores share the 8.1.2 scheduler
frontend; st-copy runs the 5.1 sequential frontend and loads with
`thread: false` and no isolation headers. Only the compiled-in component set
differs otherwise.

**Slim is `--disable-everything` + an allowlist** (see `build/ffmpeg.sh`): it
strips ~all of FFmpeg's ~400 decoders / 350 demuxers / 130 filters and re-enables
only the H.264/AAC + mp4/ts + concat components its consumer uses. That's where
the 25 MB → 6 MB drop comes from — not the external codec libs (dropping those
alone only saved ~3 MB). The trade-off is precision: slim **hangs** (does not
error cleanly) if asked for a component it wasn't built with, so it must only be
driven with its supported operations. Its gate is `tests/ffmpeg-slim.test.js`
(run via `npm run test:browser:ffmpeg:slim`), not the generic suite (whose
mp4→avi transcode needs the avi muxer/mpeg4 encoder slim drops).

`live-clipping-poc` vendors **slim**.

## Capability map (what works in the browser)

The dividing line is **single-input vs multi-input filtergraph**, not copy vs
re-encode:

| Operation | Status |
|-----------|--------|
| Cut / trim (`-ss`/`-t` `-c copy`) | ✅ |
| Lossless concat (`-f concat -c copy`) | ✅ |
| Single-input re-encode (`-c:v libx264 -c:a aac`) | ✅ |
| Re-encode **stitch** via concat *demuxer* (`-f concat -i list -c:v libx264 …`) | ✅ single input → one out |
| **Multi-input filtergraph** — `overlay` (watermark), `xfade` (softened transitions), concat *filter* | ❌ deadlocks on **MT 8.x** — ✅ works on **ST 5.1** |

The multi-input deadlock is a scheduler-in-wasm limitation of the 7.x/8.x
thread-based frontend (not thread-count), confirmed on 8.1.2 — and confirmed
**engine-specific** on 2026-08-13: the same `overlay`/`xfade`/concat-filter
graphs complete in milliseconds on the pre-scheduler ST 5.1.10 core
(`tests/ffmpeg-multiinput.test.js`, `npm run test:st:probe`). The concat
*demuxer* feeds the encoder as one stream (works everywhere); the concat
*filter* / `xfade` / `overlay` open several inputs into one graph, which the
8.x scheduler cannot drain in wasm. **Design consequence, per engine:** on the
MT 8.x core, do clip + stitch in the browser and produce watermarked output and
cross-faded transitions server-side; on the ST 5.1.10 core, all of the above
run client-side.

## Required headers (MT / SharedArrayBuffer)
Serve the app's HTML with:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp   # or: credentialless (if loading cross-origin video)
```
Without these, the MT core will not load.

## Usage (single long-lived instance)
Create **one** instance, load once, reuse it for every operation (creating/terminating
many instances leaks pthread workers under emsdk 6.0.2):
```js
import { FFmpeg } from "@ffmpeg/ffmpeg";
const ffmpeg = new FFmpeg();
await ffmpeg.load({ coreURL: "/assets/ffmpeg-core.js", thread: true }); // your vendored path
await ffmpeg.writeFile("in.mp4", data);
await ffmpeg.exec(["-ss", "1.5", "-to", "4.0", "-i", "in.mp4", "-c", "copy", "out.mp4"]);
const out = await ffmpeg.readFile("out.mp4");
```

## Build
```
make prd-mt            # builds packages/core-mt/dist (native; requires Docker)
npm ci && npm run build# builds the @ffmpeg/ffmpeg + @ffmpeg/util JS wrappers
npm test               # 12/12 MT suite (headless Chrome)
```
Apple Silicon note: builds run native arm64 on emsdk 6.0.2. `build/ffmpeg.sh` caps
`make -j` (FFMPEG_JOBS, default 4) to avoid OOM; a ~24 GiB Docker VM is recommended.

## Vendoring from a targeted release
Push a `v*` tag → CI builds and attaches `ffmpeg-core-mt-<tag>.tgz` (the core:
`ffmpeg-core.js`, `.wasm`, `.worker.js`) and `ffmpeg-wasm-<tag>.tgz` (the wrapper)
to the GitHub Release. Vendor those into the app and serve them same-origin.
