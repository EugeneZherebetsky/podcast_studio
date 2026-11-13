export type CloudTtsStatus = { openaiConfigured: boolean; azureConfigured: boolean };

export function CloudTts({ status }: { status: CloudTtsStatus | null }) {
  return (
    <section aria-labelledby="cloud-tts-heading">
      <h2 id="cloud-tts-heading">Cloud text-to-speech</h2>
      <p>Cloud TTS is not active in PC Settings. Piper is the local-profile default. These options do not change generation.</p>
      <p>With cloud speech, script text would be sent to the provider and speech is separately billed. There is no automatic fallback to cloud speech.</p>
      <label>
        Cloud provider (not available yet)
        <select disabled defaultValue="">
          <option value="">Not active</option>
          <option value="openai">OpenAI</option>
          <option value="azure">Azure Speech</option>
        </select>
      </label>
      <p role="status">{status ? `OpenAI: key ${status.openaiConfigured ? "present" : "not present"}; Azure: key ${status.azureConfigured ? "present" : "not present"}. Key presence does not verify a connection.` : "Key status unavailable or loading."}</p>
      <p>Keys must be configured privately in the server environment, never in this page. Activation requires a working PC generation runner and reliable cost guards.</p>
    </section>
  );
}
