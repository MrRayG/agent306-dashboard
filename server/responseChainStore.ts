/**
 * Response chain state cache for Responses API conversation threading.
 *
 * xAI keeps Responses API state server-side for 30 days. We store the last
 * response_id per conversationId so subsequent calls can pass previous_response_id.
 */

import fs from "fs";
import path from "path";
import { dataPath } from "./dataPaths.js";

const STORE_FILE = dataPath("response_chains.json");
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

type ChainEntry = { responseId: string; updatedAt: string; model: string };
type Store = Record<string, ChainEntry>;

function loadStore(): Store {
  try {
    if (!fs.existsSync(STORE_FILE)) return {};
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Store;
  } catch {
    return {};
  }
}

function saveStore(store: Store): void {
  const tmp = `${STORE_FILE}.tmp`;
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, STORE_FILE);
}

function purgeExpired(store: Store): Store {
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of Object.entries(store)) {
    const ts = Date.parse(entry.updatedAt);
    if (!Number.isFinite(ts) || now - ts > TTL_MS) {
      delete store[key];
      changed = true;
    }
  }
  return changed ? store : store;
}

export function getPreviousResponseId(conversationId: string): string | null {
  const store = purgeExpired(loadStore());
  const entry = store[conversationId];
  if (!entry) return null;
  return entry.responseId;
}

export function setResponseChain(conversationId: string, responseId: string, model: string): void {
  const store = purgeExpired(loadStore());
  store[conversationId] = {
    responseId,
    updatedAt: new Date().toISOString(),
    model,
  };
  saveStore(store);
}

export function clearResponseChain(conversationId: string): void {
  const store = loadStore();
  if (store[conversationId]) {
    delete store[conversationId];
    saveStore(store);
  }
}
