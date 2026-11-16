// Test preload: on request, reports which key-like variable NAMES remain in the server's
// own environment (what a Piper or ffmpeg child would inherit). Values are never sent.
process.on("message", (message) => {
  if (message !== "env-probe") return;
  process.send?.({ type: "env-probe", names: Object.keys(process.env).filter((name) => /KEY|TOKEN|SECRET/i.test(name)).sort() });
});
