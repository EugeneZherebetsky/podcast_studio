import { useCallback, useEffect, useRef, useState } from "react";
import type { JobDetail } from "shared";
import { api } from "./api.ts";

export function Jobs() {
  const [jobs, setJobs] = useState<JobDetail[] | null>(null);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [log, setLog] = useState<Awaited<ReturnType<typeof api.jobLog>> | null>(null);
  const [logError, setLogError] = useState("");
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const list = await api.jobs();
      const details = await Promise.all(list.jobs.map((job) => api.job(job.id)));
      if (request === sequence.current) {
        setJobs(details);
        setError("");
      }
    } catch (cause) {
      if (request === sequence.current)
        setError(cause instanceof Error ? cause.message : "Could not load jobs");
    }
  }, []);
  useEffect(() => {
    const requests = sequence;
    let active = true;
    const refresh = () => {
      if (active) void load();
    };
    refresh();
    const close = api.subscribe(
      (event) => {
        refresh();
        if (event.type === "job-stage" && event.jobId === selected) setRevision((n) => n + 1);
      },
      (connected) => {
        if (active) {
          setConnection(connected);
          if (connected) {
            refresh();
            setRevision((n) => n + 1);
          }
        }
      },
      (id) => {
        if (id === selected) setRevision((n) => n + 1);
      },
    );
    return () => {
      active = false;
      requests.current++;
      close();
    };
  }, [load, selected]);
  useEffect(() => {
    let active = true;
    if (selected) {
      void api
        .jobLog(selected)
        .then((value) => {
          if (active) {
            setLog(value);
            setLogError("");
          }
        })
        .catch(() => {
          if (active) {
            setLog(null);
            setLogError("Could not load progress log.");
          }
        });
    }
    return () => {
      active = false;
    };
  }, [selected, revision]);
  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">Activity</p>
        <h1>Jobs</h1>
        <p>Follow each stage of episode production.</p>
      </header>
      <div className="section-bar">
        <p role="status">
          {connection ? "Live updates connected" : "Live updates disconnected; reconnecting"}
        </p>
        <button onClick={() => void load()}>Refresh</button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {jobs === null ? (
        !error && <p role="status">Loading jobs…</p>
      ) : jobs.length === 0 ? (
        <div className="panel empty">
          <h2>No jobs yet</h2>
          <p>Create an episode to see its progress here.</p>
          <a href="#/new">New episode →</a>
        </div>
      ) : (
        <div className="stack">
          {jobs.map((job) => (
            <article className="panel" key={job.id}>
              <div className="job-heading">
                <div>
                  <h2>{job.options.title}</h2>
                  <p>{new Date(job.createdAt).toLocaleString()}</p>
                </div>
                <span className="badge">{job.status}</span>
              </div>
              {job.currentStage && (
                <p>
                  Current stage: <strong>{job.currentStage}</strong>
                </p>
              )}
              {job.error && <p className="error">{job.error}</p>}
              {job.stages.length ? (
                <ul className="stages">
                  {job.stages.map((stage) => (
                    <li key={stage.stage}>
                      <span>{stage.stage}</span>
                      <strong>{stage.status}</strong>
                      {stage.error && <span className="error">{stage.error}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No stage updates yet.</p>
              )}
              {job.status === "failed" && <p>Retry is disabled until job recovery is safe.</p>}
              <button
                aria-expanded={selected === job.id}
                onClick={() => {
                  setLog(null);
                  setLogError("");
                  setSelected(selected === job.id ? null : job.id);
                }}
              >
                {selected === job.id ? "Hide progress log" : "Show progress log"}
              </button>
              {selected === job.id && (
                <section aria-label="Progress log">
                  <h3>Progress log</h3>
                  <p>Up to 500 recent entries are kept; older job logs may be removed.</p>
                  {logError ? (
                    <p role="alert">{logError}</p>
                  ) : !log ? (
                    <p role="status">Loading progress log…</p>
                  ) : !log.available ? (
                    <p>Progress history is unavailable for this job.</p>
                  ) : (
                    <ol className="progress-log">
                      {log.entries.map((entry, index) => (
                        <li key={`${entry.timestamp}-${index}`}>
                          <time dateTime={entry.timestamp}>
                            {new Date(entry.timestamp).toLocaleString()}
                          </time>{" "}
                          {entry.message}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
