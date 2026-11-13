import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const item = z
  .object({
    clientId: z
      .string()
      .min(1)
      .max(1024)
      .refine((v) => v !== "dynamic_agent_client"),
    subject: z.string().min(1).max(1024),
  })
  .strict();
const schema = z
  .object({
    hostId: z
      .string()
      .regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    accounts: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), item),
  })
  .strict();
type Data = z.infer<typeof schema>;

export async function openRegistrationStore(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "chatgpt-registration.json");
  const lock = path.join(directory, "chatgpt-registration.lock");
  async function update(change: (data: Data) => void): Promise<Data> {
    await mkdir(lock, { mode: 0o700 });
    const temp = path.join(directory, `.chatgpt-${randomUUID()}.tmp`);
    try {
      let data: Data;
      try {
        const raw = await readFile(file, "utf8");
        if (raw.length > 65536) throw new Error("Registration file too large");
        data = schema.parse(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        data = { hostId: `urn:uuid:${randomUUID()}`, accounts: {} };
      }
      change(data);
      await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
      await rename(temp, file);
      return data;
    } finally {
      await rm(temp, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
  let data = await update(() => {});
  return {
    get hostId() {
      return data.hostId;
    },
    get accounts() {
      return structuredClone(data.accounts);
    },
    async save(label: string, clientId: string, subject: string) {
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(label)) throw new Error("Invalid account label");
      const account = item.parse({ clientId, subject });
      data = await update((current) => {
        const previous = Object.hasOwn(current.accounts, label)
          ? current.accounts[label]
          : undefined;
        if (["__proto__", "constructor", "prototype"].includes(label))
          throw new Error("Invalid account label");
        if (previous && (previous.clientId !== clientId || previous.subject !== subject))
          throw new Error("Account label already used");
        if (
          Object.values(current.accounts).some(
            (v) => v.clientId === clientId && v.subject !== subject,
          )
        )
          throw new Error("Account identity mismatch");
        current.accounts[label] = account;
      });
    },
  };
}
