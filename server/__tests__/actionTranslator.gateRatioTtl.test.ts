/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PR #414 — translator coverage pin for the 3 approved self-recs
 *
 * Three self-recommendations were approved by the operator as the foundation
 * for the KB accumulation self-healing gate:
 *
 *   _3o2kxo (kb-accumulation)  →  ratio_rule  (out:archived, in:kb_entry)
 *   _vqh06n (gate primitive)   →  gate_rule
 *   _tzdxk0 (ttl primitive)    →  ttl_rule
 *
 * These tests pin that the EXACT insight strings (verbatim from the operator
 * decision) parse to the expected primitive. A regression here means one of
 * the live recs would fall back to `missing-primitive` and the chronic
 * broken-commitment loop would reopen.
 *
 * No filesystem, no network, no Date.now. Pure parser tests.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { translateAction } from "../actionTranslator.js";

describe("actionTranslator — PR #414 gate/ratio/ttl coverage", () => {
  it("_3o2kxo: 'For every 10 new KB entries added, archive at least 3 existing entries.' → ratio_rule", () => {
    const text = "For every 10 new KB entries added, archive at least 3 existing entries.";
    const r = translateAction(text, text);
    assert.equal(r.primitive, "ratio_rule", `expected ratio_rule, got ${r.primitive} (reason: ${r.reason ?? ""})`);
    const p = r.params as Record<string, unknown>;
    assert.equal(p.inputCount, 10);
    assert.equal(p.inputNoun, "kb_entries");
    assert.equal(p.outputCount, 3);
    assert.equal(p.outputNoun, "archived");
  });

  it("_vqh06n: 'Cap new KB entries at 10 per cycle unless at least 3 are archived.' → gate_rule", () => {
    const text = "Cap new KB entries at 10 per cycle unless at least 3 are archived.";
    const r = translateAction(text, text);
    assert.equal(r.primitive, "gate_rule", `expected gate_rule, got ${r.primitive} (reason: ${r.reason ?? ""})`);
  });

  it("_tzdxk0: '14-day TTL on speculative-watchlist hypotheses with a named trigger event.' → ttl_rule", () => {
    const text = "Apply a 14-day TTL on speculative-watchlist hypotheses with a named trigger event.";
    const r = translateAction(text, text);
    assert.equal(r.primitive, "ttl_rule", `expected ttl_rule, got ${r.primitive} (reason: ${r.reason ?? ""})`);
    const p = r.params as Record<string, unknown>;
    assert.equal(p.days, 14);
  });

  it("none of the 3 approved recs fall through to `none` (missing-primitive)", () => {
    const insights = [
      "For every 10 new KB entries added, archive at least 3 existing entries.",
      "Cap new KB entries at 10 per cycle unless at least 3 are archived.",
      "Apply a 14-day TTL on speculative-watchlist hypotheses with a named trigger event.",
    ];
    for (const text of insights) {
      const r = translateAction(text, text);
      assert.notEqual(
        r.primitive,
        "none",
        `insight "${text}" fell through to missing-primitive: ${r.reason ?? ""}`,
      );
    }
  });
});
