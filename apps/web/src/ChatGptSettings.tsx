import { useEffect, useState } from "react";

type Status = {
  active: string | null;
  planEnabled: boolean;
  phase: "idle" | "starting" | "pending" | "failed";
};
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
export function ChatGptSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [label, setLabel] = useState("default");
  const [link, setLink] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
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
    if (status?.phase !== "pending") return;
    let cancelled = false;
    let count = 0;
    const timer = window.setInterval(() => {
      if (++count > 150) {
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
  }, [status?.phase]);
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
    setBusy(true);
    setMessage("");
    try {
      const result = (await call("signout")) as { revoked: boolean };
      setLink("");
      await refresh();
      setMessage(
        result.revoked
          ? "Signed out locally."
          : "Signed out locally, but remote revocation was not confirmed. Disconnect the app in ChatGPT Settings.",
      );
    } catch {
      setMessage(
        "Sign-out could not be confirmed. Try again or disconnect the app in ChatGPT Settings.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="chatgpt-plan-status">
      <h2 id="chatgpt-plan-status">ChatGPT plan</h2>
      <p>
        Script generation is not connected to ChatGPT sign-in. Your configured provider remains
        unchanged; there is no automatic paid API fallback.
      </p>
      <p>
        Sessions are held in memory and cleared on server exit, but exiting does not confirm remote
        revocation. Sign out first. Plan eligibility depends on OpenAI.
      </p>
      <p role="status">
        {status
          ? status.active
            ? `Signed in as ${status.active}. ${status.planEnabled ? "Plan access enabled." : "Plan access not enabled."}`
            : status.phase === "pending" || status.phase === "starting"
              ? "Sign-in pending."
              : status.phase === "failed"
                ? "Sign-in failed or was denied."
                : "Not signed in."
          : "Checking sign-in status…"}
      </p>
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
