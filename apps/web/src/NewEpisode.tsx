import { useState, type FormEvent } from "react";
import { JobOptionsSchema, type Mode } from "shared";
import { api } from "./api.ts";

export function NewEpisode({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [lang, setLang] = useState("en");
  const [minutes, setMinutes] = useState(10);
  const [mode, setMode] = useState<Mode>("standard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = JobOptionsSchema.safeParse({ title, brief, lang, minutes, mode });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.createJob(parsed.data);
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create job");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">Create</p>
        <h1>New episode</h1>
        <p>Turn a topic into a research-backed audio episode.</p>
      </header>
      <form onSubmit={submit} className="panel form">
        <label>
          Topic title
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What would you like to explore?"
          />
        </label>
        <label>
          Brief <span className="hint">Optional</span>
          <textarea
            rows={4}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Add context, questions, or source URLs."
          />
        </label>
        <div className="form-grid">
          <label>
            Language
            <input
              required
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              aria-describedby="lang-help"
            />
            <small id="lang-help">Language tag, for example en or hu</small>
          </label>
          <label>
            Length in minutes
            <input
              type="number"
              required
              min={1}
              max={120}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </label>
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="standard">Standard</option>
              <option value="graded">Graded</option>
              <option value="bilingual">Bilingual</option>
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Creating…" : "Create episode"}
        </button>
      </form>
    </section>
  );
}
