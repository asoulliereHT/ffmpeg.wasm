const { FFmpeg } = window.FFmpegWASM;

const genName = (name) => `[cliptool][${FFMPEG_TYPE}] ${name}`;

// Vetting suite for the clipping-tool-ui pipeline: replicates its ONLY two
// ffmpeg invocations verbatim (src/app/core/media/clip-export/
// ffmpeg-clip-engine.ts — runClipExport and runClipStitch). The consumer has
// committed to not expanding beyond these two commands, so a core that passes
// this suite covers the entire production surface.
//
// Two-core design: SYNTH_CORE_URL (the full core) manufactures realistic
// inputs — H.264+AAC MPEG-TS segments and an .m4a audio track — because the
// copy-only core deliberately has no encoders or mpegts muxer. CORE_URL is the
// core under test; it only ever sees the two production commands.
let synth;
let ffmpeg;
const inputs = {};

before(async function () {
  this.timeout(120000);
  // Phase 1: synthesize inputs on the full core.
  synth = new FFmpeg();
  await synth.load({ coreURL: SYNTH_CORE_URL, thread: false });
  await synth.writeFile("video.mp4", b64ToUint8Array(VIDEO_1S_MP4));
  const wav = await fetch("../testdata/audio-1s.wav");
  await synth.writeFile("audio.wav", new Uint8Array(await wav.arrayBuffer()));

  // H.264+AAC TS segments — the shape the clip-export path consumes. Re-encode
  // with a short GOP (keyframe every 15 frames): the repo fixture has a single
  // keyframe at frame 0, and an input-side -ss past it under -c copy drops
  // every remaining (non-key) video packet, producing an audio-only clip.
  // Real segments carry regular keyframes; the synth must too.
  const segArgs = (out) => [
    "-i", "video.mp4", "-i", "audio.wav",
    "-c:v", "libx264", "-preset", "ultrafast",
    "-x264-params", "keyint=15:min-keyint=15:scenecut=0",
    "-c:a", "aac", "-shortest", "-f", "mpegts", out,
  ];
  let ret = await synth.exec(segArgs("seg-a.ts"));
  if (ret !== 0) throw new Error(`TS segment synthesis failed (ret=${ret})`);
  ret = await synth.exec(segArgs("seg-b.ts"));
  if (ret !== 0) throw new Error(`TS segment synthesis failed (ret=${ret})`);
  // The optional whole-frame-trimmed audio track (-f mov input in production).
  ret = await synth.exec(["-i", "audio.wav", "-c:a", "aac", "audio.m4a"]);
  if (ret !== 0) throw new Error(`m4a synthesis failed (ret=${ret})`);

  inputs.segA = await synth.readFile("seg-a.ts");
  inputs.segB = await synth.readFile("seg-b.ts");
  inputs.m4a = await synth.readFile("audio.m4a");
  synth.terminate();
  synth = null;

  // Phase 2: the core under test.
  ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: CORE_URL,
    thread: FFMPEG_TYPE === "mt",
  });
  await ffmpeg.writeFile("seg-a.ts", inputs.segA);
  await ffmpeg.writeFile("seg-b.ts", inputs.segB);
  await ffmpeg.writeFile("audio.m4a", inputs.m4a);
});

after(() => {
  if (synth) synth.terminate();
  if (ffmpeg) ffmpeg.terminate();
});

// Stream inventory via a bare `-i` (exits nonzero by design; only the log
// matters). Size-only assertions let an audio-only mp4 masquerade as a clip.
const probeStreams = async (name) => {
  const logs = [];
  const listener = ({ message }) => logs.push(message);
  ffmpeg.on("log", listener);
  await ffmpeg.exec(["-i", name]);
  ffmpeg.off("log", listener);
  return logs.filter((l) => /Stream #/.test(l)).join("\n");
};

describe(genName("clip export (runClipExport, verbatim)"), function () {
  it("stream-copies a window out of concatenated TS segments + m4a audio", async () => {
    await ffmpeg.writeFile("concat.txt", "file 'seg-a.ts'\nfile 'seg-b.ts'\n");
    const ret = await ffmpeg.exec([
      "-threads", "1",
      "-ss", "0.200",
      "-f", "concat", "-safe", "0", "-i", "concat.txt",
      "-f", "mov", "-i", "audio.m4a",
      "-t", "1.000",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      "-movflags", "+faststart",
      "output.mp4",
    ]);
    expect(ret).to.equal(0);
    const out = await ffmpeg.readFile("output.mp4");
    expect(out.length).to.be.greaterThan(0);
    const streams = await probeStreams("output.mp4");
    expect(streams).to.match(/Video: h264/);
    expect(streams).to.match(/Audio: aac/);
  });

  it("stream-copies video-only (no audioUrl path: no -map args)", async () => {
    const ret = await ffmpeg.exec([
      "-threads", "1",
      "-ss", "0.200",
      "-f", "concat", "-safe", "0", "-i", "concat.txt",
      "-t", "1.000",
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      "-movflags", "+faststart",
      "output-noaudio.mp4",
    ]);
    expect(ret).to.equal(0);
    const out = await ffmpeg.readFile("output-noaudio.mp4");
    expect(out.length).to.be.greaterThan(0);
    expect(await probeStreams("output-noaudio.mp4")).to.match(/Video: h264/);
  });
});

describe(genName("stitch (runClipStitch, verbatim)"), function () {
  it("stitches rendered members via ffconcat with ignore_editlist", async () => {
    const member = await ffmpeg.readFile("output.mp4");
    // writeFile transfers the underlying ArrayBuffer to the worker; hand each
    // write its own copy or the second one posts a detached buffer.
    await ffmpeg.writeFile("member-0.mp4", new Uint8Array(member));
    await ffmpeg.writeFile("member-1.mp4", new Uint8Array(member));
    const list = `ffconcat version 1.0\n${["member-0.mp4", "member-1.mp4"]
      .map((n) => `file '${n}'\noption ignore_editlist 1`)
      .join("\n")}\n`;
    await ffmpeg.writeFile("stitch.txt", list);
    const logs = [];
    const listener = ({ message }) => logs.push(message);
    ffmpeg.on("log", listener);
    const ret = await ffmpeg.exec([
      "-y",
      "-threads", "1",
      "-f", "concat", "-safe", "0", "-i", "stitch.txt",
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      "-fflags", "+bitexact",
      "-movflags", "+faststart+negative_cts_offsets",
      "stitched.mp4",
    ]);
    ffmpeg.off("log", listener);
    if (ret !== 0) console.log(`STITCH LOG TAIL:\n${logs.slice(-12).join("\n")}`);
    expect(ret).to.equal(0);
    const out = await ffmpeg.readFile("stitched.mp4");
    const single = await ffmpeg.readFile("member-0.mp4");
    expect(out.length).to.be.greaterThan(single.length);
    const streams = await probeStreams("stitched.mp4");
    expect(streams).to.match(/Video: h264/);
    expect(streams).to.match(/Audio: aac/);
  });
});
