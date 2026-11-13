import { openDesktopGuard } from "../../src/desktop-guard.ts";
const guard = openDesktopGuard(process.argv[2]!);
guard.begin();
console.log("ready");
setInterval(() => {}, 1000);
