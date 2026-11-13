import type { Settings } from "shared";

export type CloudTtsStatus = { elevenlabsConfigured: boolean; fishConfigured: boolean };
type Cloud = NonNullable<Settings["cloudTts"]>;

export function CloudTts({ status, value, onChange }: { status: CloudTtsStatus | null; value: Cloud | null | undefined; onChange: (value: Cloud | null) => void }) {
  return <section aria-labelledby="cloud-tts-heading">
    <h2 id="cloud-tts-heading">Cloud text-to-speech</h2>
    <p>Piper is the default. Cloud script text is sent to the provider and speech is separately billed. No automatic fallback.</p>
    <p>The input limit bounds total characters and UTF-8 bytes, not money. Cloud TTS charges are excluded from recorded usage, episode cost and the monthly budget; these are not total cost.</p>
    <p role="status">{status ? `ElevenLabs: key ${status.elevenlabsConfigured ? "present" : "not present"}; Fish Audio: key ${status.fishConfigured ? "present" : "not present"}. Key presence does not verify a connection.` : "Key status unavailable or loading."}</p>
    <p>Set provider keys in the server .env and restart; never enter keys here.</p>
    <label>Speech provider<select value={value?.provider ?? "piper"} onChange={(e) => {
      if (e.target.value === "fish") onChange({ provider: "fish", model: "s2.1-pro-free", voice: "", inputLimit: 5000 });
      else if (e.target.value === "elevenlabs") onChange({ provider: "elevenlabs", model: "eleven_multilingual_v2", voice: "", inputLimit: 5000 });
      else onChange(null);
    }}><option value="piper">Piper (local)</option><option value="elevenlabs">ElevenLabs</option><option value="fish">Fish Audio</option></select></label>
    {value && <>
      <label>Model<select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value } as Cloud)}>
        {(value.provider === "fish" ? ["s1", "s2-pro", "s2.1-pro", "s2.1-pro-free", "drama-3"] : ["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_v3"]).map((model) => <option key={model} value={model}>{model}</option>)}
      </select></label>
      <label>Provider voice ID<input required value={value.voice} onChange={(e) => onChange({ ...value, voice: e.target.value })} /></label>
      <label>Maximum characters and UTF-8 bytes per job<input type="number" min="1" max="100000" required value={value.inputLimit} onChange={(e) => onChange({ ...value, inputLimit: Number(e.target.value) })} /></label>
    </>}
  </section>;
}
