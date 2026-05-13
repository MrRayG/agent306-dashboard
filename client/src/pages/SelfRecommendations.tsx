import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  PromotionAttestationPanel,
  type PromotionAttestationsResponse,
} from "@/components/PromotionAttestationPanel";

interface SelfRecommendation {
  id: string;
  category: string;
  risk: string;
  title: string;
  rationale: string;
  proposedChange: string;
  proposedDiff?: string | null;
  evidence: string[];
  status: string;
  author: string;
  createdAt: string;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  appliedAt?: string | null;
  revertedAt?: string | null;
  approvedBy?: string | null;
  reviewNote?: string | null;
  prUrl?: string | null;
  patchPath?: string | null;
  sourceHypothesisId?: string | null;
  sourceInsightId?: string | null;
}

const STATUSES = ["proposed", "approved", "rejected", "applied", "reverted"] as const;
type StatusFilter = (typeof STATUSES)[number] | "all";

const mono = { fontFamily: "'Courier New', monospace" } as const;
const BG = "#0e0f10";
const FG = "#e3e5e4";
const DIM = "rgba(227,229,228,0.55)";
const ORANGE = "#f97316";
const GREEN = "#4ade80";
const RED = "#f87171";
const YELLOW = "#fbbf24";

function statusColor(s: string): string {
  switch (s) {
    case "approved": return GREEN;
    case "applied":  return GREEN;
    case "rejected": return RED;
    case "reverted": return YELLOW;
    default:         return ORANGE;
  }
}

export default function SelfRecommendations() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<StatusFilter>("proposed");
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});

  const listUrl = filter === "all"
    ? "/api/self-recommendations"
    : `/api/self-recommendations?status=${filter}`;

  const { data, isLoading } = useQuery<{ recommendations: SelfRecommendation[] }>({
    queryKey: [listUrl],
    refetchInterval: 30_000,
  });

  const recs = data?.recommendations ?? [];

  function action(method: string, id: string, action: string, body: Record<string, unknown> = {}) {
    return apiRequest(method, `/api/self-recommendations/${id}/${action}`, body).then(r => r.json());
  }

  const approveMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => action("POST", id, "approve", { operator: "operator", note }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [listUrl] }),
  });
  const rejectMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => action("POST", id, "reject", { operator: "operator", note }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [listUrl] }),
  });
  const applyMut = useMutation({
    mutationFn: ({ id }: { id: string }) => action("POST", id, "apply", { operator: "operator" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [listUrl] }),
  });
  const revertMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => action("POST", id, "revert", { operator: "operator", note }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [listUrl] }),
  });
  const draftPrMut = useMutation({
    mutationFn: ({ id }: { id: string }) => action("POST", id, "draft-pr"),
    onSuccess: () => qc.invalidateQueries({ queryKey: [listUrl] }),
  });

  return (
    <div style={{ background: BG, color: FG, minHeight: "100vh", padding: 24, ...mono }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, color: ORANGE, margin: "0 0 16px" }}>
          SELF-RECOMMENDATIONS · propose-only
        </h1>
        <p style={{ color: DIM, marginTop: 0, marginBottom: 16 }}>
          Agent 306 may propose; humans approve. Nothing on this page is auto-applied.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {(["all", ...STATUSES] as StatusFilter[]).map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              style={{
                padding: "6px 12px",
                background: filter === s ? ORANGE : "transparent",
                color: filter === s ? BG : FG,
                border: `1px solid ${filter === s ? ORANGE : DIM}`,
                borderRadius: 4,
                cursor: "pointer",
                ...mono,
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {isLoading && <div style={{ color: DIM }}>Loading…</div>}
        {!isLoading && recs.length === 0 && (
          <div style={{ color: DIM, padding: 32, textAlign: "center" }}>
            No recommendations matching filter <code>{filter}</code>.
          </div>
        )}

        {recs.map(rec => (
          <div
            key={rec.id}
            style={{
              border: `1px solid rgba(227,229,228,0.14)`,
              borderRadius: 6,
              padding: 16,
              marginBottom: 12,
              background: "rgba(255,255,255,0.02)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
              <strong style={{ color: FG, fontSize: 14 }}>{rec.title}</strong>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ color: statusColor(rec.status), fontSize: 12 }}>{rec.status}</span>
                <span style={{ color: DIM, fontSize: 12 }}>{rec.category} · {rec.risk}</span>
              </div>
            </div>
            <div style={{ color: DIM, fontSize: 12, marginBottom: 6 }}>
              {rec.author} · {new Date(rec.createdAt).toLocaleString()} · id={rec.id}
            </div>
            <div style={{ marginBottom: 8, fontSize: 13 }}><strong>Why:</strong> {rec.rationale}</div>
            <div style={{ marginBottom: 8, fontSize: 13, whiteSpace: "pre-wrap" }}><strong>Change:</strong> {rec.proposedChange}</div>
            {rec.evidence.length > 0 && (
              <div style={{ color: DIM, fontSize: 12, marginBottom: 8 }}>
                evidence: {rec.evidence.join(", ")}
              </div>
            )}
            {rec.prUrl && (
              <div style={{ marginBottom: 8, fontSize: 12 }}>
                PR: <a href={rec.prUrl} style={{ color: ORANGE }}>{rec.prUrl}</a>
              </div>
            )}
            {rec.patchPath && (
              <div style={{ marginBottom: 8, fontSize: 12, color: DIM }}>patch: {rec.patchPath}</div>
            )}
            <PromotionAttestationPanel
              recommendationId={rec.id}
              fetcher={() =>
                apiRequest("GET", `/api/self-recommendations/${rec.id}/attestations`)
                  .then(r => r.json() as Promise<PromotionAttestationsResponse>)
              }
            />
            {rec.status === "proposed" && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <input
                  placeholder="optional note"
                  value={noteDraft[rec.id] ?? ""}
                  onChange={e => setNoteDraft({ ...noteDraft, [rec.id]: e.target.value })}
                  style={{
                    flex: "1 1 200px",
                    padding: "6px 8px",
                    background: "transparent",
                    border: `1px solid ${DIM}`,
                    borderRadius: 4,
                    color: FG,
                    ...mono,
                  }}
                />
                <button
                  onClick={() => approveMut.mutate({ id: rec.id, note: noteDraft[rec.id] })}
                  style={{ padding: "6px 12px", background: GREEN, color: BG, border: "none", borderRadius: 4, cursor: "pointer", ...mono }}
                >
                  Approve
                </button>
                <button
                  onClick={() => rejectMut.mutate({ id: rec.id, note: noteDraft[rec.id] })}
                  style={{ padding: "6px 12px", background: RED, color: BG, border: "none", borderRadius: 4, cursor: "pointer", ...mono }}
                >
                  Reject
                </button>
              </div>
            )}
            {rec.status === "approved" && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => applyMut.mutate({ id: rec.id })}
                  style={{ padding: "6px 12px", background: ORANGE, color: BG, border: "none", borderRadius: 4, cursor: "pointer", ...mono }}
                >
                  Apply (gated)
                </button>
                {rec.proposedDiff && (
                  <button
                    onClick={() => draftPrMut.mutate({ id: rec.id })}
                    style={{ padding: "6px 12px", background: "transparent", color: ORANGE, border: `1px solid ${ORANGE}`, borderRadius: 4, cursor: "pointer", ...mono }}
                  >
                    Draft PR / write patch
                  </button>
                )}
              </div>
            )}
            {rec.status === "applied" && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => revertMut.mutate({ id: rec.id, note: noteDraft[rec.id] })}
                  style={{ padding: "6px 12px", background: YELLOW, color: BG, border: "none", borderRadius: 4, cursor: "pointer", ...mono }}
                >
                  Revert
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
