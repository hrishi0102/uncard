import "server-only";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import type { Db } from "./types";

/**
 * Tiny JSON-file database. Good enough for a hackathon demo: one process, small data.
 * Writes are serialized through a promise chain and saved atomically (write + rename).
 */

const file = () => join(process.cwd(), config.dataDir, "db.json");

const empty = (): Db => ({
  version: 1,
  users: {},
  intents: {},
  merchants: {},
  webhookEventIds: [],
  approvals: {},
  mockIssuer: { cards: {}, transactions: {}, users: {}, connects: {}, webhooks: [], walletCents: 0 },
  mockWorld: { deviceCodes: {}, privateJwk: null, publicJwk: null },
  bridgeClaims: {},
});

type GlobalWithDb = typeof globalThis & { __anycheckoutDb?: Db; __anycheckoutQueue?: Promise<unknown> };
const g = globalThis as GlobalWithDb;

function load(): Db {
  if (g.__anycheckoutDb) return g.__anycheckoutDb;
  const path = file();
  let db = empty();
  if (existsSync(path)) {
    try {
      db = { ...empty(), ...JSON.parse(readFileSync(path, "utf8")) };
    } catch (e) {
      console.error("[store] could not parse db.json, starting empty", e);
    }
  }
  g.__anycheckoutDb = db;
  return db;
}

function persist(db: Db) {
  const path = file();
  mkdirSync(join(process.cwd(), config.dataDir), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, path);
}

/** Read-only snapshot (do not mutate). */
export function read(): Db {
  return load();
}

/** Serialized read-modify-write. The mutator may be async. */
export function write<T>(mutator: (db: Db) => T | Promise<T>): Promise<T> {
  const run = async () => {
    const db = load();
    const result = await mutator(db);
    persist(db);
    return result;
  };
  const next = (g.__anycheckoutQueue ?? Promise.resolve()).then(run, run);
  g.__anycheckoutQueue = next.catch(() => undefined);
  return next;
}

export function resetDb() {
  g.__anycheckoutDb = empty();
  persist(g.__anycheckoutDb);
}
