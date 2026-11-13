import { createScriptSelection } from "../../src/chatgpt-selection.ts";

await createScriptSelection(process.argv[2]!).set({ provider: "local" });
process.send?.("saved");
