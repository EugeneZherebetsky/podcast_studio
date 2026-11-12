import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Voice files are pinned to a single upstream revision; model hashes are Hugging Face LFS OIDs.
const revision = "5041a7a49ae5b3a0f30e6837769eb03fdbb231bd";
const files = [
  [
    "en/en_US/lessac/medium/en_US-lessac-medium.onnx",
    "en_US-lessac-medium.onnx",
    "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
  ],
  [
    "en/en_US/lessac/medium/en_US-lessac-medium.onnx.json",
    "en_US-lessac-medium.onnx.json",
    "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
  ],
  [
    "en/en_US/lessac/medium/MODEL_CARD",
    "en_US-lessac-medium.MODEL_CARD",
    "ce49eb457742208166d399a40cdec2c7fa9db77960930031564ab56f12882645",
  ],
  [
    "hu/hu_HU/anna/medium/hu_HU-anna-medium.onnx",
    "hu_HU-anna-medium.onnx",
    "968c0c3a66cb667811242cc88653bff9247395fc7a0517fbeef7d8c08cdae62a",
  ],
  [
    "hu/hu_HU/anna/medium/hu_HU-anna-medium.onnx.json",
    "hu_HU-anna-medium.onnx.json",
    "ccf967d8db8018c9d8ffdb0edc8814ffcb6b75273bb0d84337317240f710283a",
  ],
  [
    "hu/hu_HU/anna/medium/MODEL_CARD",
    "hu_HU-anna-medium.MODEL_CARD",
    "2134551c09f616ba333640f419267d45aeed5443b53ffde79a11a715737f8546",
  ],
];

if (process.argv[2] !== "--accept-licenses" || process.argv.length > 4) {
  throw new Error(
    "Review docs/SETUP.md voice licensing, then run node scripts/piper-voices.mjs --accept-licenses [PIPER_DIR]",
  );
}
const dir = path.resolve(process.argv[3] ?? "infra/piper", "voices");
await mkdir(dir, { recursive: true });
for (const [source, name, expected] of files) {
  const target = path.join(dir, name);
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!bytes) {
    const response = await fetch(
      `https://huggingface.co/rhasspy/piper-voices/resolve/${revision}/${source}`,
    );
    if (!response.ok) throw new Error(`Download failed for ${name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error(`SHA-256 mismatch for ${name}`);
    await writeFile(target, bytes, { flag: "wx" });
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(`Existing ${name} has unexpected SHA-256; not overwritten`);
  console.log(`Verified ${name}: ${expected}`);
}
