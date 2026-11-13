import { useEffect, useState } from "react";

export type UncertainGrant = {
  label: string;
  cause: "stopped-while-signed-in" | "signout-not-confirmed";
};
export type Status = {
  active: string | null;
  planEnabled: boolean;
  expired: boolean;
  remoteUncertain: boolean;
  uncertain: UncertainGrant[];
  phase: "idle" | "starting" | "pending" | "failed";
};
// OpenAI's documentation names ChatGPT Settings → Usage as where users manage each app's access.
export const CHATGPT_SETTINGS_URL = "https://chatgpt.com/settings/usage";
type Post = (path: string, body?: object) => Promise<unknown>;
async function call(path: string, body: object = {}) {
  const response = await fetch(`/api/chatgpt/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      "ChatGPT management unavailable. Open the app directly at its numeric loopback address.",
    );
  return response.json();
}
/** The user's statement, sent with explicit confirmation; the server cannot verify it. */
export async function acknowledgeDisconnect(post: Post): Promise<Status> {
  return (await post("acknowledge", { disconnectedInChatGptSettings: true })) as Status;
}

export function ScriptSelectionStatus({ selection }: { selection: { provider: string; account?: string; model?: string; scope?: string } | null }) {
  return <p role="status">{selection ? selection.provider === "incomplete" ? "Selection incomplete. Select a provider again before generating." : selection.provider === "chatgpt" ? `ChatGPT ${selection.scope === "all-stages" ? "all stages" : "scripts only"}: ${selection.model} (${selection.account})` : "Local Ollama" : "Script provider unavailable or loading. Select a provider to recover."}</p>;
}

export function ChatGptDisconnectNotice(props: {
  status: Status | null;
  confirming: boolean;
  busy: boolean;
  onBegin: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { status } = props;
  if (!status?.remoteUncertain) return null;
  const labels = [...new Set(status.uncertain.map((item) => item.label))];
  const blocked =
    props.busy || !!status.active || status.phase === "pending" || status.phase === "starting";
  return (
    <div role="alert">
      <p>
        Podcast Studio could not confirm that OpenAI ended its access for{" "}
        {labels.length ? labels.join(", ") : "a ChatGPT account"}. This does not mean anyone has
        used your account. To be sure, disconnect Podcast Studio in ChatGPT Settings, then confirm
        below.
      </p>
      <ul>
        {status.uncertain.map((item) => (
          <li key={`${item.label}:${item.cause}`}>
            {item.label}:{" "}
            {item.cause === "stopped-while-signed-in"
              ? "Podcast Studio stopped while signed in."
              : "Sign-out could not be confirmed."}
          </li>
        ))}
      </ul>
      <p>
        <a href={CHATGPT_SETTINGS_URL} target="_blank" rel="noopener noreferrer">
          Open ChatGPT Settings
        </a>
      </p>
      {props.confirming ? (
        <p>
          Podcast Studio cannot check this for you. Only continue if you disconnected Podcast Studio
          in ChatGPT Settings.{" "}
          <button type="button" disabled={blocked} onClick={props.onConfirm}>
            Yes, I disconnected it
          </button>{" "}
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </p>
      ) : (
        <button type="button" disabled={blocked} onClick={props.onBegin}>
          I&apos;ve disconnected Podcast Studio in ChatGPT Settings
        </button>
      )}
    </div>
  );
}

export function ChatGptSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [label, setLabel] = useState("default");
  const [link, setLink] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [selection, setSelection] = useState<{ provider: string; account?: string; model?: string; scope?: string } | null>(null);
  const [models, setModels] = useState<{ slug: string; display_name: string }[]>([]);
  const [model, setModel] = useState("");
  const [modelAccount, setModelAccount] = useState<string | null>(null);
  useEffect(() => {
    void call("selection").then(setSelection).catch(() => setMessage("Could not load script provider selection."));
  }, []);

  async function loadModels() {
    setBusy(true); setMessage("");
    try {
      const result = (await call("models")) as { models: { slug: string; display_name: string }[] };
      setModels(result.models); setModel(""); setModelAccount(status?.active ?? null);
      if (!result.models.length) setMessage("No ChatGPT models are available for this account.");
    } catch { setMessage("Could not load models. Check your session and plan access."); }
    finally { setBusy(false); }
  }
  async function select(provider: "local" | "chatgpt") {
    setBusy(true); setMessage("");
    try {
      setSelection(await call("select", provider === "local" ? { provider } : { provider, model, scope: "all-stages" }));
      setMessage("Provider saved for new jobs.");
    } catch {
      setSelection(null);
      try { setSelection(await call("selection")); } catch { /* selection remains unknown */ }
      setMessage("Could not save selection. Check your session and model, then select a provider again.");
    }
    finally { setBusy(false); }
  }
  async function refresh() {
    const next = (await call("status")) as Status;
    setStatus(next);
    return next;
  }
  useEffect(() => {
    void call("status")
      .then((next: Status) => setStatus(next))
      .catch(() =>
        setMessage(
          "ChatGPT management unavailable. Open the app directly at its numeric loopback address.",
        ),
      );
  }, []);
  useEffect(() => {
    if (status?.phase !== "pending" && !status?.active) return;
    let cancelled = false;
    let count = 0;
    const timer = window.setInterval(() => {
      if (status?.phase === "pending" && ++count > 150) {
        window.clearInterval(timer);
        if (!cancelled) setMessage("Sign-in polling stopped. Cancel or refresh Settings.");
        return;
      }
      void refresh()
        .then((next) => {
          if (next.phase !== "pending") setLink("");
        })
        .catch(() => {
          window.clearInterval(timer);
          setMessage("Could not check sign-in status.");
        });
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status?.phase, status?.active]);
  async function start() {
    setBusy(true);
    setMessage("");
    try {
      const result = (await call("login", { label })) as { authorizationUrl: string };
      const url = new URL(result.authorizationUrl);
      if (
        url.protocol !== "https:" ||
        url.host !== "auth.openai.com" ||
        url.pathname !== "/api/accounts/authorize" ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error();
      setLink(url.toString());
      await refresh();
    } catch {
      setMessage("Could not start sign-in. Check your connection and account label.");
    } finally {
      setBusy(false);
    }
  }
  async function signout() {
    const cancelling = status?.phase === "pending" || status?.phase === "starting";
    setBusy(true);
    setMessage("");
    try {
      const result = (await call("signout")) as { revoked: boolean };
      setLink("");
      await refresh();
      setMessage(
        result.revoked
          ? cancelling
            ? "Sign-in cancelled."
            : "Signed out. The session with OpenAI was ended."
          : "Signed out locally, but OpenAI did not confirm that the session ended. See the warning above.",
      );
    } catch {
      setMessage(
        "Sign-out could not be confirmed. Try again or disconnect the app in ChatGPT Settings.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function acknowledge() {
    setBusy(true);
    setMessage("");
    try {
      setStatus(await acknowledgeDisconnect(call));
      setConfirming(false);
    } catch {
      setMessage("Could not record your confirmation. Sign out or cancel sign-in first.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="chatgpt-plan-status">
      <h2 id="chatgpt-plan-status">ChatGPT plan</h2>
      <p>
        Choosing ChatGPT for all stages sends source article text, topic and plan, research notes,
        scripts and review material to OpenAI and uses your ChatGPT subscription allowance.
        Speech remains local. ChatGPT usage is unavailable in this app; recorded totals exclude it
        and do not indicate zero usage. There is no automatic paid API fallback.
      </p>
      <h3>How to connect your ChatGPT subscription</h3>
      <ol>
        <li>Leave the account label as <strong>default</strong>, or enter a short name to identify this connection. It is not your password or email address.</li>
        <li>Click <strong>Start ChatGPT sign-in</strong>, then click <strong>Continue sign-in at OpenAI</strong> when the link appears.</li>
        <li>Sign in on OpenAI’s website and approve the requested plan access. Return here and wait for the signed-in status.</li>
        <li>Click <strong>Load available ChatGPT models</strong>, choose a model, then click <strong>Use ChatGPT for all stages</strong> to opt in. The selection applies to new jobs.</li>
      </ol>
      <p>Model availability depends on your account and OpenAI. Sign in again after a server restart; use <strong>Use local script generation</strong> to switch back to Ollama.</p>
      <h3>Script provider</h3>
      <ScriptSelectionStatus selection={selection} />
      <button type="button" disabled={busy} onClick={() => void select("local")}>Use local script generation</button>{" "}
      <button type="button" disabled={busy || !status?.active || status.expired || !status.planEnabled} onClick={() => void loadModels()}>Load available ChatGPT models</button>{" "}
      <label>ChatGPT model <select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy || !models.length || !status?.active || status.active !== modelAccount}>
        <option value="">Choose a model</option>
        {models.map((item) => <option key={item.slug} value={item.slug}>{item.display_name}</option>)}
      </select></label>{" "}
      <button type="button" disabled={busy || !model || !status?.active || status.active !== modelAccount || status.expired || !status.planEnabled} onClick={() => void select("chatgpt")}>Use ChatGPT for all stages</button>
      <p>
        Sessions are held in memory only. Stopping the server tries to end the session with OpenAI
        but cannot always confirm it, so sign out first. Plan eligibility depends on OpenAI.
      </p>
      <p role="status">
        {status
          ? status.expired
            ? "Session expired. Sign out and sign in again."
            : status.active
              ? `Signed in as ${status.active}. ${status.planEnabled ? "Required scopes granted; plan eligibility is not verified." : "Required scopes not granted; plan eligibility is not verified."}`
              : status.phase === "pending" || status.phase === "starting"
                ? "Sign-in pending."
                : status.phase === "failed"
                  ? "Sign-in failed or was denied."
                  : "Not signed in."
          : "Checking sign-in status…"}
      </p>
      <ChatGptDisconnectNotice
        status={status}
        confirming={confirming}
        busy={busy}
        onBegin={() => setConfirming(true)}
        onConfirm={() => void acknowledge()}
        onCancel={() => setConfirming(false)}
      />
      <label>
        Account label{" "}
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          pattern="[a-zA-Z0-9_-]{1,40}"
          maxLength={40}
        />
      </label>
      <button
        type="button"
        disabled={
          busy ||
          !status ||
          !!status.active ||
          status.phase === "pending" ||
          status.phase === "starting" ||
          !/^[a-zA-Z0-9_-]{1,40}$/.test(label)
        }
        onClick={() => void start()}
      >
        Start ChatGPT sign-in
      </button>
      {link && (
        <p>
          <a href={link} target="_blank" rel="noopener noreferrer">
            Continue sign-in at OpenAI
          </a>
        </p>
      )}
      <button type="button" disabled={busy || !status} onClick={() => void signout()}>
        {status?.phase === "pending" || status?.phase === "starting"
          ? "Cancel sign-in"
          : "Sign out"}
      </button>
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
