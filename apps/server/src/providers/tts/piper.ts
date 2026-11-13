import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Lang } from "shared";
import { TtsCache, type TtsCacheOptions } from "./cache.ts";
import type { SynthesizeRequest, SynthesizeResult, TtsProvider, Voice } from "./interface.ts";

type Runner = (executable: string, args: string[], text: string) => Promise<Buffer>;
export interface PiperTtsOptions extends TtsCacheOptions {
  executable: string;
  voicesDir: string;
  run?: Runner;
}

async function runPiper(executable: string, args: string[], text: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "podcast-piper-"));
  const output = path.join(dir, "speech.wav");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, [...args, "--output-file", output], {
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1" },
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-8192);
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`Piper failed (${code}): ${stderr}`)),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(text, "utf8");
    });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class PiperTtsProvider implements TtsProvider {
  private readonly cache: TtsCache;
  private readonly run: Runner;
  constructor(private readonly options: PiperTtsOptions) {
    this.cache = new TtsCache(options);
    this.run = options.run ?? runPiper;
  }
  forRun(dir: string): TtsProvider {
    return new PiperTtsProvider({ ...this.options, cacheDir: dir, maxRetries: 0 });
  }
  async voices(lang: Lang): Promise<Voice[]> {
    const files = await readdir(this.options.voicesDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    return files
      .filter(
        (file) => /^[a-z]{2}_[A-Z]{2}-[\w-]+\.onnx$/.test(file) && files.includes(`${file}.json`),
      )
      .map((file) => file.slice(0, -5))
      .filter((id) => id.slice(0, 2).toLowerCase() === lang.slice(0, 2).toLowerCase())
      .map((id) => ({ id, name: id, lang: id.slice(0, 5).replace("_", "-") as Lang }));
  }
  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResult> {
    if (!Number.isFinite(request.rate) || request.rate <= 0)
      throw new Error("Piper rate must be positive");
    if (!(await this.voices(request.lang)).some((voice) => voice.id === request.voice))
      throw new Error(`Piper voice not found for ${request.lang}: ${request.voice}`);
    const model = path.join(this.options.voicesDir, `${request.voice}.onnx`);
    const hash = createHash("sha256")
      .update(await readFile(model))
      .update(await readFile(`${model}.json`))
      .digest("hex");
    return this.cache.synthesizeWithCache(`piper:${hash}`, request, async () => ({
      audio: await this.run(
        this.options.executable,
        ["--model", model, "--length-scale", String(1 / request.rate)],
        request.text,
      ),
    }));
  }
}
