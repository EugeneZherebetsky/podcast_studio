import { useEffect, useState, type FormEvent } from "react";
import { SettingsSchema, type Settings as SettingsValue } from "shared";
import { api } from "./api.ts";
import { PairingStatus, UsageTotal } from "./SettingsExtras.tsx";
import { ChatGptSettings } from "./ChatGptSettings.tsx";

export function Settings() {
  const [value, setValue] = useState<SettingsValue | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .settings()
      .then(setValue)
      .catch((cause: unknown) => setError(String(cause)));
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value) return;
    const parsed = SettingsSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      setValue(await api.updateSettings(parsed.data));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save settings");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">Preferences</p>
        <h1>Settings</h1>
        <p>Profile is saved as a preference but does not switch providers yet. Set PROFILE in .env and restart to configure the server. Other preferences are not yet connected to generation or budget enforcement.</p>
      </header>
      <ChatGptSettings />
      <section className="panel" aria-labelledby="gemini-status">
        <h2 id="gemini-status">Gemini</h2>
        <p>Gemini consumer account sign-in is not connected to this app. <a href="https://gemini.google.com/" target="_blank" rel="noopener noreferrer">Open Gemini separately</a>.</p>
        <p>An experimental command-line manual draft workflow exists, but it requires prepared research and is not connected to review, audio, or publication. See docs/MANUAL-GEMINI.md in the project for its safety restrictions.</p>
      </section>
      <PairingStatus />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!value ? (
        <p role="status">{error ? "Settings could not be loaded." : "Loading settings…"}</p>
      ) : (
        <form
          className="panel form"
          onSubmit={(event) => void submit(event)}
          onChange={() => setSaved(false)}
        >
          <label>
            Profile
            <select
              value={value.profile}
              onChange={(e) =>
                setValue({ ...value, profile: e.target.value as SettingsValue["profile"] })
              }
            >
              <option value="cloud">Cloud</option>
              <option value="local">Local</option>
            </select>
          </label>
          <label>
            Native language tag
            <input
              required
              value={value.nativeLang}
              onChange={(e) => setValue({ ...value, nativeLang: e.target.value })}
            />
          </label>
          <label>
            Target language tag
            <input
              required
              value={value.targetLang}
              onChange={(e) => setValue({ ...value, targetLang: e.target.value })}
            />
          </label>
          <label>
            Level
            <select
              value={value.level}
              onChange={(e) =>
                setValue({ ...value, level: e.target.value as SettingsValue["level"] })
              }
            >
              <option>A1</option>
              <option>A2</option>
              <option>B1</option>
              <option>B2</option>
            </select>
          </label>
          <label>
            Monthly budget (USD)
            <input
              type="number"
              min="0"
              step="0.01"
              required
              value={value.monthlyBudgetUsd}
              onChange={(e) => setValue({ ...value, monthlyBudgetUsd: Number(e.target.value) })}
            />
          </label>
          <h2>Voice IDs</h2>
          <p>Voice previews are not available yet.</p>
          {(
            [
              ["huHost", "Hungarian host"],
              ["huCohost", "Hungarian co-host"],
              ["nativeHost", "Native host"],
              ["nativeTeacher", "Native teacher"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                value={value.voices[key] ?? ""}
                onChange={(e) =>
                  setValue({ ...value, voices: { ...value.voices, [key]: e.target.value || null } })
                }
              />
            </label>
          ))}
          <UsageTotal totalUsd={null} />
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
          {saved && <p role="status">Preferences saved.</p>}
        </form>
      )}
    </section>
  );
}
