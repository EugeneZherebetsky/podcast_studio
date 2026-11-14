import Fastify from "fastify";
import { installShutdown } from "../../src/shutdown.ts";

const app = Fastify();
app.addHook("onClose", async () => { throw new Error("synthetic-shutdown-credential"); });
await app.listen({ host: "127.0.0.1", port: 0 });
installShutdown(app);
console.log("READY");
