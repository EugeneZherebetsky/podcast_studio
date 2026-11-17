// Only thrown between calls once no external operation is in flight.
export class CancelledAfterStage extends Error {}

/** A cancel request for a job that already ended on its own: there is nothing to cancel. */
export class JobAlreadyFinished extends Error {
  constructor(readonly status: "succeeded" | "failed") { super(`Cannot cancel ${status} job`); }
}
