import { useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ─── Typography ──────────────────────────────────────────────────────────────
const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = {
  fontFamily: "'Courier New', monospace",
  textTransform: "uppercase" as const,
  letterSpacing: "0.15em",
} as const;

// ─── Colors (match PodcastStudio) ────────────────────────────────────────────
const BG = "#0a0b0d";
const SURFACE = "#141516";
const BORDER = "1px solid rgba(227,229,228,0.15)";
const TEXT = "#e3e5e4";
const TEXT_DIM = "rgba(227,229,228,0.45)";
const TEXT_FAINT = "rgba(227,229,228,0.48)";
const GREEN = "#4ade80";
const PURPLE = "#a78bfa";
const BLUE = "#60a5fa";
const RED = "#f87171";
const YELLOW = "#fbbf24";
const ORANGE = "#f97316";

type Probe = {
  label: string;
  method: "GET" | "POST";
  url: string;
  status?: number;
  ok?: boolean;
  snippet?: string;
  error?: string;
};

type ProbeResponse = {
  keyFingerprint: string;
  timestamp: string;
  probes: Probe[];
};

function ActionButton({
  onClick,
  color,
  disabled,
  children,
}: {
  onClick: () => void;
  color: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...mono,
        fontSize: "13px",
        padding: "10px 20px",
        background: `${color}18`,
        border: `1px solid ${color}66`,
        color,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function statusColor(p: Probe): string {
  if (p.error) return RED;
  if (p.ok) return GREEN;
  if (p.status === 401) return RED;
  if (p.status === 403) return YELLOW;
  if (p.status && p.status >= 500) return RED;
  return TEXT_DIM;
}

function statusLabel(p: Probe): string {
  if (p.error) return "ERROR";
  if (p.ok) return `${p.status} OK`;
  if (p.status) return `${p.status} FAIL`;
  return "—";
}

export default function Diagnostics() {
  const { toast } = useToast();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProbeResponse | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  async function runProbe() {
    setRunning(true);
    setLastError(null);
    try {
      const res = await apiRequest("GET", "/api/diagnostic/xai-entitlement");
      const json = (await res.json()) as ProbeResponse;
      setResult(json);
      const failing = json.probes.filter((p) => !p.ok).length;
      toast({
        title: failing === 0 ? "All probes passed" : `${failing} / ${json.probes.length} probes failed`,
        description: `key ${json.keyFingerprint}`,
        variant: failing === 0 ? "default" : "destructive",
      });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setLastError(msg);
      toast({
        title: "Probe request failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: BG, color: TEXT, padding: "2rem 2.5rem" }}>
      {/* Header */}
      <div style={{ marginBottom: "2rem" }}>
        <div style={{ ...pixel, fontSize: "12px", color: TEXT_FAINT, marginBottom: "0.5rem" }}>
          SYSTEM · PROBES
        </div>
        <div style={{ ...mono, fontSize: "1.6rem", color: TEXT, letterSpacing: "0.05em" }}>
          Diagnostics
        </div>
        <div
          style={{
            ...mono,
            fontSize: "13px",
            color: TEXT_DIM,
            marginTop: "0.5rem",
            maxWidth: "720px",
            lineHeight: 1.55,
          }}
        >
          Run read-only probes against api.x.ai with the live GROK_API_KEY. Confirms key validity,
          team entitlements, and which endpoints (chat, models, TTS) return 200 vs 403. No secrets
          are ever echoed — only a fingerprint like <code>xai-xx…yyyy (len=84)</code>.
        </div>
      </div>

      {/* xAI Entitlement card */}
      <section
        style={{
          background: SURFACE,
          border: BORDER,
          padding: "1.5rem",
          marginBottom: "1.5rem",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1rem",
            flexWrap: "wrap",
            gap: "1rem",
          }}
        >
          <div>
            <div style={{ ...pixel, fontSize: "11px", color: PURPLE, marginBottom: "0.4rem" }}>
              XAI ENTITLEMENT PROBE
            </div>
            <div style={{ ...mono, fontSize: "12px", color: TEXT_DIM }}>
              GET /api/diagnostic/xai-entitlement · 5 endpoints · parallel
            </div>
          </div>
          <ActionButton onClick={runProbe} color={PURPLE} disabled={running}>
            {running ? "RUNNING…" : "▶ RUN XAI PROBE"}
          </ActionButton>
        </div>

        {/* Metadata line */}
        {result && (
          <div
            style={{
              ...mono,
              fontSize: "12px",
              color: TEXT_DIM,
              padding: "0.6rem 0.75rem",
              background: "rgba(255,255,255,0.02)",
              border: BORDER,
              marginBottom: "1rem",
              display: "flex",
              justifyContent: "space-between",
              gap: "1rem",
              flexWrap: "wrap",
            }}
          >
            <span>
              KEY: <span style={{ color: TEXT }}>{result.keyFingerprint}</span>
            </span>
            <span>
              RAN: <span style={{ color: TEXT }}>{new Date(result.timestamp).toLocaleString()}</span>
            </span>
          </div>
        )}

        {lastError && (
          <div
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
            {lastError}
          </div>
        )}

        {!result && !lastError && !running && (
          <div style={{ ...mono, fontSize: "13px", color: TEXT_FAINT, padding: "1rem 0" }}>
            No probe has been run yet. Click <span style={{ color: PURPLE }}>RUN XAI PROBE</span>{" "}
            above — typically takes 2–5 seconds.
          </div>
        )}

        {/* Results table */}
        {result && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", ...mono, fontSize: "13px" }}>
              <thead>
                <tr style={{ borderBottom: BORDER, color: TEXT_FAINT }}>
                  <th style={{ ...pixel, fontSize: "10px", textAlign: "left", padding: "0.5rem 0.75rem" }}>
                    Probe
                  </th>
                  <th style={{ ...pixel, fontSize: "10px", textAlign: "left", padding: "0.5rem 0.75rem", width: "70px" }}>
                    Method
                  </th>
                  <th style={{ ...pixel, fontSize: "10px", textAlign: "left", padding: "0.5rem 0.75rem", width: "110px" }}>
                    Status
                  </th>
                  <th style={{ ...pixel, fontSize: "10px", textAlign: "left", padding: "0.5rem 0.75rem" }}>
                    Response snippet
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.probes.map((p, i) => (
                  <tr
                    key={i}
                    style={{
                      borderBottom: "1px solid rgba(227,229,228,0.06)",
                      verticalAlign: "top",
                    }}
                  >
                    <td style={{ padding: "0.75rem", color: TEXT }}>
                      <div>{p.label}</div>
                      <div style={{ color: TEXT_FAINT, fontSize: "11px", marginTop: "0.2rem" }}>
                        {p.url}
                      </div>
                    </td>
                    <td style={{ padding: "0.75rem", color: BLUE }}>{p.method}</td>
                    <td style={{ padding: "0.75rem", color: statusColor(p), fontWeight: 600 }}>
                      {statusLabel(p)}
                    </td>
                    <td
                      style={{
                        padding: "0.75rem",
                        color: TEXT_DIM,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontSize: "12px",
                        maxWidth: "520px",
                      }}
                    >
                      {p.error ? <span style={{ color: RED }}>{p.error}</span> : p.snippet || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Legend / guidance */}
      <section
        style={{
          background: SURFACE,
          border: BORDER,
          padding: "1.25rem 1.5rem",
          ...mono,
          fontSize: "12px",
          color: TEXT_DIM,
          lineHeight: 1.6,
        }}
      >
        <div style={{ ...pixel, fontSize: "11px", color: TEXT_FAINT, marginBottom: "0.6rem" }}>
          INTERPRETING RESULTS
        </div>
        <div>
          <span style={{ color: GREEN }}>● 200 OK</span> — endpoint entitled. Chat-completions 200
          means we can migrate Grok LLM calls to xAI-direct (PR O).
        </div>
        <div>
          <span style={{ color: YELLOW }}>● 403</span> — team not authorized for that endpoint.
          Widespread 403 means contact{" "}
          <a href="mailto:support@x.ai" style={{ color: ORANGE }}>
            support@x.ai
          </a>{" "}
          with the team ID from console.x.ai.
        </div>
        <div>
          <span style={{ color: RED }}>● 401</span> — key is invalid or revoked. Rotate{" "}
          <code>GROK_API_KEY</code> in Railway env.
        </div>
      </section>
    </div>
  );
}
