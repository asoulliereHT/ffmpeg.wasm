const { FFmpeg } = window.FFmpegWASM;

const genName = (name) => `[perf][${FFMPEG_TYPE}] ${name}`;

// Wall-clock probe for the engine decision: 1080p60 re-encode on the ST 5.1.10
// core vs the MT 8.1.2 core (default threads and -threads 1). Timings go to
// the console as "PERF <label>: <seconds>s" — they are data for the vetting
// record, not assertions; only exit codes are asserted.
let ffmpeg;

before(async function () {
  ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: CORE_URL,
    thread: FFMPEG_TYPE === "mt",
  });
  const res = await fetch("../testdata/video-1080p-60fps-2s.mp4");
  if (!res.ok) {
    throw new Error(
      `fixture fetch failed (${res.status}): is the testdata submodule checked out?`
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  await ffmpeg.writeFile("in.mp4", buf);
});

after(() => {
  if (ffmpeg) ffmpeg.terminate();
});

const timedEncode = async (label, args) => {
  const t0 = performance.now();
  const ret = await ffmpeg.exec(args);
  const dt = ((performance.now() - t0) / 1000).toFixed(2);
  console.log(`PERF ${label}: ${dt}s (ret=${ret})`);
  expect(ret).to.equal(0);
};

describe(genName("1080p60 2s x264 re-encode"), function () {
  it("default threads", async () => {
    await timedEncode(`${FFMPEG_TYPE} default-threads`, [
      "-i", "in.mp4", "-c:v", "libx264", "-preset", "fast", "-an", "out-default.mp4",
    ]);
  });

  if (FFMPEG_TYPE === "mt") {
    // -threads is positional: before -i caps the decoder, before the output
    // caps the encoder. Both are capped to mirror the consumer's workaround.
    it("-threads 1 (decoder + encoder)", async () => {
      await timedEncode("mt threads-1", [
        "-threads", "1", "-i", "in.mp4",
        "-c:v", "libx264", "-preset", "fast", "-an", "-threads", "1", "out-t1.mp4",
      ]);
    });
  }
});
