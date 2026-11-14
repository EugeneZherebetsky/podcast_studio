import { CloudTtsBillingUncertain, ExternalWorkUncertain } from "../../safe-generation-error.ts";
import type { SynthesizeRequest } from "./interface.ts";

/** Bound both fetch and body consumption, even if an injected fetch ignores abort. */
export async function paidRequest<T>(
  request: SynthesizeRequest,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal, settled: () => void) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  request.assertContinue?.();
  const controller = new AbortController();
  let settled = false;
  let finished = false;
  const markSettled = () => { if (!finished) { settled = true; request.onPaidState?.("settled"); } };
  let rejectAbort!: (error: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  let timedOut = false;
  const abort = () => { controller.abort(); rejectAbort(new DOMException("Interrupted", "AbortError")); };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    request.onPaidState?.("dispatched");
    return await Promise.race([run(controller.signal, markSettled), interrupted]);
  } catch (error) {
    const billing = new CloudTtsBillingUncertain(!timedOut && (!!signal?.aborted || (error instanceof Error && error.name === "AbortError")), timedOut);
    if (settled) throw billing;
    throw new ExternalWorkUncertain(billing);
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
