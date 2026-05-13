/**
 * Phase 3b-b — read-only display of advisory promotion-gate attestations.
 *
 * Pure presentation. The Phase 3b-a backend persists one
 * `engine_events.event = "promotionAttestation"` row each time
 * `canPromote()` collects a non-empty attestation array on apply. This
 * component renders those rows next to a self-recommendation as
 * OBSERVABLE EVIDENCE — it never decides anything, never posts, and is
 * never wired into the gate's authority.
 *
 * Pin 7 (no public-action surface):
 *   The component has zero buttons, zero forms, and zero mutation hooks.
 *   It accepts a fetcher prop and renders the response. The page above
 *   it is responsible for fetching, and the page's mutation set is
 *   untouched by this PR.
 *
 * Pin 11 (boundary regression):
 *   The component does not import `canPromote` or anything from
 *   `server/eval/`. Attestations arrive as opaque JSON payloads — even a
 *   bug in this component cannot flip the gate's `ok`.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

export interface AttestationEntry {
  source?: string;
  harnessVersion?: string;
  status?: string;
  candidateId?: string;
  readiness?: {
    verdict?: string;
    highTierAllSatisfied?: boolean;
    lowTierAllSatisfied?: boolean;
    blockers?: ReadonlyArray<string>;
  } | null;
  parseWarnings?: ReadonlyArray<string>;
  parseError?: string | null;
  [k: string]: unknown;
}

export interface PromotionAttestationEvent {
  id: number;
  emittedAt: string;
  gateOk: boolean;
  attestations: ReadonlyArray<AttestationEntry>;
  /** Phase 4-a: operator-gated advisory soft warnings persisted on the
   *  same event row. Older rows pre-dating Phase 4-a may omit this
   *  field; consumers should treat absence and empty-array as
   *  equivalent. ADVISORY ONLY — the panel renders these as text and
   *  never derives any action from them. */
  softWarnings?: ReadonlyArray<string>;
}

export interface PromotionAttestationsResponse {
  recommendationId: string;
  attestations: ReadonlyArray<PromotionAttestationEvent>;
}

const mono = { fontFamily: "'Courier New', monospace" } as const;
const FG = "#e3e5e4";
const DIM = "rgba(227,229,228,0.55)";
const FAINT = "rgba(227,229,228,0.32)";
const GREEN = "#4ade80";
const RED = "#f87171";
const YELLOW = "#fbbf24";

function verdictColor(verdict: string | undefined): string {
  switch (verdict) {
    case "fully_prepared":
    case "high_tier_ready":
      return GREEN;
    case "not_ready":
      return YELLOW;
    default:
      return DIM;
  }
}

function statusColor(status: string | undefined): string {
  switch (status) {
    case "evaluated": return DIM;
    case "parse_error": return RED;
    default: return DIM;
  }
}

/** Pure render. Given an array of attestation events, draws a compact
 *  observable-evidence section. Empty list → renders nothing visible
 *  (the parent decides whether to surface "no attestation persisted"
 *  via the header). */
export function PromotionAttestationList(props: {
  events: ReadonlyArray<PromotionAttestationEvent>;
}) {
  const { events } = props;
  if (events.length === 0) return null;
  return (
    <div data-testid="promotion-attestation-list" style={{ ...mono }}>
      {events.map(ev => (
        <div
          key={ev.id}
          data-testid={`promotion-attestation-event-${ev.id}`}
          data-gate-ok={ev.gateOk ? "true" : "false"}
          style={{
            border: `1px solid ${FAINT}`,
            borderRadius: 4,
            padding: "8px 10px",
            marginTop: 6,
            background: "rgba(255,255,255,0.015)",
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ color: ev.gateOk ? GREEN : YELLOW, fontSize: 11 }}>
              gate {ev.gateOk ? "ok" : "blocked"}
            </span>
            <span style={{ color: DIM, fontSize: 11 }}>
              {new Date(ev.emittedAt).toLocaleString()}
            </span>
            <span style={{ color: FAINT, fontSize: 11 }}>
              {ev.attestations.length} attestation{ev.attestations.length === 1 ? "" : "s"}
            </span>
          </div>
          {ev.softWarnings && ev.softWarnings.length > 0 && (
            <div
              data-testid={`promotion-soft-warnings-${ev.id}`}
              data-soft-warning-count={ev.softWarnings.length}
              style={{
                marginTop: 6,
                padding: "4px 6px",
                border: `1px dashed ${YELLOW}`,
                borderRadius: 3,
                color: YELLOW,
                fontSize: 11,
              }}
            >
              <div style={{ color: YELLOW, fontWeight: 600 }}>
                soft warning (advisory · gate.ok unchanged)
              </div>
              {ev.softWarnings.map((w, i) => (
                <div
                  key={i}
                  data-testid={`promotion-soft-warning-${ev.id}-${i}`}
                  style={{ marginTop: 2 }}
                >
                  {w}
                </div>
              ))}
            </div>
          )}
          {ev.attestations.map((att, idx) => (
            <div
              key={idx}
              data-testid={`promotion-attestation-entry-${ev.id}-${idx}`}
              data-att-status={att.status ?? ""}
              data-att-verdict={att.readiness?.verdict ?? ""}
              style={{
                marginTop: 6,
                paddingTop: 6,
                borderTop: idx === 0 ? "none" : `1px dashed ${FAINT}`,
                fontSize: 12,
                color: FG,
              }}
            >
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span style={{ color: DIM }}>source:</span>
                <span>{att.source ?? "—"}</span>
                <span style={{ color: DIM }}>candidate:</span>
                <span>{att.candidateId || "—"}</span>
                <span style={{ color: DIM }}>status:</span>
                <span style={{ color: statusColor(att.status) }}>{att.status ?? "—"}</span>
                {att.readiness?.verdict && (
                  <>
                    <span style={{ color: DIM }}>verdict:</span>
                    <span style={{ color: verdictColor(att.readiness.verdict) }}>
                      {att.readiness.verdict}
                    </span>
                  </>
                )}
                {att.harnessVersion && (
                  <span style={{ color: FAINT }}>harness: {att.harnessVersion}</span>
                )}
              </div>
              {att.readiness?.blockers && att.readiness.blockers.length > 0 && (
                <div
                  data-testid={`promotion-attestation-blockers-${ev.id}-${idx}`}
                  style={{ color: YELLOW, marginTop: 4 }}
                >
                  blockers: {att.readiness.blockers.join("; ")}
                </div>
              )}
              {att.parseError && (
                <div
                  data-testid={`promotion-attestation-parse-error-${ev.id}-${idx}`}
                  style={{ color: RED, marginTop: 4 }}
                >
                  parse error: {att.parseError}
                </div>
              )}
              {att.parseWarnings && att.parseWarnings.length > 0 && (
                <div style={{ color: DIM, marginTop: 4 }}>
                  warnings: {att.parseWarnings.join("; ")}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Compact header + collapsible body used inside the SelfRecommendations
 *  list. Renders a one-line summary even when there are no events so an
 *  operator can tell at a glance whether the gate has been evaluated. */
export function PromotionAttestationPanel(props: {
  recommendationId: string;
  fetcher: () => Promise<PromotionAttestationsResponse>;
  /** Forced state for SSR / tests — bypasses react-query entirely so the
   *  panel can be rendered outside a QueryClientProvider. */
  initialEvents?: ReadonlyArray<PromotionAttestationEvent>;
  /** Default closed. */
  initialOpen?: boolean;
}) {
  const { recommendationId, fetcher, initialEvents, initialOpen } = props;
  if (initialEvents !== undefined) {
    return (
      <PromotionAttestationPanelStatic
        recommendationId={recommendationId}
        events={initialEvents}
        initialOpen={initialOpen}
      />
    );
  }
  return (
    <PromotionAttestationPanelLive
      recommendationId={recommendationId}
      fetcher={fetcher}
      initialOpen={initialOpen}
    />
  );
}

function PanelShell(props: {
  recommendationId: string;
  events: ReadonlyArray<PromotionAttestationEvent>;
  open: boolean;
  onToggle: () => void;
  loading?: boolean;
  errored?: boolean;
}) {
  const { recommendationId, events, open, onToggle, loading, errored } = props;
  const summary = events.length === 0
    ? "no attestation persisted"
    : `${events.length} attestation event${events.length === 1 ? "" : "s"} · advisory only`;
  return (
    <div
      data-testid={`promotion-attestation-panel-${recommendationId}`}
      data-event-count={events.length}
      style={{ marginTop: 8 }}
    >
      <button
        type="button"
        onClick={onToggle}
        data-testid={`promotion-attestation-toggle-${recommendationId}`}
        aria-expanded={open}
        style={{
          background: "transparent",
          border: `1px dashed ${FAINT}`,
          color: DIM,
          padding: "4px 8px",
          borderRadius: 4,
          cursor: "pointer",
          fontSize: 11,
          ...mono,
        }}
      >
        {open ? "▾" : "▸"} attestations (advisory) · {summary}
      </button>
      {open && (
        <div style={{ marginTop: 4 }}>
          {loading && (
            <div style={{ color: DIM, fontSize: 11, padding: "4px 8px" }}>
              loading attestations…
            </div>
          )}
          {errored && (
            <div style={{ color: RED, fontSize: 11, padding: "4px 8px" }}>
              failed to load attestations
            </div>
          )}
          {events.length === 0 && !loading && (
            <div style={{ color: FAINT, fontSize: 11, padding: "4px 8px" }}>
              none persisted yet — advisory telemetry, no authority over the gate
            </div>
          )}
          <PromotionAttestationList events={events} />
        </div>
      )}
    </div>
  );
}

function PromotionAttestationPanelStatic(props: {
  recommendationId: string;
  events: ReadonlyArray<PromotionAttestationEvent>;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(props.initialOpen));
  return (
    <PanelShell
      recommendationId={props.recommendationId}
      events={props.events}
      open={open}
      onToggle={() => setOpen(o => !o)}
    />
  );
}

function PromotionAttestationPanelLive(props: {
  recommendationId: string;
  fetcher: () => Promise<PromotionAttestationsResponse>;
  initialOpen?: boolean;
}) {
  const { recommendationId, fetcher, initialOpen } = props;
  const [open, setOpen] = useState(Boolean(initialOpen));

  const query = useQuery<PromotionAttestationsResponse>({
    queryKey: [`/api/self-recommendations/${recommendationId}/attestations`],
    queryFn: fetcher,
    enabled: open,
    staleTime: 30_000,
  });

  const events: ReadonlyArray<PromotionAttestationEvent> =
    query.data?.attestations ?? [];

  return (
    <PanelShell
      recommendationId={recommendationId}
      events={events}
      open={open}
      onToggle={() => setOpen(o => !o)}
      loading={query.isLoading}
      errored={query.isError}
    />
  );
}
