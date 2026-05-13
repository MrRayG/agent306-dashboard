/**
 * Phase 3b-b — render tests for PromotionAttestationPanel / List.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json --test \
 *      client/src/__tests__/promotionAttestationPanel.test.tsx
 *
 * Coverage:
 *   1. Shows the persisted attestation when at least one event exists.
 *   2. Handles the no-event case without crashing (panel still rendered).
 *   3. Renders parse_error attestations with a distinct treatment.
 *   4. Renders blocked-gate attestations (gateOk=false) without flipping
 *      anything authoritative — it's still advisory.
 *   5. Does not introduce any action / mutation controls: zero <input>,
 *      no Approve/Reject/Apply/Revert/Draft buttons rendered by this
 *      component (the only button is the disclosure toggle).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import {
  PromotionAttestationList,
  PromotionAttestationPanel,
  type PromotionAttestationEvent,
} from "../components/PromotionAttestationPanel";

function evaluatedEvent(id: number, opts: { gateOk?: boolean; verdict?: string } = {}): PromotionAttestationEvent {
  return {
    id,
    emittedAt: "2026-05-13T10:00:00.000Z",
    gateOk: opts.gateOk ?? true,
    attestations: [
      {
        source: "phase3aPrep",
        harnessVersion: "phase3aPrep.v1",
        status: "evaluated",
        candidateId: "cand-x",
        readiness: {
          verdict: opts.verdict ?? "fully_prepared",
          highTierAllSatisfied: true,
          lowTierAllSatisfied: true,
          blockers: [],
        },
        parseWarnings: [],
        parseError: null,
      },
    ],
  };
}

function parseErrorEvent(id: number): PromotionAttestationEvent {
  return {
    id,
    emittedAt: "2026-05-13T10:05:00.000Z",
    gateOk: true,
    attestations: [
      {
        source: "phase3aPrep",
        harnessVersion: "phase3aPrep.v1",
        status: "parse_error",
        candidateId: "",
        readiness: null,
        parseWarnings: [],
        parseError: "candidate.candidateId: must be a non-empty string",
      },
    ],
  };
}

describe("Phase 3b-b — PromotionAttestationList renders events", () => {
  it("renders each event with its gate state and attestation entries", () => {
    const events = [evaluatedEvent(101), evaluatedEvent(102, { verdict: "not_ready" })];
    const html = renderToString(<PromotionAttestationList events={events} />);
    assert.match(html, /data-testid="promotion-attestation-list"/);
    assert.match(html, /data-testid="promotion-attestation-event-101"/);
    assert.match(html, /data-testid="promotion-attestation-event-102"/);
    assert.match(html, /data-testid="promotion-attestation-entry-101-0"[^>]*data-att-status="evaluated"/);
    assert.match(html, /data-testid="promotion-attestation-entry-102-0"[^>]*data-att-verdict="not_ready"/);
    assert.match(html, /cand-x/);
    assert.match(html, /phase3aPrep/);
  });

  it("renders blockers when the readiness verdict lists them", () => {
    const ev = evaluatedEvent(200, { verdict: "not_ready" });
    (ev.attestations[0] as any).readiness.blockers = ["missing evidenceRef on X"];
    const html = renderToString(<PromotionAttestationList events={[ev]} />);
    assert.match(html, /data-testid="promotion-attestation-blockers-200-0"/);
    assert.match(html, /missing evidenceRef on X/);
  });

  it("renders parse_error attestations with the error message", () => {
    const html = renderToString(<PromotionAttestationList events={[parseErrorEvent(300)]} />);
    assert.match(html, /data-testid="promotion-attestation-event-300"/);
    assert.match(html, /data-att-status="parse_error"/);
    assert.match(html, /data-testid="promotion-attestation-parse-error-300-0"/);
    assert.match(html, /must be a non-empty string/);
  });

  it("renders blocked-gate events (gateOk=false) but does not surface an apply control", () => {
    const ev = evaluatedEvent(400, { gateOk: false, verdict: "not_ready" });
    const html = renderToString(<PromotionAttestationList events={[ev]} />);
    assert.match(html, /data-testid="promotion-attestation-event-400"[^>]*data-gate-ok="false"/);
    // React server-render inserts <!-- --> markers between text spans —
    // match either the joined or split form.
    assert.match(html, /gate (?:<!-- -->)?blocked/);
    // Pin 7: the list component must not render any mutation control.
    assert.doesNotMatch(html, /Apply/);
    assert.doesNotMatch(html, /Approve/);
    assert.doesNotMatch(html, /Reject/);
    assert.doesNotMatch(html, /Revert/);
    assert.doesNotMatch(html, /Draft PR/);
  });

  it("renders nothing visible when given an empty event list", () => {
    const html = renderToString(<PromotionAttestationList events={[]} />);
    assert.equal(html, "");
  });
});

describe("Phase 3b-b — PromotionAttestationPanel handles event presence/absence", () => {
  function noopFetcher() {
    return Promise.resolve({ recommendationId: "rec_x", attestations: [] });
  }

  it("shows the no-event summary when initialEvents is empty", () => {
    const html = renderToString(
      <PromotionAttestationPanel
        recommendationId="rec_empty"
        fetcher={noopFetcher}
        initialEvents={[]}
      />,
    );
    assert.match(html, /data-testid="promotion-attestation-panel-rec_empty"/);
    assert.match(html, /data-event-count="0"/);
    assert.match(html, /no attestation persisted/);
    // Toggle button is present but closed by default — that's the only button.
    assert.match(html, /data-testid="promotion-attestation-toggle-rec_empty"/);
  });

  it("shows the attestation summary count when initialEvents is populated", () => {
    const events = [evaluatedEvent(700), parseErrorEvent(701)];
    const html = renderToString(
      <PromotionAttestationPanel
        recommendationId="rec_full"
        fetcher={noopFetcher}
        initialEvents={events}
      />,
    );
    assert.match(html, /data-testid="promotion-attestation-panel-rec_full"/);
    assert.match(html, /data-event-count="2"/);
    assert.match(html, /2 attestation events · advisory only/);
  });

  it("the panel label always communicates 'advisory'", () => {
    const html = renderToString(
      <PromotionAttestationPanel
        recommendationId="rec_advisory"
        fetcher={noopFetcher}
        initialEvents={[evaluatedEvent(800)]}
      />,
    );
    assert.match(html, /attestations \(advisory\)/);
  });

  it("the panel exposes no mutation surface — only the disclosure toggle", () => {
    const html = renderToString(
      <PromotionAttestationPanel
        recommendationId="rec_no_mutate"
        fetcher={noopFetcher}
        initialEvents={[evaluatedEvent(900)]}
        initialOpen
      />,
    );
    // The only button is the toggle. No Apply/Approve/etc. controls.
    const buttonCount = (html.match(/<button/g) ?? []).length;
    assert.equal(buttonCount, 1, "expected exactly one button (the toggle)");
    assert.doesNotMatch(html, /<input/);
    assert.doesNotMatch(html, /Approve|Reject|Apply|Revert|Draft PR/);
  });
});
