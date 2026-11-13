import { useCallback, useEffect, useRef, useState } from "react";
import type { JobDetail } from "shared";
import { api } from "./api.ts";

export function Jobs() {
  const [jobs, setJobs] = useState<JobDetail[] | null>(null);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState(false);
  const sequence = useRef(0);
  const retryBusy = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  async function retryAsNew(id: string) {
    if (retryBusy.current) return;
    retryBusy.current = true;
    if (!window.confirm("Start over as a new job? Research and all stages run again. The current script provider selection will be used and may use your subscription. The failed job and its files will be preserved.")) {
      retryBusy.current = false;
      return;
    }
    setRetrying(true);
    setRetryError("");
    try {
      await api.retryAsNew(id);
      await load();
    } catch (cause) {
      setRetryError(cause instanceof Error ? cause.message : "Could not start new job");
    } finally {
      retryBusy.current = false;
      setRetrying(false);
    }
  }
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
    const close = api.subscribe(refresh, (connected) => {
      if (active) {
        setConnection(connected);
        if (connected) refresh();
      }
    });
    return () => {
      active = false;
      requests.current++;
      close();
    };
  }, [load]);
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
      {retryError && <p role="alert" className="error">{retryError}</p>}
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
              {job.status === "failed" && (
                <button disabled={retrying} onClick={() => void retryAsNew(job.id)}>Retry as new job</button>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
