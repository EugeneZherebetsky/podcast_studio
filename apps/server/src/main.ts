import { APP_NAME } from "shared";
import { buildApp } from "./app.ts";

// Config loading through the shared schema arrives in T03.
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4747);

const app = buildApp();
await app.listen({ host, port });
console.log(`${APP_NAME} server listening on http://${host}:${port}`);
