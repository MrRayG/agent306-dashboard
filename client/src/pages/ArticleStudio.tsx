import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, LLM_FETCH_TIMEOUT_MS } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { VerifierReport, type VerifierReportData } from "@/components/VerifierReport";

// ── Types ──────────────────────────────────────────────────────────────────────
interface RevisionAttempt {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  issuesBefore: number;
  issuesAfter: number;
  severityBefore: "PASS" | "SOFT_WARN" | "HARD_FAIL";
  severityAfter: "PASS" | "SOFT_WARN" | "HARD_FAIL";
  targetedSentences: Array<{ sentence: string; classification: string; reason: string; suggestedFix?: string }>;
  diffPreview: string;
  writerNote?: string;
}

interface ExtraSource {
  url: string;
  note?: string;
  addedAt: string;
}

interface ArticlePreview {
  headline:    string;
  teaser:      string;
  body:        string;
  sourceUrl:   string;
  sourceTitle: string;
  imageUrl?:   string;
  verifierReport?: VerifierReportData;
  verification?: { ok: boolean; severity?: string; verifierReport?: VerifierReportData };
  revisionHistory?: RevisionAttempt[];
  sourceText?: string;
  groundingSources?: string[];
}
interface ArticleEntry {
  articleId:    string;
  postedAt:     string;
  sourceUrl:    string;
  sourceTitle:  string;
  headline:     string;
  tweetUrl?:    string;
  articleText?: string;
}
interface ArticleDraft {
  draftId: string;
  generatedAt: string;
  headline: string;
  teaser: string;
  body: string;
  sourceUrl: string;
  sourceTitle: string;
  imageUrl?: string;
  status?: "ok" | "quarantined" | "needs_revision";
  quarantineReason?: string;
  unsupportedClaims?: Array<{ sentence: string; lane?: string; reason: string }>;
  verifierReport?: VerifierReportData;
  revisionHistory?: RevisionAttempt[];
  extraSources?: ExtraSource[];
  sourceText?: string;
  groundingSources?: string[];
}
interface ArticleState {
  lastPostedAt: string | null;
  history:      ArticleEntry[];
  drafts?:      ArticleDraft[];
}

const mono  = { fontFamily: "'Courier New', monospace" } as const;
const pixel = { fontFamily: "'Courier New', monospace", textTransform: "uppercase" as const, letterSpacing: "0.15em" } as const;

// ── Rich article body renderer ─────────────────────────────────────────────────
function renderInline(text: string): React.ReactNode {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={i} style={{ color: "#f97316", fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*"))
      return <em key={i} style={{ color: "rgba(227,229,228,0.65)" }}>{part.slice(1, -1)}</em>;
    return part;
  });
}

function ArticleBody({ body }: { body: string }) {
  const lines = body.split("\n");
  const els: React.ReactNode[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) { els.push(<div key={i} style={{ height: "0.6rem" }} />); return; }
    if (line.startsWith("## ")) {
      els.push(
        <div key={i} style={{ marginTop: "1.75rem", marginBottom: "0.5rem" }}>
          <div style={{ ...mono, fontSize: "0.76rem", color: "rgba(249,115,22,0.55)", textTransform: "uppercase" as const, letterSpacing: "0.2em", marginBottom: "0.3rem" }}>
            ── {line.replace(/^##\s*/, "")} ──
          </div>
          <div style={{ height: 1, background: "rgba(249,115,22,0.1)" }} />
        </div>
      );
      return;
    }
    if (line.startsWith("# ")) { return; }
    if (line.startsWith("> ")) {
      els.push(
        <div key={i} style={{ margin: "1rem 0", padding: "0.85rem 1.25rem", borderLeft: "3px solid rgba(249,115,22,0.4)", background: "rgba(249,115,22,0.04)" }}>
          <p style={{ ...mono, fontSize: "0.76rem", color: "#efefef", lineHeight: 1.8, margin: 0, fontStyle: "italic" }}>
            "{renderInline(line.replace(/^>\s*/, ""))}"
          </p>
        </div>
      );
      return;
    }
    if (line.trim() === "---") {
      els.push(<div key={i} style={{ margin: "1.5rem 0", height: 1, background: "rgba(227,229,228,0.14)" }} />);
      return;
    }
    els.push(
      <p key={i} style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.8)", lineHeight: 1.85, margin: "0 0 0.1rem 0" }}>
        {renderInline(line)}
      </p>
    );
  });
  return <div>{els}</div>;
}

// ── History card ───────────────────────────────────────────────────────────────
function HistoryCard({ entry }: { entry: ArticleEntry }) {
  const [open, setOpen] = useState(false);
  const date = new Date(entry.postedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return (
    <div style={{ border: "1px solid rgba(227,229,228,0.14)", background: "rgba(227,229,228,0.04)", marginBottom: "0.6rem", padding: "1rem 1.25rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <p style={{ ...mono, fontSize: "0.90rem", color: "#efefef", margin: 0, marginBottom: 4, fontWeight: 700 }}>{entry.headline}</p>
          <p style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.55)", margin: 0 }}>{date} · {entry.sourceTitle}</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {entry.tweetUrl && (
            <a href={entry.tweetUrl} target="_blank" rel="noreferrer"
              style={{ ...mono, fontSize: "0.76rem", color: "#4ade80", border: "1px solid rgba(74,222,128,0.2)", padding: "3px 8px", textDecoration: "none", textTransform: "uppercase" as const }}>
              View on X →
            </a>
          )}
          {entry.articleText && (
            <button onClick={() => setOpen(v => !v)}
              style={{ ...mono, fontSize: "0.76rem", background: "transparent", border: "1px solid rgba(227,229,228,0.20)", color: "rgba(227,229,228,0.60)", cursor: "pointer", padding: "3px 8px", textTransform: "uppercase" as const }}>
              {open ? "Collapse" : "Read"}
            </button>
          )}
        </div>
      </div>
      {open && entry.articleText && (
        <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid rgba(227,229,228,0.12)" }}>
          <ArticleBody body={entry.articleText} />
        </div>
      )}
    </div>
  );
}

// ── Revision history panel (issue 2 + 3) ────────────────────────────────────
function RevisionHistoryPanel({ history }: { history: RevisionAttempt[] }) {
  const [open, setOpen] = useState(false);
  if (!history || history.length === 0) return null;
  return (
    <div style={{ border: "1px solid rgba(167,139,250,0.25)", background: "rgba(167,139,250,0.04)", padding: "0.85rem 1rem", marginBottom: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setOpen(v => !v)}>
        <p style={{ ...mono, fontSize: "0.72rem", color: "#a78bfa", textTransform: "uppercase" as const, letterSpacing: "0.12em", margin: 0 }}>
          Auto-revise history · {history.length} attempt{history.length === 1 ? "" : "s"}
        </p>
        <span style={{ ...mono, fontSize: "0.72rem", color: "#a78bfa" }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div style={{ marginTop: "0.7rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {history.map((h, i) => (
            <div key={i} style={{ borderLeft: `3px solid ${h.severityAfter === "PASS" ? "#4ade80" : h.severityAfter === "SOFT_WARN" ? "#facc15" : "#f87171"}`, padding: "0.45rem 0.7rem", background: "rgba(10,11,12,0.55)" }}>
              <div style={{ ...mono, fontSize: "0.66rem", color: "rgba(227,229,228,0.78)", marginBottom: 3 }}>
                Attempt {h.attempt} · {h.severityBefore} → {h.severityAfter} · issues {h.issuesBefore} → {h.issuesAfter}
              </div>
              {h.writerNote && (
                <div style={{ ...mono, fontSize: "0.66rem", color: "rgba(45,212,191,0.78)" }}>{h.writerNote}</div>
              )}
              {h.targetedSentences.length > 0 && (
                <div style={{ ...mono, fontSize: "0.62rem", color: "rgba(227,229,228,0.55)", marginTop: 4 }}>
                  Targeted: {h.targetedSentences.slice(0, 3).map(t => t.classification).join(", ")}{h.targetedSentences.length > 3 ? ` +${h.targetedSentences.length - 3} more` : ""}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Saved drafts sidebar (issue 1) ──────────────────────────────────────────
function DraftsSidebar({
  drafts, activeId, onPick, onDelete,
}: {
  drafts: ArticleDraft[];
  activeId: string | null;
  onPick: (d: ArticleDraft) => void;
  onDelete: (id: string) => void;
}) {
  if (drafts.length === 0) return null;
  return (
    <div style={{ border: "1px solid rgba(45,212,191,0.18)", background: "rgba(45,212,191,0.03)", padding: "0.85rem 1rem", marginBottom: "1.25rem" }}>
      <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(45,212,191,0.7)", textTransform: "uppercase" as const, letterSpacing: "0.12em", margin: 0, marginBottom: "0.55rem" }}>
        Saved drafts · {drafts.length}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto" }}>
        {drafts.map(d => {
          const active = d.draftId === activeId;
          return (
            <div key={d.draftId} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "0.4rem 0.6rem",
              background: active ? "rgba(45,212,191,0.07)" : "transparent",
              border: `1px solid ${active ? "rgba(45,212,191,0.4)" : "rgba(227,229,228,0.08)"}`,
            }}>
              <button onClick={() => onPick(d)} style={{
                flex: 1, textAlign: "left" as const, background: "transparent", border: "none",
                ...mono, color: "#efefef", fontSize: "0.74rem", cursor: "pointer", padding: 0,
              }}>
                <div style={{ fontWeight: 700, color: active ? "#2dd4bf" : "#efefef" }}>{d.headline.slice(0, 80)}</div>
                <div style={{ fontSize: "0.62rem", color: "rgba(227,229,228,0.5)", marginTop: 2 }}>
                  {new Date(d.generatedAt).toLocaleString()} · {d.status ?? "ok"}
                  {d.revisionHistory && d.revisionHistory.length > 0 && ` · ${d.revisionHistory.length} revise`}
                </div>
              </button>
              <button onClick={() => onDelete(d.draftId)} title="Delete draft" style={{
                ...mono, fontSize: "0.62rem", background: "transparent", border: "1px solid rgba(248,113,113,0.3)",
                color: "rgba(248,113,113,0.8)", cursor: "pointer", padding: "2px 6px",
              }}>✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Add resources panel (issue 3) + grounding (issue 5) ────────────────────
function ResourcesPanel({
  draftId,
  extraSources,
  groundingSources,
  onResourcesAdded,
  onRevised,
}: {
  draftId: string | null;
  extraSources: ExtraSource[];
  groundingSources: string[];
  onResourcesAdded: () => void;
  onRevised: () => void;
}) {
  const { toast } = useToast();
  const [urlsText, setUrlsText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"add" | "revise" | null>(null);

  async function add() {
    if (!draftId) return;
    const urls = urlsText
      .split(/\n+/)
      .map(s => s.trim())
      .filter(s => /^https?:\/\//i.test(s));
    if (urls.length === 0) {
      toast({ title: "No valid URLs", description: "Each line must start with http:// or https://", variant: "destructive" });
      return;
    }
    setBusy("add");
    try {
      const r = await apiRequest("POST", `/api/article/drafts/${draftId}/resources`, { urls, note: note || undefined });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error ?? "Failed");
      toast({ title: `Added ${out.added ?? 0} resource${out.added === 1 ? "" : "s"}` });
      setUrlsText("");
      setNote("");
      onResourcesAdded();
    } catch (e: any) {
      toast({ title: "Failed to add resources", description: e.message, variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function revise() {
    if (!draftId) return;
    setBusy("revise");
    try {
      const r = await apiRequest("POST", `/api/article/drafts/${draftId}/revise`, { operatorNote: note || undefined }, { timeoutMs: LLM_FETCH_TIMEOUT_MS });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error ?? "Failed");
      const passed = out.draft?.verifierReport?.severity === "PASS";
      toast({ title: passed ? "Revise complete — PASS" : `Revise complete — ${out.draft?.verifierReport?.severity ?? "see report"}` });
      onRevised();
    } catch (e: any) {
      toast({ title: "Revise failed", description: e.message, variant: "destructive" });
    } finally { setBusy(null); }
  }

  return (
    <div style={{ border: "1px solid rgba(249,115,22,0.18)", background: "rgba(249,115,22,0.03)", padding: "1rem 1.1rem", marginBottom: "1.25rem" }}>
      <p style={{ ...mono, fontSize: "0.72rem", color: "rgba(249,115,22,0.65)", textTransform: "uppercase" as const, letterSpacing: "0.12em", margin: 0, marginBottom: "0.6rem" }}>
        Resources · revise loop
      </p>

      {(groundingSources.length > 0 || extraSources.length > 0) && (
        <div style={{ marginBottom: "0.7rem" }}>
          {groundingSources.length > 0 && (
            <div style={{ ...mono, fontSize: "0.66rem", color: "rgba(167,139,250,0.78)", marginBottom: 3 }}>
              Pinned Deep Read sources ({groundingSources.length}):
              <ul style={{ margin: "3px 0 0 1.1rem", padding: 0 }}>
                {groundingSources.slice(0, 6).map((u, i) => (
                  <li key={i} style={{ fontSize: "0.62rem", color: "rgba(167,139,250,0.7)" }}>
                    <a href={u} target="_blank" rel="noreferrer" style={{ color: "rgba(167,139,250,0.85)" }}>{u.slice(0, 90)}</a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {extraSources.length > 0 && (
            <div style={{ ...mono, fontSize: "0.66rem", color: "rgba(45,212,191,0.78)" }}>
              Operator-added sources ({extraSources.length}):
              <ul style={{ margin: "3px 0 0 1.1rem", padding: 0 }}>
                {extraSources.slice(0, 8).map((s, i) => (
                  <li key={i} style={{ fontSize: "0.62rem", color: "rgba(227,229,228,0.65)" }}>
                    <a href={s.url} target="_blank" rel="noreferrer" style={{ color: "rgba(45,212,191,0.85)" }}>{s.url.slice(0, 90)}</a>
                    {s.note ? ` — ${s.note.slice(0, 60)}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {draftId ? (
        <>
          <p style={{ ...mono, fontSize: "0.66rem", color: "rgba(227,229,228,0.55)", margin: 0, marginBottom: 4 }}>
            Resource URLs (one per line)
          </p>
          <textarea
            value={urlsText}
            onChange={e => setUrlsText(e.target.value)}
            placeholder="https://example.com/source1&#10;https://example.com/source2"
            rows={3}
            style={{ width: "100%", boxSizing: "border-box" as const, ...mono, fontSize: "0.7rem", padding: "0.5rem", background: "rgba(227,229,228,0.05)", color: "#efefef", border: "1px solid rgba(227,229,228,0.18)", outline: "none", marginBottom: 6 }}
          />
          <p style={{ ...mono, fontSize: "0.66rem", color: "rgba(227,229,228,0.55)", margin: 0, marginBottom: 4 }}>
            Note for the agent (optional)
          </p>
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Cite the second URL for the 50% adoption stat. Drop the NCITE detail."
            style={{ width: "100%", boxSizing: "border-box" as const, ...mono, fontSize: "0.7rem", padding: "0.5rem", background: "rgba(227,229,228,0.05)", color: "#efefef", border: "1px solid rgba(227,229,228,0.18)", outline: "none", marginBottom: 8 }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
            <button onClick={add} disabled={busy !== null} style={{
              ...mono, fontSize: "0.74rem", padding: "0.45rem 0.95rem",
              background: busy === "add" ? "rgba(249,115,22,0.2)" : "#f97316",
              color: busy === "add" ? "rgba(249,115,22,0.5)" : "#1a1b1c",
              border: "none", cursor: busy ? "not-allowed" : "pointer", fontWeight: 700,
              textTransform: "uppercase" as const, letterSpacing: "0.06em",
            }}>
              {busy === "add" ? "Adding..." : "Add resources"}
            </button>
            <button onClick={revise} disabled={busy !== null} style={{
              ...mono, fontSize: "0.74rem", padding: "0.45rem 0.95rem",
              background: "transparent",
              color: busy === "revise" ? "rgba(167,139,250,0.5)" : "#a78bfa",
              border: "1px solid rgba(167,139,250,0.45)",
              cursor: busy ? "not-allowed" : "pointer", fontWeight: 700,
              textTransform: "uppercase" as const, letterSpacing: "0.06em",
            }}>
              {busy === "revise" ? "Revising..." : "Revise with current resources →"}
            </button>
          </div>
        </>
      ) : (
        <p style={{ ...mono, fontSize: "0.7rem", color: "rgba(227,229,228,0.5)" }}>
          Save the draft first to add resources or trigger another revise pass.
        </p>
      )}
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
export default function ArticleStudio() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [article, setArticle]   = useState<ArticlePreview | null>(null);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [inputUrl, setInputUrl] = useState("");
  const [groundingText, setGroundingText] = useState("");
  const [genError, setGenError] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState(false);
  const [tab, setTab] = useState<"studio" | "history">("studio");

  const { data: state } = useQuery<ArticleState>({
    queryKey: ["/api/article/state"],
    refetchInterval: 30_000,
  });

  // List of unposted drafts (issue 1: restore on mount)
  const { data: draftsData, refetch: refetchDrafts } = useQuery<{ drafts: ArticleDraft[] }>({
    queryKey: ["/api/article/drafts"],
    refetchInterval: 30_000,
  });
  const drafts = useMemo(() => draftsData?.drafts ?? [], [draftsData]);

  // Generate (auto-saves to backend on success — issue 1)
  const genMutation = useMutation({
    mutationFn: async () => {
      const body: any = {};
      if (inputUrl.trim()) body.url = inputUrl.trim();
      const groundingSources = groundingText
        .split(/\n+/)
        .map(s => s.trim())
        .filter(s => /^https?:\/\//i.test(s));
      if (groundingSources.length > 0) body.groundingSources = groundingSources;
      const r = await apiRequest("POST", "/api/article/preview", body, { timeoutMs: LLM_FETCH_TIMEOUT_MS });
      const data = await r.json();
      return data as ArticlePreview;
    },
    onSuccess: async (data) => {
      setArticle(data);
      setGenError(null);
      // Auto-save the preview as a draft so we never lose it on tab close.
      try {
        const r = await apiRequest("POST", "/api/article/drafts", {
          headline: data.headline,
          teaser: data.teaser,
          body: data.body,
          sourceUrl: data.sourceUrl,
          sourceTitle: data.sourceTitle,
          imageUrl: data.imageUrl,
          revisionHistory: data.revisionHistory,
          groundingSources: data.groundingSources,
          sourceText: data.sourceText,
        });
        const out = await r.json();
        if (out?.draft?.draftId) {
          setActiveDraftId(out.draft.draftId);
          toast({ title: "Draft auto-saved" });
        }
        qc.invalidateQueries({ queryKey: ["/api/article/drafts"] });
      } catch (e: any) {
        toast({ title: "Generated, but draft auto-save failed", description: e.message, variant: "destructive" });
      }
    },
    onError: (e: any) => { setGenError(e.message ?? "Generation failed"); },
  });

  function pickDraft(d: ArticleDraft) {
    setArticle({
      headline: d.headline,
      teaser: d.teaser,
      body: d.body,
      sourceUrl: d.sourceUrl,
      sourceTitle: d.sourceTitle,
      imageUrl: d.imageUrl,
      verifierReport: d.verifierReport,
      revisionHistory: d.revisionHistory,
      sourceText: d.sourceText,
      groundingSources: d.groundingSources,
    });
    setActiveDraftId(d.draftId);
    setGenError(null);
  }

  async function deleteDraft(id: string) {
    if (!window.confirm("Delete this draft? This cannot be undone.")) return;
    try {
      const r = await apiRequest("DELETE", `/api/article/drafts/${id}`);
      const out = await r.json();
      if (!out.ok) throw new Error(out.error ?? "Failed");
      if (activeDraftId === id) { setArticle(null); setActiveDraftId(null); }
      refetchDrafts();
      toast({ title: "Draft deleted" });
    } catch (e: any) {
      toast({ title: "Failed to delete", description: e.message, variant: "destructive" });
    }
  }

  // After a successful revise / resource add, refresh the active draft from the server.
  async function refreshActiveDraft() {
    if (!activeDraftId) return;
    refetchDrafts();
    try {
      const r = await apiRequest("GET", `/api/article/drafts/${activeDraftId}`);
      const out = await r.json();
      if (out.draft) {
        const d = out.draft as ArticleDraft;
        setArticle(prev => ({
          ...(prev ?? {} as ArticlePreview),
          headline: d.headline,
          teaser: d.teaser,
          body: d.body,
          sourceUrl: d.sourceUrl,
          sourceTitle: d.sourceTitle,
          imageUrl: d.imageUrl,
          verifierReport: d.verifierReport,
          revisionHistory: d.revisionHistory,
          sourceText: d.sourceText,
          groundingSources: d.groundingSources,
        }));
      }
    } catch { /* non-fatal */ }
  }

  // On first mount, if there are no in-memory article and there ARE drafts, do nothing
  // automatic — the operator picks one. We just show them in the sidebar.
  useEffect(() => {
    if (!article && drafts.length > 0 && !activeDraftId) {
      // Auto-restore the most recent draft so a tab refresh doesn't visually wipe work.
      pickDraft(drafts[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts.length]);

  // Download image
  async function downloadImage() {
    if (!article) return;
    setImgLoading(true);
    try {
      const DASH_SECRET = (import.meta as any).env?.VITE_DASHBOARD_SECRET ?? "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (DASH_SECRET) headers["x-dashboard-secret"] = DASH_SECRET;

      const r = await fetch("/api/article/image", {
        method: "POST",
        headers,
        body: JSON.stringify({
          headline: article.headline,
          sourceTitle: article.sourceTitle,
          teaser: article.teaser,
          date: new Date().toISOString().slice(0, 10),
        }),
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        let msg = t;
        try { msg = JSON.parse(t).error ?? t; } catch {}
        toast({ title: "Image failed", description: msg, variant: "destructive" });
        return;
      }

      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `agent306-deep-read-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Downloaded — 1200×500 PNG ready to upload to X" });
    } catch (e: any) {
      toast({ title: "Image failed", description: e.message, variant: "destructive" });
    } finally {
      setImgLoading(false);
    }
  }

  function copyArticle() {
    if (!article) return;
    navigator.clipboard.writeText(`${article.headline}\n\n${article.body}`);
    toast({ title: "Article copied — paste into X Article editor" });
  }

  function copyTeaser() {
    if (!article) return;
    navigator.clipboard.writeText(article.teaser);
    toast({ title: "Teaser copied — use this as your X post" });
  }

  const lastPosted = state?.lastPostedAt
    ? new Date(state.lastPostedAt).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
    : null;

  const nextMonday = (() => {
    const now = new Date();
    const daysUntil = (1 - now.getUTCDay() + 7) % 7 || 7;
    const next = new Date(now);
    next.setUTCDate(next.getUTCDate() + daysUntil);
    next.setUTCHours(22, 0, 0, 0);
    return next.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  })();

  const activeDraft = useMemo(
    () => drafts.find(d => d.draftId === activeDraftId) ?? null,
    [drafts, activeDraftId],
  );
  const extraSources = activeDraft?.extraSources ?? [];
  const activeGroundingSources = activeDraft?.groundingSources ?? article?.groundingSources ?? [];

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.5rem" }}>

      {/* Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ ...pixel, fontSize: "1.03rem", color: "#f97316", margin: 0, marginBottom: 6 }}>
          ARTICLE STUDIO — THE DEEP READ
        </h1>
        <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.60)", margin: 0, lineHeight: 1.6 }}>
          Agent 306 finds this week's most important AI article, performs a Deep Read across 70 years of AI history, and drafts a long-form piece for you to copy and post.
        </p>
      </div>

      {/* Schedule bar */}
      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem", flexWrap: "wrap" as const }}>
        {[
          { label: "Auto-Schedule", value: "Every Monday · 5 PM ET", color: "#f97316", dim: "rgba(249,115,22,0.5)", bg: "rgba(249,115,22,0.04)", border: "rgba(249,115,22,0.12)" },
          { label: "Last Published", value: lastPosted ?? "None yet", color: "#efefef", dim: "rgba(227,229,228,0.48)", bg: "rgba(227,229,228,0.05)", border: "rgba(227,229,228,0.14)" },
          { label: "Next Auto-Post", value: nextMonday, color: "#a78bfa", dim: "rgba(167,139,250,0.5)", bg: "rgba(167,139,250,0.03)", border: "rgba(167,139,250,0.1)" },
          { label: "Saved Drafts", value: `${drafts.length} draft${drafts.length === 1 ? "" : "s"}`, color: "#2dd4bf", dim: "rgba(45,212,191,0.35)", bg: "rgba(45,212,191,0.02)", border: "rgba(45,212,191,0.08)" },
        ].map(s => (
          <div key={s.label} style={{ flex: 1, minWidth: 160, background: s.bg, border: `1px solid ${s.border}`, padding: "0.7rem 1rem" }}>
            <p style={{ ...mono, fontSize: "0.68rem", color: s.dim, textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: 0, marginBottom: 4 }}>{s.label}</p>
            <p style={{ ...mono, fontSize: "0.68rem", color: s.color, margin: 0 }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "1px solid rgba(227,229,228,0.15)", marginBottom: "1.5rem" }}>
        {(["studio", "history"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            ...mono, fontSize: "0.63rem", textTransform: "uppercase" as const, letterSpacing: "0.12em",
            background: "transparent", border: "none",
            borderBottom: tab === t ? "2px solid #f97316" : "2px solid transparent",
            color: tab === t ? "#f97316" : "rgba(227,229,228,0.55)",
            padding: "0.6rem 1.25rem", cursor: "pointer", marginBottom: -1,
          }}>
            {t === "studio" ? "Studio" : `History (${state?.history?.length ?? 0})`}
          </button>
        ))}
      </div>

      {/* ── STUDIO ── */}
      {tab === "studio" && (
        <div>

          {/* Saved drafts (issue 1) */}
          <DraftsSidebar drafts={drafts} activeId={activeDraftId} onPick={pickDraft} onDelete={deleteDraft} />

          {/* GENERATE PANEL */}
          <div style={{
            border: `1px solid ${article ? "rgba(227,229,228,0.14)" : "rgba(249,115,22,0.2)"}`,
            background: "rgba(227,229,228,0.04)",
            padding: "1.5rem",
            marginBottom: "1.25rem",
          }}>
            <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(249,115,22,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "1rem" }}>
              {article ? "Generate New Article" : "Step 1 — Generate Deep Read"}
            </p>

            <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.68)", marginBottom: "1rem", lineHeight: 1.7 }}>
              Agent 306 scans global news for the most important AI story this week, performs a Deep Read cross-referencing 70 years of AI history, and drafts a long-form article. Or paste a specific URL below to Deep Read that article directly.
            </p>

            {/* Optional URL */}
            <div style={{ marginBottom: "1rem" }}>
              <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.28)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: "0.4rem" }}>
                Direct URL (optional) — skip auto-discovery and Deep Read a specific article
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="url"
                  value={inputUrl}
                  onChange={e => setInputUrl(e.target.value)}
                  placeholder="https://... paste article URL, or leave blank for auto-discovery"
                  style={{
                    flex: 1, background: "rgba(227,229,228,0.08)",
                    border: "1px solid rgba(227,229,228,0.18)", color: "#efefef",
                    ...mono, fontSize: "0.68rem", padding: "0.55rem 0.85rem",
                    outline: "none", borderRadius: 0,
                  }}
                />
                {inputUrl && (
                  <button onClick={() => setInputUrl("")} style={{ background: "transparent", border: "1px solid rgba(227,229,228,0.18)", color: "rgba(227,229,228,0.55)", ...mono, fontSize: "0.80rem", padding: "0.55rem 0.75rem", cursor: "pointer" }}>✕</button>
                )}
              </div>
            </div>

            {/* Grounding sources (issue 5) — Deep Read brief / pinned URLs */}
            <div style={{ marginBottom: "1rem" }}>
              <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(167,139,250,0.55)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: "0.4rem" }}>
                Deep Read grounding (optional) — pin source URLs as canonical citation targets
              </p>
              <textarea
                value={groundingText}
                onChange={e => setGroundingText(e.target.value)}
                placeholder="https://research.example.com/brief1&#10;https://lab.example.com/paper.pdf"
                rows={3}
                style={{
                  width: "100%", boxSizing: "border-box" as const,
                  background: "rgba(167,139,250,0.05)",
                  border: "1px solid rgba(167,139,250,0.22)", color: "#efefef",
                  ...mono, fontSize: "0.68rem", padding: "0.55rem 0.85rem",
                  outline: "none", borderRadius: 0,
                }}
              />
              <p style={{ ...mono, fontSize: "0.62rem", color: "rgba(167,139,250,0.45)", margin: "4px 0 0" }}>
                These URLs are passed to the writer + auto-revise loop as preferred citation targets. Reduces Lane B hallucinations.
              </p>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" as const }}>
              <button
                onClick={() => { setGenError(null); genMutation.mutate(); }}
                disabled={genMutation.isPending}
                style={{
                  background: genMutation.isPending ? "rgba(249,115,22,0.15)" : "#f97316",
                  color: genMutation.isPending ? "rgba(249,115,22,0.4)" : "#1a1b1c",
                  border: "none", ...mono, fontSize: "0.88rem", fontWeight: 700,
                  padding: "0.7rem 1.5rem", cursor: genMutation.isPending ? "not-allowed" : "pointer",
                  textTransform: "uppercase" as const, letterSpacing: "0.08em",
                }}
              >
                {genMutation.isPending
                  ? (inputUrl ? "Reading article..." : "Scanning news · drafting...")
                  : (inputUrl ? "Deep Read This Article →" : "Generate Deep Read →")}
              </button>
              {genMutation.isPending && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#f97316", animation: "apulse 1.2s infinite" }} />
                  <span style={{ ...mono, fontSize: "0.78rem", color: "rgba(249,115,22,0.5)" }}>
                    Agent 306 is researching · auto-revise loop will run after generation...
                  </span>
                </div>
              )}
            </div>

            {/* Error */}
            {genError && !genMutation.isPending && (
              <div style={{ marginTop: "1rem", padding: "0.85rem 1rem", background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.2)", borderLeft: "3px solid #f87171" }}>
                <p style={{ ...mono, fontSize: "0.78rem", color: "rgba(248,113,113,0.7)", textTransform: "uppercase" as const, letterSpacing: "0.12em", margin: 0, marginBottom: 4 }}>Error</p>
                <p style={{ ...mono, fontSize: "0.68rem", color: "#f87171", margin: 0, lineHeight: 1.6 }}>{genError}</p>
                <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.48)", margin: "0.5rem 0 0" }}>Try again or paste a direct URL above to skip auto-discovery.</p>
              </div>
            )}
          </div>

          {/* ARTICLE PANEL — shown when article exists */}
          {article && (
            <div style={{ border: "1px solid rgba(249,115,22,0.2)", background: "rgba(249,115,22,0.01)", padding: "1.5rem" }}>

              {/* Source */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
                <div>
                  <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.12em", margin: 0, marginBottom: 4 }}>Source</p>
                  <p style={{ ...mono, fontSize: "0.88rem", color: "#efefef", margin: 0 }}>{article.sourceTitle}</p>
                  <a href={article.sourceUrl} target="_blank" rel="noreferrer"
                    style={{ ...mono, fontSize: "0.76rem", color: "rgba(249,115,22,0.45)", textDecoration: "none" }}>
                    {article.sourceUrl.slice(0, 65)}...
                  </a>
                </div>
                <span style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.40)", border: "1px solid rgba(227,229,228,0.15)", padding: "3px 8px" }}>
                  {article.body.split(/\s+/).filter(Boolean).length} words
                </span>
              </div>

              {/* Article image from source */}
              {article.imageUrl && (
                <div style={{ marginBottom: "1.25rem" }}>
                  <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.12em", margin: 0, marginBottom: "0.5rem" }}>Source Image</p>
                  <div style={{ border: "1px solid rgba(227,229,228,0.14)", overflow: "hidden" }}>
                    <img
                      src={article.imageUrl}
                      alt={article.sourceTitle}
                      style={{ width: "100%", maxHeight: 400, objectFit: "cover", display: "block" }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  </div>
                </div>
              )}

              {/* ── ACTION BUTTONS — top of review for visibility ── */}
              <div style={{
                padding: "1.25rem",
                background: "rgba(14,15,16,0.8)",
                border: "1px solid rgba(249,115,22,0.15)",
                marginBottom: "1.25rem",
              }}>
                <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(249,115,22,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: 0, marginBottom: "1rem" }}>
                  Export &amp; Post
                </p>

                {/* Steps */}
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 3, marginBottom: "1rem" }}>
                  {[
                    "1  Download the header image (1200×500, 5:2 ratio)",
                    "2  Copy the article text",
                    "3  Go to X → Create Article → paste headline + body",
                    "4  Upload the image as the article cover",
                    "5  Copy the teaser → post it as your regular tweet",
                  ].map(s => (
                    <p key={s} style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.60)", margin: 0 }}>{s}</p>
                  ))}
                </div>

                {/* Buttons */}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const }}>
                  <button
                    onClick={downloadImage}
                    disabled={imgLoading}
                    style={{
                      background: imgLoading ? "rgba(249,115,22,0.15)" : "#f97316",
                      color: imgLoading ? "rgba(249,115,22,0.4)" : "#1a1b1c",
                      border: "none", ...mono, fontSize: "0.88rem", fontWeight: 700,
                      padding: "0.75rem 1.5rem",
                      cursor: imgLoading ? "not-allowed" : "pointer",
                      letterSpacing: "0.06em", textTransform: "uppercase" as const,
                    }}
                  >
                    {imgLoading ? "⏳ Generating..." : "↓ Download Header Image (1200×500)"}
                  </button>

                  <button
                    onClick={copyArticle}
                    style={{
                      background: "#4ade80", color: "#1a1b1c",
                      border: "none", ...mono, fontSize: "0.88rem", fontWeight: 700,
                      padding: "0.75rem 1.5rem", cursor: "pointer",
                      letterSpacing: "0.06em", textTransform: "uppercase" as const,
                    }}
                  >
                    Copy Article Text
                  </button>

                  <button
                    onClick={copyTeaser}
                    style={{
                      background: "transparent", border: "1px solid rgba(45,212,191,0.3)",
                      color: "#2dd4bf", ...mono, fontSize: "0.68rem", fontWeight: 600,
                      padding: "0.75rem 1.25rem", cursor: "pointer",
                      letterSpacing: "0.06em", textTransform: "uppercase" as const,
                    }}
                  >
                    Copy Teaser Post
                  </button>

                  <button
                    onClick={() => { setGenError(null); genMutation.mutate(); }}
                    disabled={genMutation.isPending}
                    style={{
                      background: "transparent", border: "1px solid rgba(167,139,250,0.2)",
                      color: "rgba(167,139,250,0.6)", ...mono, fontSize: "0.83rem",
                      padding: "0.75rem 1rem", cursor: "pointer",
                      letterSpacing: "0.06em", textTransform: "uppercase" as const,
                    }}
                  >
                    Regenerate
                  </button>
                </div>
              </div>

              {/* Verifier report */}
              <VerifierReport report={article.verifierReport ?? article.verification?.verifierReport} />

              {/* Auto-revise history (issue 2) */}
              {article.revisionHistory && <RevisionHistoryPanel history={article.revisionHistory} />}

              {/* Resources panel (issue 3) */}
              <ResourcesPanel
                draftId={activeDraftId}
                extraSources={extraSources}
                groundingSources={activeGroundingSources}
                onResourcesAdded={refreshActiveDraft}
                onRevised={refreshActiveDraft}
              />

              {/* Teaser preview */}
              <div style={{ marginBottom: "1.25rem" }}>
                <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(45,212,191,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.5rem" }}>
                  Teaser Post · {article.teaser.length} chars
                </p>
                <div style={{ padding: "1rem", background: "rgba(45,212,191,0.03)", border: "1px solid rgba(45,212,191,0.1)", borderLeft: "3px solid rgba(45,212,191,0.35)" }}>
                  <p style={{ ...mono, fontSize: "0.74rem", color: "#efefef", margin: 0, lineHeight: 1.7, fontStyle: "italic" }}>{article.teaser}</p>
                </div>
              </div>

              {/* Headline */}
              <div style={{ marginBottom: "1rem" }}>
                <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.5rem" }}>Article Headline</p>
                <h2 style={{ ...mono, fontSize: "1.25rem", color: "#efefef", margin: 0, lineHeight: 1.4, fontWeight: 700 }}>{article.headline}</h2>
              </div>

              <div style={{ height: 1, background: "rgba(227,229,228,0.12)", margin: "1.25rem 0" }} />

              {/* Article body */}
              <div style={{ padding: "1.5rem 1.75rem", background: "rgba(10,11,12,0.7)", border: "1px solid rgba(227,229,228,0.12)", maxHeight: "55vh", overflowY: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1.25rem", paddingBottom: "0.75rem", borderBottom: "1px solid rgba(249,115,22,0.12)" }}>
                  <div style={{ width: 26, height: 26, borderRadius: 2, background: "rgba(249,115,22,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px", fontWeight: 700, color: "#f97316" }}>306</div>
                  <div>
                    <p style={{ ...mono, fontSize: "0.76rem", color: "#f97316", margin: 0, fontWeight: 700 }}>Agent 306 — The Deep Read</p>
                    <p style={{ ...mono, fontSize: "0.53rem", color: "rgba(227,229,228,0.48)", margin: 0 }}>agent306.eth · 306</p>
                  </div>
                </div>
                <ArticleBody body={article.body} />
                <div style={{ marginTop: "1.5rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(227,229,228,0.10)" }}>
                  <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.22)", margin: 0 }}>Agent 306 · agent306.eth</p>
                  <a href={article.sourceUrl} target="_blank" rel="noreferrer" style={{ ...mono, fontSize: "0.73rem", color: "rgba(249,115,22,0.35)", display: "block", marginTop: 3 }}>
                    Source: {article.sourceTitle}
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!article && !genMutation.isPending && !genError && (
            <div style={{ border: "1px solid rgba(167,139,250,0.08)", background: "rgba(167,139,250,0.01)", padding: "1.25rem 1.5rem" }}>
              <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(167,139,250,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.75rem" }}>The Deep Read Format</p>
              {[
                ["Discovery", "Scans global news for the week's biggest AI story — breaking, turning points, things people haven't processed yet."],
                ["Deep Read", "Cross-references 70 years of AI history — from the 1956 Dartmouth Workshop through AI Winters, backprop, transformers, to agents."],
                ["Forward Projection", "What does it mean for the next 70 years? AGI, Human-AI Symbiosis, autonomous economies. The things most analysts won't say."],
                ["Your Workflow", "Generate → auto-saves as draft → auto-revise loop fixes uncited Lane B claims → review → copy to X. Drafts persist across tab close."],
              ].map(([t, d]) => (
                <div key={t} style={{ display: "flex", gap: 10, padding: "5px 0", borderBottom: "1px solid rgba(167,139,250,0.05)" }}>
                  <div>
                    <span style={{ ...mono, fontSize: "0.80rem", color: "#a78bfa", display: "block", marginBottom: 2 }}>{t}</span>
                    <span style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.33)", lineHeight: 1.6 }}>{d}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── HISTORY ── */}
      {tab === "history" && (
        <div>
          {!state?.history?.length
            ? <div style={{ padding: "2rem", border: "1px solid rgba(227,229,228,0.14)", textAlign: "center" as const }}>
                <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.48)", margin: 0 }}>No articles published yet.</p>
              </div>
            : state.history.map(e => <HistoryCard key={e.articleId} entry={e} />)
          }
        </div>
      )}

      <style>{`@keyframes apulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.7)}}`}</style>
    </div>
  );
}
