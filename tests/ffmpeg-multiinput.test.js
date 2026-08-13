const { FFmpeg } = window.FFmpegWASM;

const genName = (name) => `[multi-input][${FFMPEG_TYPE}] ${name}`;

// Multi-input filtergraph probe. On the 7.x/8.x MT cores these deadlock in
// wasm (FORK.md pins this on the thread-per-stage scheduler). The 5.1 ST core
// is pre-scheduler (classic sequential transcode_step loop), so this suite is
// the experiment that decides whether the limitation is scheduler-specific or
// a wasm limitation independent of the frontend: passing here means the
// FORK.md root cause holds and client-side watermark/transitions are back on
// the table for the ST core; hanging here (mocha timeout) means the stated
// root cause is wrong and needs re-investigation either way.
let ffmpeg;

before(async () => {
  ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: CORE_URL,
    thread: FFMPEG_TYPE === "mt",
  });
  await ffmpeg.writeFile("video.mp4", b64ToUint8Array(VIDEO_1S_MP4));
  // Synthesize the watermark in-core: first frame of the fixture as PNG.
  const ret = await ffmpeg.exec([
    "-i", "video.mp4", "-frames:v", "1", "-vf", "scale=64:-1", "wm.png",
  ]);
  if (ret !== 0) throw new Error(`fixture PNG synthesis failed (ret=${ret})`);
});

after(() => {
  if (ffmpeg) ffmpeg.terminate();
});

describe(genName("overlay (video + PNG watermark)"), function () {
  it("should overlay a PNG onto video", async () => {
    const ret = await ffmpeg.exec([
      "-i", "video.mp4", "-i", "wm.png",
      "-filter_complex", "overlay=8:8",
      "overlaid.mp4",
    ]);
    expect(ret).to.equal(0);
    const out = await ffmpeg.readFile("overlaid.mp4");
    expect(out.length).to.be.greaterThan(0);
  });
});

describe(genName("xfade (two video inputs)"), function () {
  it("should cross-fade two clips", async () => {
    const ret = await ffmpeg.exec([
      "-i", "video.mp4", "-i", "video.mp4",
      "-filter_complex", "[0:v][1:v]xfade=transition=fade:duration=0.3:offset=0.5",
      "xfaded.mp4",
    ]);
    expect(ret).to.equal(0);
    const out = await ffmpeg.readFile("xfaded.mp4");
    expect(out.length).to.be.greaterThan(0);
  });
});

describe(genName("concat filter (two video inputs)"), function () {
  it("should concat two clips via the concat filter", async () => {
    const ret = await ffmpeg.exec([
      "-i", "video.mp4", "-i", "video.mp4",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
      "concat-filter.mp4",
    ]);
    expect(ret).to.equal(0);
    const out = await ffmpeg.readFile("concat-filter.mp4");
    expect(out.length).to.be.greaterThan(0);
  });
});
