/**
 * PR-G — Validity baseline panel + manual known-bad probe trigger.
 *
 * Renders read-only aggregates from /api/diagnostic/validity/summary plus
 * a manual probe button hitting /api/diagnostic/validity/known-bad-probe.
 *
 * The panel is intentionally a pure render component:
 *   - No internal data fetching beyond the two endpoints above.
 *   - No global state, no hooks beyond useState/useEffect.
 *   - The fetcher is injected so node:test can drive caught/missed paths
 *     via stub callbacks.
 *
 * Hard rules from the spec mirrored here:
 *   - Cells with validity=1.000 AND count>=5 get a "ceiling-effect candidate"
 *     visual flag (informational, not blocking).
 *   - Cells with count<5 are de-emphasized as low-confidence.
 *   - Aggregate value gets an N<30 hint OR a "ceiling-effect candidate" hint
 *     when N>=30 AND aggregate=1.000.
 *   - Probe outcome=missed gets prominent warning treatment.
 */

import { useEffect, useState } from "react";

// ── Server-mirror types ─────────────────────────────────────────────────────
export interface StratumRow {
  key: string;
  count: number;
  validity: number;
}

export interface ProbeHistoryRow {
  trialRecordId: number;
  outcome: "caught" | "missed";
  outcomeMetric: number | null;
  recordedAt: string;
  outcomeRecordedAt: string | null;
}

export interface ValiditySummary {
  totalGraded: number;
  baselineCount: number;
  treatmentCount: number;
  aggregateValidity: number;
  lastTrialAt: string | null;
  byTaskShape: StratumRow[];
  byEngine: StratumRow[];
  byModel: StratumRow[];
  probes: ProbeHistoryRow[];
}

export interface ProbeResult {
  probeId: string;
  trialRecordId: number | null;
  outcome: "caught" | "missed";
  triggeredAt: string;
  malformedInput: string;
  outcomeMetric: number;
}

export interface ValidityBaselineFetchers {
  /** GET /api/diagnostic/validity/summary */
  fetchSummary: () => Promise<ValiditySummary>;
  /** POST /api/diagnostic/validity/known-bad-probe */
  triggerProbe: () => Promise<ProbeResult>;
}

// ── Visual constants — mirror Diagnostics.tsx ────────────────────────────────
const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = {
  fontFamily: "'Courier New', monospace",
  textTransform: "uppercase" as const,
  letterSpacing: "0.15em",
} as const;

const SURFACE = "#141516";
const BORDER = "1px solid rgba(227,229,228,0.15)";
const TEXT = "#e3e5e4";
const TEXT_DIM = "rgba(227,229,228,0.45)";
const TEXT_FAINT = "rgba(227,229,228,0.48)";
const GREEN = "#4ade80";
const PURPLE = "#a78bfa";
const RED = "#f87171";
const YELLOW = "#fbbf24";

// Spec thresholds — kept named so the regression tests can pin them.
export const READOUT_THRESHOLD_N = 30;
export const CEILING_FLAG_MIN_COUNT = 5;
export const CEILING_FLAG_VALIDITY = 1;

// ── Helpers ─────────────────────────────────────────────────────────────────
function fmtValidity(v: number): string {
  if (!Number.isFinite(v)) return "—";
  // Three decimal places to match the existing readout convention
  // ("json_validity=1.000" in the Phase 1 status line).
  return v.toFixed(3);
}

export function isCeilingFlagCell(row: { count: number; validity: number }): boolean {
  return row.count >= CEILING_FLAG_MIN_COUNT && row.validity === CEILING_FLAG_VALIDITY;
}

export function isLowConfidenceCell(row: { count: number }): boolean {
  return row.count < CEILING_FLAG_MIN_COUNT;
}

// ── Subcomponents ───────────────────────────────────────────────────────────
function StratumTable({ title, rows }: { title: string; rows: StratumRow[] }) {
  return (
    <div data-testid={`stratum-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <div style={{ ...pixel, fontSize: "10px", color: TEXT_FAINT, marginBottom: "0.4rem" }}>
        {title}
      </div>
      {rows.length === 0 ? (
        <div style={{ ...mono, fontSize: "12px", color: TEXT_FAINT, padding: "0.5rem 0" }}>
          No graded trials yet for this stratum.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", ...mono, fontSize: "12px" }}>
          <thead>
            <tr style={{ borderBottom: BORDER, color: TEXT_FAINT }}>
              <th style={{ ...pixel, fontSize: "10px", textAlign: "left", padding: "0.4rem 0.6rem" }}>Stratum</th>
              <th style={{ ...pixel, fontSize: "10px", textAlign: "right", padding: "0.4rem 0.6rem", width: 70 }}>N</th>
              <th style={{ ...pixel, fontSize: "10px", textAlign: "right", padding: "0.4rem 0.6rem", width: 110 }}>Validity</th>
              <th style={{ ...pixel, fontSize: "10px", textAlign: "left", padding: "0.4rem 0.6rem", width: 200 }}>Flag</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const lowConf = isLowConfidenceCell(r);
              const ceiling = isCeilingFlagCell(r);
              const rowColor = lowConf ? TEXT_FAINT : TEXT;
              return (
                <tr
                  key={r.key}
                  data-testid={`stratum-row-${r.key}`}
                  data-low-confidence={lowConf ? "true" : "false"}
                  data-ceiling-flag={ceiling ? "true" : "false"}
                  style={{
                    borderBottom: "1px solid rgba(227,229,228,0.06)",
                    background: ceiling ? "rgba(251,191,36,0.06)" : "transparent",
                    opacity: lowConf ? 0.62 : 1,
                  }}
                >
                  <td style={{ padding: "0.4rem 0.6rem", color: rowColor }}>{r.key}</td>
                  <td style={{ padding: "0.4rem 0.6rem", color: rowColor, textAlign: "right" }}>{r.count}</td>
                  <td style={{ padding: "0.4rem 0.6rem", color: rowColor, textAlign: "right" }}>{fmtValidity(r.validity)}</td>
                  <td style={{ padding: "0.4rem 0.6rem", fontSize: "10.5px" }}>
                    {ceiling && (
                      <span
                        data-testid="ceiling-flag-chip"
                        style={{
                          ...pixel,
                          fontSize: "9.5px",
                          color: YELLOW,
                          background: "rgba(251,191,36,0.10)",
                          border: `1px solid ${YELLOW}55`,
                          padding: "1px 6px",
                        }}
                      >
                        CEILING-EFFECT CANDIDATE
                      </span>
                    )}
                    {lowConf && !ceiling && (
                      <span
                        data-testid="low-confidence-chip"
                        style={{
                          ...pixel,
                          fontSize: "9.5px",
                          color: TEXT_FAINT,
                          border: `1px solid rgba(227,229,228,0.18)`,
                          padding: "1px 6px",
                        }}
                      >
                        N&lt;{CEILING_FLAG_MIN_COUNT} · LOW CONFIDENCE
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────
export function ValidityBaselinePanel(props: {
  fetchers: ValidityBaselineFetchers;
  /** Optional: skip the auto-fetch on mount (used by tests to control timing). */
  autoFetch?: boolean;
  /** Optional: preseed the rendered summary so renderToString-based tests
   *  can assert on the loaded view without depending on useEffect. */
  initialSummary?: ValiditySummary | null;
  /** Optional: preseed the most recent probe result for the same reason. */
  initialProbeResult?: ProbeResult | null;
}) {
  const { fetchers } = props;
  const autoFetch = props.autoFetch ?? true;

  const [summary, setSummary] = useState<ValiditySummary | null>(props.initialSummary ?? null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(props.initialProbeResult ?? null);
  const [probing, setProbing] = useState<boolean>(false);
  const [showRaw, setShowRaw] = useState<boolean>(false);

  async function loadSummary() {
    setLoading(true);
    setError(null);
    try {
      const s = await fetchers.fetchSummary();
      setSummary(s);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runProbe() {
    setProbing(true);
    try {
      const r = await fetchers.triggerProbe();
      setProbeResult(r);
      // Refresh the summary so the new probe row appears in the probe history.
      await loadSummary();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setProbing(false);
    }
  }

  useEffect(() => {
    if (autoFetch) loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Aggregate hint computation ────────────────────────────────────────────
  const N = summary?.totalGraded ?? 0;
  const aggregate = summary?.aggregateValidity ?? 0;
  const showBelowThresholdHint = !!summary && N < READOUT_THRESHOLD_N;
  const showCeilingAggregateHint = !!summary && N >= READOUT_THRESHOLD_N && aggregate === CEILING_FLAG_VALIDITY;

  return (
    <section
      data-testid="validity-baseline-panel"
      style={{ background: SURFACE, border: BORDER, padding: "1.5rem", marginBottom: "1.5rem" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem", marginBottom: "1rem" }}>
        <div>
          <div style={{ ...pixel, fontSize: "11px", color: PURPLE, marginBottom: "0.4rem" }}>
            VALIDITY BASELINE
          </div>
          <div style={{ ...mono, fontSize: "12px", color: TEXT_DIM }}>
            GET /api/diagnostic/validity/summary · stratified by task shape, engine, model · probe rows excluded
          </div>
        </div>
        <button
          onClick={runProbe}
          disabled={probing}
          data-testid="run-known-bad-probe"
          style={{
            ...mono,
            fontSize: "13px",
            padding: "10px 20px",
            background: `${YELLOW}18`,
            border: `1px solid ${YELLOW}66`,
            color: YELLOW,
            cursor: probing ? "not-allowed" : "pointer",
            opacity: probing ? 0.5 : 1,
          }}
        >
          {probing ? "RUNNING…" : "▶ RUN KNOWN-BAD PROBE"}
        </button>
      </div>

      {loading && !summary && (
        <div style={{ ...mono, fontSize: "13px", color: TEXT_FAINT, padding: "1rem 0" }}>Loading…</div>
      )}

      {error && (
        <div
          data-testid="validity-error"
          style={{
            ...mono,
            fontSize: "13px",
            color: RED,
            padding: "0.75rem",
            border: `1px solid ${RED}66`,
            background: `${RED}14`,
            marginBottom: "1rem",
          }}
        >
          {error}
        </div>
      )}

      {summary && (
        <>
          {/* Header row — totals + aggregate */}
          <div
            data-testid="validity-header"
            style={{
              ...mono,
              fontSize: "12px",
              color: TEXT_DIM,
              padding: "0.6rem 0.75rem",
              background: "rgba(255,255,255,0.02)",
              border: BORDER,
              marginBottom: "1rem",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "0.75rem",
            }}
          >
            <div>
              <div style={{ ...pixel, fontSize: "9.5px", color: TEXT_FAINT }}>TOTAL GRADED (N)</div>
              <div data-testid="validity-N" style={{ color: TEXT, fontSize: "1.05rem", marginTop: 4 }}>{N}</div>
            </div>
            <div>
              <div style={{ ...pixel, fontSize: "9.5px", color: TEXT_FAINT }}>BASELINE</div>
              <div style={{ color: TEXT, fontSize: "1.05rem", marginTop: 4 }}>{summary.baselineCount}</div>
            </div>
            <div>
              <div style={{ ...pixel, fontSize: "9.5px", color: TEXT_FAINT }}>TREATMENT</div>
              <div style={{ color: TEXT, fontSize: "1.05rem", marginTop: 4 }}>{summary.treatmentCount}</div>
            </div>
            <div>
              <div style={{ ...pixel, fontSize: "9.5px", color: TEXT_FAINT }}>AGGREGATE VALIDITY</div>
              <div data-testid="validity-aggregate" style={{ color: TEXT, fontSize: "1.05rem", marginTop: 4 }}>{fmtValidity(aggregate)}</div>
            </div>
            <div>
              <div style={{ ...pixel, fontSize: "9.5px", color: TEXT_FAINT }}>LAST TRIAL</div>
              <div style={{ color: TEXT, fontSize: "12px", marginTop: 4 }}>
                {summary.lastTrialAt ? new Date(summary.lastTrialAt).toLocaleString() : "—"}
              </div>
            </div>
          </div>

          {showBelowThresholdHint && (
            <div
              data-testid="below-threshold-hint"
              style={{
                ...mono,
                fontSize: "12px",
                color: PURPLE,
                background: "rgba(167,139,250,0.07)",
                border: `1px solid ${PURPLE}40`,
                padding: "0.5rem 0.75rem",
                marginBottom: "0.75rem",
              }}
            >
              N&lt;{READOUT_THRESHOLD_N}: below readout threshold. Aggregate validity is informational only at this sample size.
            </div>
          )}
          {showCeilingAggregateHint && (
            <div
              data-testid="ceiling-aggregate-hint"
              style={{
                ...mono,
                fontSize: "12px",
                color: YELLOW,
                background: "rgba(251,191,36,0.08)",
                border: `1px solid ${YELLOW}55`,
                padding: "0.5rem 0.75rem",
                marginBottom: "0.75rem",
              }}
            >
              Ceiling-effect candidate: aggregate validity is exactly {CEILING_FLAG_VALIDITY.toFixed(3)} at N≥{READOUT_THRESHOLD_N}. The metric may be trivially easy or silently failing closed — review before scheduling Phase 1.5.
            </div>
          )}

          {/* Stratified breakdowns */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1rem", marginBottom: "1rem" }}>
            <StratumTable title="By task shape" rows={summary.byTaskShape} />
            <StratumTable title="By engine" rows={summary.byEngine} />
            <StratumTable title="By model" rows={summary.byModel} />
          </div>

          {/* Probe section */}
          <div data-testid="probe-section" style={{ marginTop: "1.25rem", paddingTop: "0.85rem", borderTop: BORDER }}>
            <div style={{ ...pixel, fontSize: "10px", color: TEXT_FAINT, marginBottom: "0.45rem" }}>
              KNOWN-BAD PROBE
            </div>

            {!probeResult && summary.probes.length === 0 && (
              <div style={{ ...mono, fontSize: "12px", color: TEXT_FAINT }}>
                No probe has run yet. Click the button above to inject one deliberately malformed-JSON trial through the real metric pipeline.
              </div>
            )}

            {probeResult && (
              <div
                data-testid="probe-result"
                data-outcome={probeResult.outcome}
                style={{
                  border: `1px solid ${probeResult.outcome === "missed" ? RED : GREEN}66`,
                  background: probeResult.outcome === "missed" ? `${RED}12` : `${GREEN}10`,
                  padding: "0.75rem",
                  marginBottom: "0.75rem",
                }}
              >
                <div style={{ ...mono, fontSize: "13px", color: probeResult.outcome === "missed" ? RED : GREEN, fontWeight: 700 }}>
                  {probeResult.outcome === "missed"
                    ? "⚠ PROBE MISSED — metric pipeline failed to flag known-bad input"
                    : "✓ PROBE CAUGHT — metric pipeline correctly registered failure"}
                </div>
                <div style={{ ...mono, fontSize: "11.5px", color: TEXT_DIM, marginTop: 4 }}>
                  probeId <span style={{ color: TEXT }}>{probeResult.probeId}</span> · trial record <span style={{ color: TEXT }}>{probeResult.trialRecordId ?? "—"}</span> · {new Date(probeResult.triggeredAt).toLocaleString()} · outcomeMetric=<span style={{ color: TEXT }}>{probeResult.outcomeMetric.toFixed(1)}</span>
                </div>
                <button
                  onClick={() => setShowRaw((v) => !v)}
                  data-testid="toggle-raw-probe"
                  style={{
                    ...mono,
                    fontSize: "10.5px",
                    background: "transparent",
                    border: BORDER,
                    color: TEXT_FAINT,
                    cursor: "pointer",
                    padding: "2px 8px",
                    marginTop: 6,
                  }}
                >
                  {showRaw ? "HIDE RAW RECORD" : "SHOW RAW RECORD"}
                </button>
                {showRaw && (
                  <pre
                    data-testid="probe-raw"
                    style={{
                      ...mono,
                      fontSize: "11px",
                      color: TEXT_DIM,
                      whiteSpace: "pre-wrap",
                      marginTop: 6,
                      background: "rgba(0,0,0,0.25)",
                      padding: "0.5rem",
                      maxHeight: 220,
                      overflowY: "auto",
                    }}
                  >
                    {JSON.stringify(probeResult, null, 2)}
                  </pre>
                )}
              </div>
            )}

            {summary.probes.length > 0 && (
              <div data-testid="probe-history">
                <div style={{ ...pixel, fontSize: "9.5px", color: TEXT_FAINT, marginBottom: 4 }}>RECENT PROBE TRIALS</div>
                <table style={{ width: "100%", borderCollapse: "collapse", ...mono, fontSize: "11.5px" }}>
                  <thead>
                    <tr style={{ borderBottom: BORDER, color: TEXT_FAINT }}>
                      <th style={{ ...pixel, fontSize: "9.5px", textAlign: "left", padding: "0.3rem 0.5rem" }}>Trial #</th>
                      <th style={{ ...pixel, fontSize: "9.5px", textAlign: "left", padding: "0.3rem 0.5rem" }}>Outcome</th>
                      <th style={{ ...pixel, fontSize: "9.5px", textAlign: "left", padding: "0.3rem 0.5rem" }}>Metric</th>
                      <th style={{ ...pixel, fontSize: "9.5px", textAlign: "left", padding: "0.3rem 0.5rem" }}>Recorded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.probes.slice(0, 10).map((p) => (
                      <tr key={p.trialRecordId} data-testid={`probe-history-row-${p.trialRecordId}`} style={{ borderBottom: "1px solid rgba(227,229,228,0.05)" }}>
                        <td style={{ padding: "0.3rem 0.5rem", color: TEXT }}>#{p.trialRecordId}</td>
                        <td style={{ padding: "0.3rem 0.5rem", color: p.outcome === "missed" ? RED : GREEN, fontWeight: 700 }}>{p.outcome.toUpperCase()}</td>
                        <td style={{ padding: "0.3rem 0.5rem", color: TEXT_DIM }}>{p.outcomeMetric == null ? "—" : p.outcomeMetric.toFixed(1)}</td>
                        <td style={{ padding: "0.3rem 0.5rem", color: TEXT_DIM }}>{(p.outcomeRecordedAt ?? p.recordedAt) ? new Date(p.outcomeRecordedAt ?? p.recordedAt).toLocaleString() : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
