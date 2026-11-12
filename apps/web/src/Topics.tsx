import { useEffect, useState, type FormEvent } from "react";
import {
  CreateTopicRequestSchema,
  type Topic,
  type Mode,
  type Level,
  type CreateTopicRequest,
} from "shared";
import { api } from "./api.ts";

const blank = {
  title: "",
  brief: "",
  lang: "en",
  mode: "standard" as Mode,
  level: null,
  minutes: 10,
  schedule: null as string | null,
  enabled: true,
};

export function Topics() {
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [form, setForm] = useState<CreateTopicRequest>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function reload() {
    setTopics((await api.topics()).topics);
  }
  useEffect(() => {
    api
      .topics()
      .then((data) => setTopics(data.topics))
      .catch((cause: unknown) => setError(String(cause)));
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const parsed = CreateTopicRequestSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    setBusy(true);
    try {
      if (editing) await api.updateTopic(editing, parsed.data);
      else await api.createTopic(parsed.data);
      setEditing(null);
      setForm(blank);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save topic");
    } finally {
      setBusy(false);
    }
  }
  async function remove(topic: Topic) {
    if (!window.confirm(`Delete topic “${topic.title}”?`)) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteTopic(topic.id);
      if (editing === topic.id) {
        setEditing(null);
        setForm(blank);
      }
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete topic");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">Your subscriptions</p>
        <h1>Topics</h1>
        <p>
          Save a topic and optionally give it a recurring schedule. Automatic scheduling is not
          connected yet.
        </p>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {topics === null ? (
        <p role="status">{error ? "Topics could not be loaded." : "Loading topics…"}</p>
      ) : topics.length === 0 ? (
        <p>No topics yet.</p>
      ) : (
        <div className="stack">
          {topics.map((topic) => (
            <article className="panel" key={topic.id}>
              <h2>{topic.title}</h2>
              <p>{topic.brief}</p>
              <p>
                {topic.schedule ? `Schedule: ${topic.schedule}` : "No schedule"} ·{" "}
                {topic.enabled ? "Enabled" : "Paused"}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(topic.id);
                  setForm({
                    title: topic.title,
                    brief: topic.brief,
                    lang: topic.lang,
                    mode: topic.mode,
                    level: topic.level,
                    minutes: topic.minutes,
                    schedule: topic.schedule,
                    enabled: topic.enabled,
                  });
                }}
              >
                Edit
              </button>{" "}
              <button type="button" disabled={busy} onClick={() => void remove(topic)}>
                Delete
              </button>
            </article>
          ))}
        </div>
      )}
      <h2>{editing ? "Edit topic" : "Add topic"}</h2>
      <form className="panel form" onSubmit={(event) => void submit(event)}>
        <label>
          Title
          <input
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </label>
        <label>
          Brief
          <textarea
            rows={3}
            value={form.brief}
            onChange={(e) => setForm({ ...form, brief: e.target.value })}
          />
        </label>
        <div className="form-grid">
          <label>
            Language tag
            <input
              required
              value={form.lang}
              onChange={(e) => setForm({ ...form, lang: e.target.value })}
            />
          </label>
          <label>
            Minutes
            <input
              required
              type="number"
              min="1"
              max="120"
              value={form.minutes}
              onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) })}
            />
          </label>
          <label>
            Mode
            <select
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value as Mode })}
            >
              <option value="standard">Standard</option>
              <option value="graded">Graded</option>
              <option value="bilingual">Bilingual</option>
            </select>
          </label>
        </div>
        <label>
          Level
          <select
            value={form.level ?? ""}
            onChange={(e) => setForm({ ...form, level: (e.target.value || null) as Level | null })}
          >
            <option value="">Not specified</option>
            <option>A1</option>
            <option>A2</option>
            <option>B1</option>
            <option>B2</option>
          </select>
        </label>
        <label>
          Schedule
          <select
            value={form.schedule ?? ""}
            onChange={(e) => setForm({ ...form, schedule: e.target.value || null })}
          >
            <option value="">No schedule</option>
            <option value="0 7 * * *">Daily at 07:00</option>
            <option value="0 7 * * 1-5">Weekdays at 07:00</option>
            <option value="0 7 * * 1">Mondays at 07:00</option>
            {form.schedule &&
              !["0 7 * * *", "0 7 * * 1-5", "0 7 * * 1"].includes(form.schedule) && (
                <option value={form.schedule}>Existing: {form.schedule}</option>
              )}
          </select>
          <small>Times use the server's local timezone.</small>
        </label>
        <label>
          Scheduling
          <select
            value={String(form.enabled)}
            onChange={(e) => setForm({ ...form, enabled: e.target.value === "true" })}
          >
            <option value="true">Enabled</option>
            <option value="false">Paused</option>
          </select>
        </label>
        <button className="primary" disabled={busy}>
          {editing ? "Save topic" : "Add topic"}
        </button>
        {editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setForm(blank);
            }}
          >
            Cancel edit
          </button>
        )}
      </form>
    </section>
  );
}
