import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

const maxFileSize = 65536;
const label = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
const clientId = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => v !== "dynamic_agent_client");
const item = z
  .object({
    clientId,
    subject: z.string().min(1).max(1024),
  })
  .strict();
const schema = z
  .object({
    hostId: z
      .string()
      .regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    accounts: z.record(label, item),
  })
  .strict();
type Data = z.infer<typeof schema>;

// Evidence that OpenAI may hold credentials this host has not seen revoked. A record never
// contains token material, authorization codes, PKCE verifiers or authorization URLs.
const grant = z
  .object({
    id: z.uuid(),
    label,
    clientId,
    state: z.enum(["grant-may-exist", "revocation-unconfirmed"]),
    at: z.number().int().nonnegative(),
    accessExpiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();
const grantsSchema = z.object({ grants: z.array(grant).max(256) }).strict();
export type GrantRecord = z.infer<typeof grant>;

export async function openRegistrationStore(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "chatgpt-registration.json");
  const grantsFile = path.join(directory, "chatgpt-grants.json");
  const lock = path.join(directory, "chatgpt-registration.lock");
  async function checkLegacyLock() {
    try {
      await lstat(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error(
      "Legacy chatgpt-registration.lock exists. Stop all old server and CLI processes, verify none are running, then remove the lock directory manually.",
    );
  }
  async function acquire(name: string, wait: boolean): Promise<Database.Database | undefined> {
    const target = path.join(directory, name);
    const handle = await open(target, "a", 0o600);
    await handle.close();
    const db = new Database(target, { timeout: 0 });
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          db.exec("BEGIN IMMEDIATE");
          return db;
        } catch (error) {
          if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
          if (!wait) {
            db.close();
            return undefined;
          }
          if (attempt >= 200) throw error;
          await sleep(25);
        }
      }
    } catch (error) {
      db.close();
      throw error;
    }
  }
  function release(db: Database.Database) {
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    await checkLegacyLock();
    const db = (await acquire("chatgpt-mutex.sqlite", true))!;
    try {
      await checkLegacyLock();
      return await work();
    } finally {
      release(db);
    }
  }
  async function grantLock(id: string, wait = false) {
    grant.shape.id.parse(id);
    return acquire(`chatgpt-grant-${id}.sqlite`, wait);
  }
  async function read<T>(target: string, parse: (value: unknown) => T, empty: () => T) {
    try {
      const raw = await readFile(target, "utf8");
      if (raw.length > maxFileSize) throw new Error("Registration file too large");
      return parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return empty();
    }
  }
  async function write(target: string, value: unknown) {
    const text = JSON.stringify(value);
    if (text.length > maxFileSize) throw new Error("Registration file too large");
    const temp = path.join(directory, `.chatgpt-${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async function update(change: (data: Data) => void): Promise<Data> {
    return locked(async () => {
      const data = await read(
        file,
        (v) => schema.parse(v),
        (): Data => ({ hostId: `urn:uuid:${randomUUID()}`, accounts: {} }),
      );
      change(data);
      await write(file, data);
      return data;
    });
  }
  const parseGrants = (v: unknown) => grantsSchema.parse(v).grants;
  let data = await update(() => {});
  let grants = await read(grantsFile, parseGrants, (): GrantRecord[] => []);
  return {
    get hostId() {
      return data.hostId;
    },
    get accounts() {
      return structuredClone(data.accounts);
    },
    /** Grant records as currently on disk, so records written by another process are seen. */
    grants(): GrantRecord[] {
      try {
        const raw = readFileSync(grantsFile, "utf8");
        if (raw.length <= maxFileSize) grants = parseGrants(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") grants = [];
        // Any other failure keeps the last valid list rather than hiding a warning.
      }
      return structuredClone(grants);
    },
    async ownGrant(id: string) {
      const db = (await grantLock(id, true))!;
      return () => release(db);
    },
    async acknowledgeGrants() {
      await locked(async () => {
        const acquired: Database.Database[] = [];
        try {
          const current = await read(grantsFile, parseGrants, (): GrantRecord[] => []);
          const kept: GrantRecord[] = [];
          for (const record of current) {
            const db = await grantLock(record.id);
            if (db) acquired.push(db);
            else kept.push(record);
          }
          await write(grantsFile, { grants: kept });
          grants = kept;
        } finally {
          for (const db of acquired) release(db);
        }
      });
    },
    /** Applies a change to the grant records; resolves only after the file has been replaced. */
    async updateGrants(change: (current: GrantRecord[]) => GrantRecord[]) {
      grants = await locked(async () => {
        const next = grantsSchema.parse({
          grants: change(await read(grantsFile, parseGrants, (): GrantRecord[] => [])),
        }).grants;
        await write(grantsFile, { grants: next });
        return next;
      });
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
