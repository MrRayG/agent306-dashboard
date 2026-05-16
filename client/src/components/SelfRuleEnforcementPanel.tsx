/**
 * Read-only Self-Rule Enforcement panel. Consumed by the Agent 306
 * Autonomy Monitor page.
 *
 * VISIBILITY ONLY. There are no controls on this panel — no buttons that
 * POST, no toggles, no form inputs, no on-click handlers that mutate any
 * server state. The panel is a pure projection of the
 * `/api/autonomy/monitor` snapshot's `selfRuleEnforcement` block.
 *
 * Nothing in this component registers, mutates, disables, or schedules an
 * executable self-rule or corrective obligation. A ratio_rule deficit is
 * shown alongside the bounded, non-blocking corrective obligation it
 * produced; rendering the obligation does not give the user any control
 * surface to satisfy / cancel / archive it from this panel.
 */

import * as React from "react";

export interface SelfRuleEnforcementCounts {
  activeRules: number;
  byPrimitive: Record<string, number>;
  recentRegistrationEvents: number;
  recentRegistrationsSucceeded: number;
  recentRegistrationsRefused: number;
}

export interface LatestRegistration {
  emittedAt: string;
  recommendationId: string | null;
  sourceInsightId: string | null;
  primitive: string | null;
  ruleId: string | null;
  registered: boolean;
  reason?: string | null;
  translationReason?: string | null;
  summary: string;
}

export interface LatestRuleFiring {
  ruleId: string;
  insightId: string;
  primitive: string;
  fireCount: number;
  sideEffectCount: number;
  lastFiredAt: string | null;
  lastOutcome: string | null;
  summary: string;
}

export interface RatioRuleDeficit {
  ruleId: string;
  insightId: string;
  outputNoun: string | null;
  deficit: number | null;
  lastFiredAt: string | null;
  rawOutcome: string;
  expectedCount?: number | null;
  actualCount?: number | null;
  inputCount?: number | null;
  inputNoun?: string | null;
  fromStructuredEvent?: boolean;
  summary: string;
}

export interface CorrectiveObligationView {
  obligationId: string;
  ruleId: string;
  insightId: string;
  sourceInsightId: string;
  primitive: "ratio_rule";
  outputNoun: string;
  inputNoun: string;
  status: "open";
  createdAt: string;
  updatedAt: string;
  deficitCount: number;
  requiredActionCount: number;
  cap: number;
  expectedCount: number;
  actualCount: number;
  inputCount: number;
  refreshCount: number;
  deadlineNote: string;
  summary: string;
}

export interface LatestActionEnforcerTick {
  emittedAt: string;
  tickedAt: number | null;
  totalRules: number;
  rulesChecked: number;
  firedRules: number;
  sideEffects: number;
  byPrimitive: Record<string, number>;
  summary: string;
}

export interface SelfRuleEnforcementVisibility {
  generatedAt: string;
  headline: string;
  enforcementSemanticsNote: string;
  counts: SelfRuleEnforcementCounts;
  latestRegistrations: LatestRegistration[];
  latestFirings: LatestRuleFiring[];
  ratioDeficits: RatioRuleDeficit[];
  latestTick?: LatestActionEnforcerTick | null;
  correctiveObligations?: CorrectiveObligationView[];
  correctiveObligationCap?: number;
  visibilityLimitations: string[];
}

const mono = { fontFamily: "'Courier New', monospace" } as const;
const FG = "#e3e5e4";
const DIM = "rgba(227,229,228,0.55)";
const BORDER = "rgba(227,229,228,0.12)";
const YELLOW = "#fbbf24";
const BLUE = "#60a5fa";
const RED = "#f87171";
const GREEN = "#4ade80";

interface PanelProps {
  data: SelfRuleEnforcementVisibility;
}

export function SelfRuleEnforcementPanel({ data }: PanelProps): JSX.Element {
  const c = data.counts;
  return (
    <section
      data-testid="self-rule-enforcement-panel"
      style={{
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        padding: "1rem",
        marginBottom: "1rem",
        background: "#15171a",
      }}
    >
      <header style={{ marginBottom: "0.6rem" }}>
        <div
          style={{
            ...mono,
            fontSize: "0.78rem",
            color: DIM,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          Self-Rule Enforcement (read-only visibility)
        </div>
        <h2
          style={{
            ...mono,
            fontSize: "1.05rem",
            color: FG,
            margin: "0.3rem 0 0",
          }}
        >
          {data.headline}
        </h2>
      </header>

      <p
        data-testid="self-rule-enforcement-semantics-note"
        style={{
          ...mono,
          fontSize: "0.82rem",
          color: DIM,
          lineHeight: 1.45,
          margin: "0 0 0.8rem",
        }}
      >
        {data.enforcementSemanticsNote}
      </p>

      <Subhead label="Counts" />
      <ul
        data-testid="self-rule-enforcement-counts"
        style={{
          ...mono,
          fontSize: "0.84rem",
          color: FG,
          listStyle: "none",
          paddingLeft: 0,
          margin: "0 0 0.8rem",
        }}
      >
        <li>active executable rules: {c.activeRules}</li>
        <li>
          by primitive:{" "}
          {Object.keys(c.byPrimitive).length === 0
            ? "none"
            : Object.entries(c.byPrimitive)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")}
        </li>
        <li>
          recent ruleRegistrationOnApply events: {c.recentRegistrationEvents}{" "}
          (succeeded {c.recentRegistrationsSucceeded}, refused/errored{" "}
          {c.recentRegistrationsRefused})
        </li>
      </ul>

      <Subhead label="Latest ActionEnforcer tick" />
      {!data.latestTick ? (
        <Empty text="No ActionEnforcer tick event has been persisted yet." />
      ) : (
        <ul data-testid="self-rule-enforcement-latest-tick" style={listStyle()}>
          <li style={{ marginBottom: "0.5rem" }}>
            <div style={{ color: BLUE, fontSize: "0.84rem" }}>
              {data.latestTick.summary}
            </div>
            <div style={{ color: DIM, fontSize: "0.74rem" }}>
              tickedAt=
              {data.latestTick.tickedAt
                ? new Date(data.latestTick.tickedAt).toISOString()
                : "unknown"}
              {" · "}registered={data.latestTick.totalRules}
              {" · "}checked={data.latestTick.rulesChecked}
              {" · "}fired={data.latestTick.firedRules}
              {" · "}sideEffects={data.latestTick.sideEffects}
            </div>
          </li>
        </ul>
      )}

      <Subhead label="Latest rule registrations from the apply path" />
      {data.latestRegistrations.length === 0 ? (
        <Empty text="No ruleRegistrationOnApply events have been persisted yet." />
      ) : (
        <ul
          data-testid="self-rule-enforcement-registrations"
          style={listStyle()}
        >
          {data.latestRegistrations.slice(0, 5).map((r, i) => (
            <li
              key={`${r.recommendationId ?? "rec"}-${i}`}
              style={{ marginBottom: "0.5rem" }}
            >
              <div
                style={{
                  color: r.registered ? GREEN : YELLOW,
                  fontSize: "0.84rem",
                }}
              >
                {r.summary}
              </div>
              <div style={{ color: DIM, fontSize: "0.74rem" }}>
                {r.ruleId ? `ruleId=${r.ruleId} · ` : ""}
                {r.primitive ? `primitive=${r.primitive} · ` : ""}
                {r.sourceInsightId ? `insight=${r.sourceInsightId}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Subhead label="Latest rule firings" />
      {data.latestFirings.length === 0 ? (
        <Empty text="No registered rule has fired yet." />
      ) : (
        <ul data-testid="self-rule-enforcement-firings" style={listStyle()}>
          {data.latestFirings.map((f) => (
            <li key={f.ruleId} style={{ marginBottom: "0.5rem" }}>
              <div style={{ color: BLUE, fontSize: "0.84rem" }}>
                {f.summary}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Subhead label="Ratio rule deficits (diagnostic / observable only)" />
      {data.ratioDeficits.length === 0 ? (
        <Empty text="No ratio_rule currently logs a deficit on its most recent firing." />
      ) : (
        <ul data-testid="self-rule-enforcement-deficits" style={listStyle()}>
          {data.ratioDeficits.map((d) => {
            const showStructured =
              d.fromStructuredEvent === true &&
              d.actualCount != null &&
              d.expectedCount != null &&
              d.inputCount != null &&
              d.inputNoun;
            return (
              <li key={d.ruleId} style={{ marginBottom: "0.5rem" }}>
                <div style={{ color: RED, fontSize: "0.84rem" }}>
                  {d.summary}
                </div>
                {showStructured && (
                  <div style={{ color: DIM, fontSize: "0.74rem" }}>
                    have={d.actualCount}
                    {" · "}expected={d.expectedCount}
                    {" · "}for {d.inputCount} {d.inputNoun}
                  </div>
                )}
                <div style={{ color: DIM, fontSize: "0.74rem" }}>
                  Rule fired; deficit observed; a bounded corrective
                  obligation has been queued for the next cycle (see below).
                  This is not a hard block.
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Subhead label="Open corrective obligations (bounded, non-blocking)" />
      {(!data.correctiveObligations || data.correctiveObligations.length === 0) ? (
        <Empty text="No open corrective obligations are currently queued from ratio_rule deficits." />
      ) : (
        <ul
          data-testid="self-rule-enforcement-corrective-obligations"
          style={listStyle()}
        >
          {data.correctiveObligations.map((o) => (
            <li
              key={o.obligationId}
              data-testid={`corrective-obligation-${o.obligationId}`}
              style={{ marginBottom: "0.5rem" }}
            >
              <div style={{ color: YELLOW, fontSize: "0.84rem" }}>
                {o.summary}
              </div>
              <div style={{ color: DIM, fontSize: "0.74rem" }}>
                obligationId={o.obligationId}
                {" · "}ruleId={o.ruleId}
                {" · "}required={o.requiredActionCount} {o.outputNoun}
                {" · "}cap={o.cap}
                {" · "}raw deficit={o.deficitCount}
                {" · "}refreshed {o.refreshCount}×
              </div>
              <div style={{ color: DIM, fontSize: "0.74rem" }}>
                opened={o.createdAt}
                {" · "}updated={o.updatedAt}
                {o.deadlineNote ? ` · deadline=${o.deadlineNote}` : ""}
              </div>
              <div style={{ color: DIM, fontSize: "0.74rem" }}>
                Not a hard block. Read-only on this panel — no control here
                satisfies, cancels, or auto-archives this obligation.
              </div>
            </li>
          ))}
        </ul>
      )}

      <details
        data-testid="self-rule-enforcement-limitations"
        style={{ marginTop: "0.6rem" }}
      >
        <summary
          style={{
            ...mono,
            fontSize: "0.78rem",
            color: DIM,
            cursor: "default",
          }}
        >
          What this panel does NOT yet show
        </summary>
        <ul style={{ ...listStyle(), marginTop: "0.4rem" }}>
          {data.visibilityLimitations.map((line, i) => (
            <li
              key={i}
              style={{ color: DIM, fontSize: "0.76rem", marginBottom: "0.3rem" }}
            >
              {line}
            </li>
          ))}
        </ul>
      </details>

      <div
        style={{
          ...mono,
          marginTop: "0.7rem",
          fontSize: "0.72rem",
          color: DIM,
        }}
      >
        snapshot generated at {data.generatedAt}
      </div>
    </section>
  );
}

function Subhead({ label }: { label: string }): JSX.Element {
  return (
    <div
      style={{
        ...mono,
        fontSize: "0.72rem",
        color: DIM,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        marginBottom: "0.25rem",
      }}
    >
      {label}
    </div>
  );
}

function Empty({ text }: { text: string }): JSX.Element {
  return (
    <div
      style={{
        ...mono,
        fontSize: "0.8rem",
        color: DIM,
        marginBottom: "0.7rem",
      }}
    >
      {text}
    </div>
  );
}

function listStyle(): React.CSSProperties {
  return {
    ...mono,
    listStyle: "none",
    paddingLeft: 0,
    margin: "0 0 0.6rem",
  };
}
