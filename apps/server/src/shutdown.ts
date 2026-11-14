import type { FastifyInstance } from "fastify";
import type { Db } from "./db/index.ts";

/** Start cancellation before HTTP drains, but keep SQLite open until onClose. */
export function registerRunnerShutdown(app: FastifyInstance, db: Db, runner?: { stopGeneration(): Promise<boolean>; close(): Promise<boolean> }): void {
  let closing: Promise<boolean> | undefined;
  const begin = () => {
    if (!closing) {
      closing = Promise.resolve().then(() => runner ? runner.stopGeneration() : true);
      void closing.catch(() => {}); // onClose observes failures after HTTP drains
    }
    return closing;
  };
  app.addHook("preClose", (done) => { void begin(); done(); });
  app.addHook("onClose", async () => {
    if (await begin()) {
      db.$client.close();
      await runner?.close();
    }
    else {
      console.error("Generation did not drain; manual recovery may be required");
      process.exitCode = 1;
    }
  });
}

/** Install after listen; stdin is a shutdown channel only when explicitly requested. */
export function installShutdown(app: FastifyInstance): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      console.error("Server shutdown timed out; recovery may be required");
      process.exit(1);
    }, 8_000);
    void app.close().then(() => {
      clearTimeout(deadline);
      process.exit(process.exitCode ?? 0);
    }, (error: unknown) => {
      console.error("Server shutdown failed", error);
      process.exit(1);
    });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
  if (process.env.PODCAST_STUDIO_PARENT_STDIN === "1") {
    process.stdin.once("end", stop);
    process.stdin.once("error", stop);
    process.stdin.resume();
  }
}
