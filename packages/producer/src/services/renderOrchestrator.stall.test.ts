import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type WorkerTask } from "@hyperframes/engine";
import { formatCaptureFrameName } from "../utils/paths.js";
import { createRenderJob, executeRenderJob, type ProgressCallback } from "./renderOrchestrator.js";

// Entry: executeRenderJob with the real disk capture stage and retry ladder. Each parallel attempt is
// scripted: "stall" lands three frames then hangs until its signal aborts; a pace lands every frame.
type AttemptScript = "stall" | { firstFrameAfterMs: number; frameEveryMs: number };
const capture = vi.hoisted(() => ({
  scripts: [] as AttemptScript[],
  calls: 0,
  retriedWithWorkers: [] as number[],
  hdrSignal: undefined as AbortSignal | undefined,
  workerCount: 4,
  shaderTransitions: false,
}));

vi.mock("@hyperframes/engine", async (importOriginal) => {
  const engine = await importOriginal<typeof import("@hyperframes/engine")>();
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    ...engine,
    assertConfiguredFfmpegBinariesExist: () => {},
    resolveBrowserGpuMode: async () => "software",
    createCaptureSession: async () => ({ browserConsoleBuffer: [], options: {} }),
    initializeSession: async () => {},
    closeCaptureSession: async () => {},
    verifyDiskDrawElementSamples: async () => {},
    getCapturePerfSummary: () => ({}),
    // Sequential disk: three quick frames, then every frame takes 70 s.
    captureFrame: (_session: unknown, index: number) => wait(index < 3 ? 1_000 : 70_000),
    executeParallelCapture: async (
      _url: string,
      _workDir: string,
      tasks: WorkerTask[],
      options: { format?: "jpeg" | "png" },
      _hook: unknown,
      signal: AbortSignal,
      onProgress: (progress: object) => void,
    ) => {
      capture.calls += 1;
      const script = capture.scripts.shift() ?? "stall";
      const frames = tasks.flatMap((task) =>
        Array.from({ length: task.endFrame - task.startFrame }, (_, i) => ({
          dir: task.outputDir,
          index: task.startFrame + i,
        })),
      );
      const landed = frames.slice(0, script === "stall" ? 3 : frames.length);
      let captured = 0;
      for (const frame of landed) {
        await wait(captured === 0 && script !== "stall" ? script.firstFrameAfterMs : 1_000);
        mkdirSync(frame.dir, { recursive: true });
        writeFileSync(
          join(
            frame.dir,
            formatCaptureFrameName(frame.index, engine.frameFileExtension(options.format)),
          ),
          "frame bytes over the 8-byte placeholder floor",
        );
        captured += 1;
        onProgress({ capturedFrames: captured, totalFrames: frames.length, activeWorkers: 1 });
        if (script !== "stall") await wait(script.frameEveryMs - 1_000);
      }
      if (script === "stall") {
        await new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("worker cancelled")), {
            once: true,
          }),
        );
      }
      return [];
    },
  };
});
vi.mock("./fileServer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fileServer.js")>()),
  createFileServer: async () => ({
    url: "http://127.0.0.1:1",
    port: 1,
    close: () => {},
    addPreHeadScript: () => {},
  }),
}));
vi.mock("./render/stages/compileStage.js", () => ({
  runCompileStage: async () => ({
    compiled: {
      html: "<div></div>",
      hasShaderTransitions: capture.shaderTransitions,
      renderModeHints: { reasons: [] },
    },
    composition: { width: 16, height: 16, duration: 40 / 30, videos: [], images: [], audios: [] },
    deviceScaleFactor: 1,
    outputWidth: 16,
    outputHeight: 16,
    compileOnlyMs: 0,
    forceScreenshot: true,
  }),
}));
vi.mock("./render/stages/probeStage.js", () => ({
  runProbeStage: async ({ compiled }: { compiled: object }) => ({
    compiled,
    fileServer: null,
    probeSession: null,
    lastBrowserConsole: [],
    duration: 40 / 30,
    totalFrames: 40,
    browserProbeMs: 0,
    beginFrameStalled: false,
  }),
}));
vi.mock("./render/stages/extractVideosStage.js", () => ({
  runExtractVideosStage: async () => ({
    extractionResult: null,
    frameLookup: null,
    videoReadinessSkipIds: [],
    videoMetadataHints: [],
    nativeHdrVideoIds: new Set(),
    videoTransfers: new Map(),
    nativeHdrImageIds: new Set(),
    imageTransfers: new Map(),
    hdrImageSrcPaths: new Map(),
    imageColorSpaces: [],
    videoExtractMs: 0,
    failureToEnforce: null,
  }),
}));
vi.mock("./render/stages/audioStage.js", () => ({
  runAudioStage: async ({ workDir }: { workDir: string }) => ({
    audioOutputPath: join(workDir, "audio.wav"),
    hasAudio: false,
    audioProcessMs: 0,
  }),
}));
vi.mock("./render/captureCost.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./render/captureCost.js")>()),
  resolveRenderWorkerCount: () => capture.workerCount,
}));
vi.mock("./render/stages/captureHdrStage.js", () => ({
  runCaptureHdrStage: (input: { abortSignal: AbortSignal }) => {
    capture.hdrSignal = input.abortSignal;
    return new Promise<never>(() => {});
  },
}));
vi.mock("./render/stages/encodeStage.js", () => ({
  canEncodeWhileCapturing: () => false,
  runEncodeStage: async ({ outputPath }: { outputPath: string }) => {
    mkdirSync(outputPath, { recursive: true });
    for (let frame = 1; frame <= 40; frame++) {
      writeFileSync(join(outputPath, formatCaptureFrameName(frame, "png")), "encoded");
    }
    return { encodeMs: 0 };
  },
}));
vi.mock("./render/perfSummary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./render/perfSummary.js")>()),
  buildRenderPerfSummary: (..._args: unknown[]) => ({}),
}));

const PENDING = Symbol("pending");
const dirs: string[] = [];
beforeEach(() => {
  capture.scripts = [];
  capture.calls = 0;
  capture.retriedWithWorkers = [];
  capture.hdrSignal = undefined;
  capture.shaderTransitions = false;
  capture.workerCount = 4;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Starts a render; `outcome()` is "completed", the thrown error, or PENDING. */
function startRender(
  progressSink?: ProgressCallback,
  format: "png-sequence" | "mp4" = "png-sequence",
): () => unknown {
  const root = mkdtempSync(join(tmpdir(), "hf-stage-stall-"));
  dirs.push(root);
  writeFileSync(join(root, "index.html"), "<div></div>");
  const job = createRenderJob({
    fps: 30,
    quality: "draft",
    format,
    hdrMode: "force-sdr",
    producerConfig: resolveConfig({ enablePageSideCompositing: false }),
    logger: {
      info() {},
      error() {},
      debug() {},
      warn(message: string, meta?: Record<string, unknown>) {
        if (message.includes("retrying missing frames")) {
          capture.retriedWithWorkers.push(meta?.toWorkers as number);
        }
      },
    },
  });
  let settled: unknown = PENDING;
  void executeRenderJob(job, root, join(root, "frames"), progressSink).then(
    () => (settled = "completed"),
    (error: unknown) => (settled = error),
  );
  return () => settled;
}

async function ioTurns(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/** Advances fake time a second at a time, letting real file IO run between steps. */
async function runFor(ms: number, outcome: () => unknown): Promise<void> {
  for (let elapsed = 0; elapsed < ms && outcome() === PENDING; elapsed += 1_000) {
    await ioTurns();
    await vi.advanceTimersByTimeAsync(1_000);
  }
  await ioTurns();
}

it("retries a stalled attempt on fewer workers, with a fresh window, and the render completes", async () => {
  capture.scripts = ["stall", { firstFrameAfterMs: 200_000, frameEveryMs: 1_000 }];
  const outcome = startRender();
  await runFor(400_000, outcome);
  expect(capture.retriedWithWorkers).toEqual([2]);
  expect(outcome()).toBe("completed");
});

it("fails typed and non-retryable once every attempt down the ladder stalls", async () => {
  const outcome = startRender();
  await runFor(3 * (3_000 + 60_000 + 5_000) + 10_000, outcome);
  expect(capture.retriedWithWorkers).toEqual([2, 1]);
  expect(outcome()).toMatchObject({
    name: "RenderStageStalledError",
    code: "RENDER_STAGE_STALLED",
    owner: "system",
    retryable: false,
  });
});

it("never kills a capture that keeps landing frames", async () => {
  capture.scripts = [{ firstFrameAfterMs: 250_000, frameEveryMs: 50_000 }];
  const outcome = startRender();
  await runFor(250_000 + 40 * 50_000 + 10_000, outcome);
  expect(capture.calls).toBe(1);
  expect(outcome()).toBe("completed");
});

it("fails a sequential disk capture at the first frame after its window ran out", async () => {
  capture.workerCount = 1;
  const outcome = startRender();
  await runFor(3_000 + 70_000 + 5_000, outcome);
  expect(outcome()).toMatchObject({ code: "RENDER_STAGE_STALLED", retryable: false });
});

it("fails an HDR capture that stops, the only attempt it has, and aborts that attempt", async () => {
  capture.shaderTransitions = true;
  const outcome = startRender(undefined, "mp4");
  await runFor(300_000 + 10_000, outcome);
  expect(capture.hdrSignal?.aborted).toBe(true);
  await runFor(60_000 + 10_000, outcome);
  expect(outcome()).toMatchObject({ code: "RENDER_STAGE_STALLED" });
});

it("completes even when the progress sink never drains", async () => {
  capture.scripts = [{ firstFrameAfterMs: 1_000, frameEveryMs: 1_000 }];
  const sinkNeverDrains: ProgressCallback = () => new Promise<void>(() => {});
  const outcome = startRender(sinkNeverDrains);
  await runFor(120_000, outcome);
  expect(outcome()).toBe("completed");
});
