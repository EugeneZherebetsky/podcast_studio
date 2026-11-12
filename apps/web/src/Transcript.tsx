import type { EpisodeSegment } from "shared";

export function Transcript({
  segments,
  positionMs,
  onSeek,
}: {
  segments: EpisodeSegment[];
  positionMs: number;
  onSeek: (ms: number) => void;
}) {
  if (!segments.length) return <p>No transcript is available for this episode.</p>;
  return (
    <ol className="transcript">
      {segments.map((segment) => (
        <li key={segment.id}>
          <button
            type="button"
            aria-current={
              positionMs >= segment.startMs && positionMs < segment.endMs ? "true" : undefined
            }
            onClick={() => onSeek(segment.startMs)}
          >
            <span className="speaker">{segment.speaker}</span> {segment.text}
          </button>
        </li>
      ))}
    </ol>
  );
}
