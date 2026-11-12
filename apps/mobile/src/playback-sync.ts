import {
  OkResponseSchema,
  SyncPlaybackRequestSchema,
  type PlaybackPosition,
  type SyncPlaybackRequest,
} from "shared";

/** The store must acknowledge only rows still identical to the sent snapshot. */
export interface PlaybackQueue {
  pending(): PlaybackPosition[];
  acknowledge(sent: PlaybackPosition[]): void;
}

/** Transport is supplied only after a secure pairing implementation exists. */
export async function syncPlayback(
  queue: PlaybackQueue,
  send: (body: SyncPlaybackRequest) => Promise<unknown>,
): Promise<void> {
  const body = SyncPlaybackRequestSchema.parse({ positions: queue.pending() });
  if (body.positions.length === 0) return;
  OkResponseSchema.parse(await send(body));
  queue.acknowledge(body.positions);
}
