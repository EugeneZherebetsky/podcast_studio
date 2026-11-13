import { useEffect, useRef, useState } from "react";
import type { Episode, EpisodeSummary } from "shared";
import { api } from "./api.ts";
import { Transcript } from "./Transcript.tsx";

export function Library() {
  const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api
      .episodes()
      .then((result) => {
        if (active) setEpisodes(result.episodes);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load library");
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">Your collection</p>
        <h1>Library</h1>
        <p>Episodes ready to listen to.</p>
      </header>
      {error ? (
        <div role="alert" className="error">
          {error}{" "}
          <button
            onClick={() => {
              setError("");
              setAttempt(attempt + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : episodes === null ? (
        <p role="status">Loading library…</p>
      ) : episodes.length === 0 ? (
        <div className="panel empty">
          <h2>Your library is empty</h2>
          <p>Completed episodes will appear here.</p>
          <a href="#/new">Create an episode →</a>
        </div>
      ) : (
        <div className="stack">
          {episodes.map((episode) => (
            <article className="panel library-item" key={episode.id}>
              <div>
                <h2>
                  <a href={`#/episode/${encodeURIComponent(episode.id)}`}>{episode.title}</a>
                </h2>
                <p>{episode.summary}</p>
                <small>
                  {new Date(episode.createdAt).toLocaleDateString()} ·{" "}
                  {Math.ceil(episode.durationMs / 60000)} min · {episode.lang}
                </small>
              </div>
              <a className="button-link" href={`#/episode/${encodeURIComponent(episode.id)}`}>
                Listen →
              </a>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
const speedKey = "playback-speed-v1";

export function readPlaybackSpeed(): number {
  try {
    const saved = Number(localStorage.getItem(speedKey));
    return speeds.includes(saved) ? saved : 1;
  } catch {
    return 1;
  }
}

export function savePlaybackSpeed(speed: number): void {
  try {
    localStorage.setItem(speedKey, String(speed));
  } catch {
    // Playback still works when browser storage is unavailable.
  }
}

export function Player({ id }: { id: string }) {
  const [speed, setSpeed] = useState(readPlaybackSpeed);
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [error, setError] = useState("");
  const [audioError, setAudioError] = useState(false);
  const [position, setPosition] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    let active = true;
    api
      .episode(id)
      .then((result) => {
        if (active) setEpisode(result);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load episode");
      });
    return () => {
      active = false;
    };
  }, [id, attempt]);
  if (error)
    return (
      <section>
        <h1>Episode unavailable</h1>
        <p role="alert" className="error">
          {error}
        </p>
        <button
          onClick={() => {
            setError("");
            setAttempt(attempt + 1);
          }}
        >
          Try again
        </button>
      </section>
    );
  if (!episode) return <p role="status">Loading episode…</p>;
  return (
    <section>
      <a href="#/library">← Library</a>
      <header className="page-heading">
        <p className="eyebrow">Now listening</p>
        <h1>{episode.title}</h1>
        <p>{episode.summary}</p>
        <p>Generation: {episode.generation.llm}</p>
      </header>
      <div className="panel player">
        <audio
          ref={(element) => {
            audio.current = element;
            if (element) element.playbackRate = speed;
          }}
          controls
          preload="metadata"
          src={api.audioUrl(id)}
          onLoadedMetadata={(e) => {
            e.currentTarget.playbackRate = speed;
          }}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime * 1000)}
          onSeeked={(e) => setPosition(e.currentTarget.currentTime * 1000)}
          onError={() => setAudioError(true)}
        >
          Your browser does not support audio playback.
        </audio>
        <label>
          Playback speed{" "}
          <select
            value={speed}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              setSpeed(next);
              if (audio.current) audio.current.playbackRate = next;
              savePlaybackSpeed(next);
            }}
          >
            {speeds.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        {audioError && (
          <p role="alert" className="error">
            Audio could not be loaded or played.
          </p>
        )}
      </div>
      <div className="player-grid">
        <section>
          <h2>Transcript</h2>
          <p className="hint">Select a passage to seek in the audio.</p>
          <Transcript
            segments={episode.segments}
            positionMs={position}
            onSeek={(ms) => {
              if (audio.current) {
                audio.current.currentTime = ms / 1000;
                setPosition(ms);
              }
            }}
          />
        </section>
        <aside>
          <h2>Sources</h2>
          {episode.sources.length ? (
            <ul className="sources">
              {episode.sources.map((source) => (
                <li key={source.id}>
                  <a href={source.url} target="_blank" rel="noreferrer noopener">
                    {source.title || source.url}
                  </a>
                  <small>{source.site}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p>No sources available.</p>
          )}
        </aside>
      </div>
    </section>
  );
}
