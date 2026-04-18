import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Regression guard: any raw fetch(...) call that also references getModel(
// bypasses the llmCall.ts routing layer — which means the OpenRouter-format
// model ID (e.g. "x-ai/grok-4.20-reasoning") is dispatched without passing
// through toXAINativeModel(), so api.x.ai rejects it with a 400.
//
// The only sanctioned dispatchers are postChatCompletions, postXSearchResponses,
// callChatCompletions, and callLLM — all defined in server/llmCall.ts. Every
// other site must route through those helpers.
//
// Background: the prior-incident stack was 63 × 400 "x-ai/grok-4.20-reasoning
// is not a valid model ID" errors from hypothesis-resolution. Root cause was
// dailyCycleEngine.ts dispatching the vendor-prefixed model string directly
// to api.x.ai. This test fails loudly if any future commit reintroduces the
// pattern.

const SERVER_DIR = path.resolve(process.cwd(), "server");
const ALLOWED_FILES = new Set(["llmCall.ts"]);
const FETCH_WITH_MODEL = /fetch\s*\([^)]*\)[\s\S]{0,800}?model\s*:\s*getModel\(/g;
const GETMODEL_WITH_FETCH = /getModel\([^)]*\)[\s\S]{0,200}?fetch\s*\(/g;

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

test("no raw fetch() dispatches a getModel() result outside llmCall.ts", () => {
  const files: string[] = [];
  collectTsFiles(SERVER_DIR, files);

  const offenders: string[] = [];
  for (const file of files) {
    const rel = path.relative(SERVER_DIR, file);
    if (ALLOWED_FILES.has(rel)) continue;
    const content = fs.readFileSync(file, "utf8");
    FETCH_WITH_MODEL.lastIndex = 0;
    GETMODEL_WITH_FETCH.lastIndex = 0;
    if (FETCH_WITH_MODEL.test(content) || GETMODEL_WITH_FETCH.test(content)) {
      offenders.push(rel);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Raw fetch+getModel bypass found — route through postChatCompletions/postXSearchResponses in llmCall.ts:\n${offenders.join("\n")}`,
  );
});
