import type { FastifyInstance } from "fastify";

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
