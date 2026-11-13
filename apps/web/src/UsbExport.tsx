export function UsbExport({ id }: { id: string }) {
  const base = `/api/episodes/${encodeURIComponent(id)}/usb`;
  return (
    <section className="panel">
      <h2>Export for Android via USB</h2>
      <ol>
        <li>Create a new empty folder on your PC for this episode. Download both files below into it, keeping their exact names. If your browser saves elsewhere, move them into that folder; do not overwrite another episode's files.</li>
        <li>Connect your Android phone by USB, unlock it and choose file transfer. Copy the folder to the phone.</li>
        <li>In the Android app, open Library → Import USB package. Select episode.json, then audio.m4a from the copied folder.</li>
      </ol>
      <p><a href={`${base}/episode.json`} download>Download episode.json</a>{" · "}<a href={`${base}/audio.m4a`} download>Download audio.m4a</a></p>
      <p className="hint">No automatic sync. Downloads validate the package; if validation fails, check the episode files and retry. Import only packages you trust: checksums detect corruption, not malicious changes. Existing episode IDs cannot be imported twice.</p>
    </section>
  );
}
