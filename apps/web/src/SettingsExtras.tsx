export function PairingStatus() {
  return (
    <section aria-label="Device pairing">
      <h2>Device pairing</h2>
      <p>Phone pairing is not available yet. No pairing QR code can be safely offered with the current connection setup.</p>
      <p>Localhost refers to the phone itself when used on a phone; it cannot reach this server there. The server listens on loopback by default.</p>
      <p>Plain HTTP exposes pairing codes and device tokens to the network. HTTPS through a reverse proxy is not supported until its authentication boundary is designed.</p>
    </section>
  );
}

export function UsageTotal({ totalUsd }: { totalUsd: number | null }) {
  return (
    <section aria-label="Usage">
      <h2>Usage</h2>
      {totalUsd === null ? (
        <p>Usage totals are not available yet.</p>
      ) : (
        <p>Recorded cost this month (UTC): ${totalUsd.toLocaleString("en-US", { maximumSignificantDigits: 12 })}</p>
      )}
    </section>
  );
}

export function VoicePicker({
  label,
  value,
  voices,
  onChange,
  onPreview,
  busy = false,
  audioUrl,
  error,
}: {
  label: string;
  value: string | null;
  voices: ReadonlyArray<{ id: string; name: string }>;
  onChange: (value: string | null) => void;
  onPreview: () => void;
  busy?: boolean;
  audioUrl?: string;
  error?: string;
}) {
  return (
    <div>
      <label>
        {label}
        <select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
          <option value="">None</option>
          {value && !voices.some((voice) => voice.id === value) && <option value={value}>{value} (unavailable)</option>}
          {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
        </select>
      </label>
      <button type="button" disabled={!value || busy} onClick={onPreview}>{busy ? "Preparing preview…" : "Preview"}</button>
      {error && <p role="alert">{error}</p>}
      {audioUrl && <audio controls src={audioUrl} aria-label={`${label} preview`} />}
    </div>
  );
}
