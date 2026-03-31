import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Types ──────────────────────────────────────────────────────────────────────
interface ArticlePreview {
  headline:    string;
  teaser:      string;
  body:        string;
  sourceUrl:   string;
  sourceTitle: string;
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
interface ArticleState {
  lastPostedAt: string | null;
  history:      ArticleEntry[];
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
          <div style={{ ...mono, fontSize: "0.58rem", color: "rgba(249,115,22,0.55)", textTransform: "uppercase" as const, letterSpacing: "0.2em", marginBottom: "0.3rem" }}>
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
          <p style={{ ...mono, fontSize: "0.76rem", color: "#e3e5e4", lineHeight: 1.8, margin: 0, fontStyle: "italic" }}>
            "{renderInline(line.replace(/^>\s*/, ""))}"
          </p>
        </div>
      );
      return;
    }
    if (line.trim() === "---") {
      els.push(<div key={i} style={{ margin: "1.5rem 0", height: 1, background: "rgba(227,229,228,0.07)" }} />);
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
    <div style={{ border: "1px solid rgba(227,229,228,0.07)", background: "rgba(227,229,228,0.015)", marginBottom: "0.6rem", padding: "1rem 1.25rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <p style={{ ...mono, fontSize: "0.72rem", color: "#e3e5e4", margin: 0, marginBottom: 4, fontWeight: 700 }}>{entry.headline}</p>
          <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.35)", margin: 0 }}>{date} · {entry.sourceTitle}</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {entry.tweetUrl && (
            <a href={entry.tweetUrl} target="_blank" rel="noreferrer"
              style={{ ...mono, fontSize: "0.58rem", color: "#4ade80", border: "1px solid rgba(74,222,128,0.2)", padding: "3px 8px", textDecoration: "none", textTransform: "uppercase" as const }}>
              View on X →
            </a>
          )}
          {entry.articleText && (
            <button onClick={() => setOpen(v => !v)}
              style={{ ...mono, fontSize: "0.58rem", background: "transparent", border: "1px solid rgba(227,229,228,0.12)", color: "rgba(227,229,228,0.4)", cursor: "pointer", padding: "3px 8px", textTransform: "uppercase" as const }}>
              {open ? "Collapse" : "Read"}
            </button>
          )}
        </div>
      </div>
      {open && entry.articleText && (
        <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid rgba(227,229,228,0.06)" }}>
          <ArticleBody body={entry.articleText} />
        </div>
      )}
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
export default function ArticleStudio() {
  const { toast } = useToast();

  const [article, setArticle]   = useState<ArticlePreview | null>(null);
  const [inputUrl, setInputUrl] = useState("");
  const [genError, setGenError] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState(false);
  const [tab, setTab] = useState<"studio" | "history">("studio");

  const { data: state } = useQuery<ArticleState>({
    queryKey: ["/api/article/state"],
    refetchInterval: 30_000,
  });

  // Generate
  const genMutation = useMutation({
    mutationFn: async () => {
      const body: any = {};
      if (inputUrl.trim()) body.url = inputUrl.trim();
      const r = await apiRequest("POST", "/api/article/preview", body);
      const data = await r.json();
      return data as ArticlePreview;
    },
    onSuccess: (data) => { setArticle(data); setGenError(null); },
    onError: (e: any) => { setGenError(e.message ?? "Generation failed"); },
  });

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

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.5rem" }}>

      {/* Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ ...pixel, fontSize: "0.85rem", color: "#f97316", margin: 0, marginBottom: 6 }}>
          ARTICLE STUDIO — THE DEEP READ
        </h1>
        <p style={{ ...mono, fontSize: "0.7rem", color: "rgba(227,229,228,0.4)", margin: 0, lineHeight: 1.6 }}>
          Agent 306 finds this week's most important AI article, performs a Deep Read across 70 years of AI history, and drafts a long-form piece for you to copy and post.
        </p>
      </div>

      {/* Schedule bar */}
      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem", flexWrap: "wrap" as const }}>
        {[
          { label: "Auto-Schedule", value: "Every Monday · 5 PM ET", color: "#f97316", dim: "rgba(249,115,22,0.5)", bg: "rgba(249,115,22,0.04)", border: "rgba(249,115,22,0.12)" },
          { label: "Last Published", value: lastPosted ?? "None yet", color: "#e3e5e4", dim: "rgba(227,229,228,0.3)", bg: "rgba(227,229,228,0.02)", border: "rgba(227,229,228,0.07)" },
          { label: "Next Auto-Post", value: nextMonday, color: "#a78bfa", dim: "rgba(167,139,250,0.5)", bg: "rgba(167,139,250,0.03)", border: "rgba(167,139,250,0.1)" },
          { label: "Published", value: `${state?.history?.length ?? 0} articles`, color: "#2dd4bf", dim: "rgba(45,212,191,0.35)", bg: "rgba(45,212,191,0.02)", border: "rgba(45,212,191,0.08)" },
        ].map(s => (
          <div key={s.label} style={{ flex: 1, minWidth: 160, background: s.bg, border: `1px solid ${s.border}`, padding: "0.7rem 1rem" }}>
            <p style={{ ...mono, fontSize: "0.5rem", color: s.dim, textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: 0, marginBottom: 4 }}>{s.label}</p>
            <p style={{ ...mono, fontSize: "0.68rem", color: s.color, margin: 0 }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "1px solid rgba(227,229,228,0.08)", marginBottom: "1.5rem" }}>
        {(["studio", "history"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            ...mono, fontSize: "0.63rem", textTransform: "uppercase" as const, letterSpacing: "0.12em",
            background: "transparent", border: "none",
            borderBottom: tab === t ? "2px solid #f97316" : "2px solid transparent",
            color: tab === t ? "#f97316" : "rgba(227,229,228,0.35)",
            padding: "0.6rem 1.25rem", cursor: "pointer", marginBottom: -1,
          }}>
            {t === "studio" ? "Studio" : `History (${state?.history?.length ?? 0})`}
          </button>
        ))}
      </div>

      {/* ── STUDIO ── */}
      {tab === "studio" && (
        <div>

          {/* GENERATE PANEL */}
          <div style={{
            border: `1px solid ${article ? "rgba(227,229,228,0.07)" : "rgba(249,115,22,0.2)"}`,
            background: "rgba(227,229,228,0.015)",
            padding: "1.5rem",
            marginBottom: "1.25rem",
          }}>
            <p style={{ ...mono, fontSize: "0.55rem", color: "rgba(249,115,22,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "1rem" }}>
              {article ? "Generate New Article" : "Step 1 — Generate Deep Read"}
            </p>

            <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.5)", marginBottom: "1rem", lineHeight: 1.7 }}>
              Agent 306 scans global news for the most important AI story this week, performs a Deep Read cross-referencing 70 years of AI history, and drafts a long-form article. Or paste a specific URL below to Deep Read that article directly.
            </p>

            {/* Optional URL */}
            <div style={{ marginBottom: "1rem" }}>
              <p style={{ ...mono, fontSize: "0.52rem", color: "rgba(227,229,228,0.28)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: "0.4rem" }}>
                Direct URL (optional) — skip auto-discovery and Deep Read a specific article
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="url"
                  value={inputUrl}
                  onChange={e => setInputUrl(e.target.value)}
                  placeholder="https://... paste article URL, or leave blank for auto-discovery"
                  style={{
                    flex: 1, background: "rgba(227,229,228,0.04)",
                    border: "1px solid rgba(227,229,228,0.1)", color: "#e3e5e4",
                    ...mono, fontSize: "0.68rem", padding: "0.55rem 0.85rem",
                    outline: "none", borderRadius: 0,
                  }}
                />
                {inputUrl && (
                  <button onClick={() => setInputUrl("")} style={{ background: "transparent", border: "1px solid rgba(227,229,228,0.1)", color: "rgba(227,229,228,0.35)", ...mono, fontSize: "0.62rem", padding: "0.55rem 0.75rem", cursor: "pointer" }}>✕</button>
                )}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" as const }}>
              <button
                onClick={() => { setGenError(null); genMutation.mutate(); }}
                disabled={genMutation.isPending}
                style={{
                  background: genMutation.isPending ? "rgba(249,115,22,0.15)" : "#f97316",
                  color: genMutation.isPending ? "rgba(249,115,22,0.4)" : "#1a1b1c",
                  border: "none", ...mono, fontSize: "0.7rem", fontWeight: 700,
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
                  <span style={{ ...mono, fontSize: "0.6rem", color: "rgba(249,115,22,0.5)" }}>
                    Agent 306 is researching...
                  </span>
                </div>
              )}
            </div>

            {/* Error */}
            {genError && !genMutation.isPending && (
              <div style={{ marginTop: "1rem", padding: "0.85rem 1rem", background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.2)", borderLeft: "3px solid #f87171" }}>
                <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(248,113,113,0.7)", textTransform: "uppercase" as const, letterSpacing: "0.12em", margin: 0, marginBottom: 4 }}>Error</p>
                <p style={{ ...mono, fontSize: "0.68rem", color: "#f87171", margin: 0, lineHeight: 1.6 }}>{genError}</p>
                <p style={{ ...mono, fontSize: "0.58rem", color: "rgba(227,229,228,0.3)", margin: "0.5rem 0 0" }}>Try again or paste a direct URL above to skip auto-discovery.</p>
              </div>
            )}
          </div>

          {/* ARTICLE PANEL — shown when article exists */}
          {article && (
            <div style={{ border: "1px solid rgba(249,115,22,0.2)", background: "rgba(249,115,22,0.01)", padding: "1.5rem" }}>

              {/* Source */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
                <div>
                  <p style={{ ...mono, fontSize: "0.52rem", color: "rgba(227,229,228,0.3)", textTransform: "uppercase" as const, letterSpacing: "0.12em", margin: 0, marginBottom: 4 }}>Source</p>
                  <p style={{ ...mono, fontSize: "0.7rem", color: "#e3e5e4", margin: 0 }}>{article.sourceTitle}</p>
                  <a href={article.sourceUrl} target="_blank" rel="noreferrer"
                    style={{ ...mono, fontSize: "0.58rem", color: "rgba(249,115,22,0.45)", textDecoration: "none" }}>
                    {article.sourceUrl.slice(0, 65)}...
                  </a>
                </div>
                <span style={{ ...mono, fontSize: "0.55rem", color: "rgba(227,229,228,0.25)", border: "1px solid rgba(227,229,228,0.08)", padding: "3px 8px" }}>
                  {article.body.split(/\s+/).filter(Boolean).length} words
                </span>
              </div>

              {/* ── ACTION BUTTONS — top of review for visibility ── */}
              <div style={{
                padding: "1.25rem",
                background: "rgba(14,15,16,0.8)",
                border: "1px solid rgba(249,115,22,0.15)",
                marginBottom: "1.25rem",
              }}>
                <p style={{ ...mono, fontSize: "0.52rem", color: "rgba(249,115,22,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: 0, marginBottom: "1rem" }}>
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
                    <p key={s} style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", margin: 0 }}>{s}</p>
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
                      border: "none", ...mono, fontSize: "0.7rem", fontWeight: 700,
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
                      border: "none", ...mono, fontSize: "0.7rem", fontWeight: 700,
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
                      color: "rgba(167,139,250,0.6)", ...mono, fontSize: "0.65rem",
                      padding: "0.75rem 1rem", cursor: "pointer",
                      letterSpacing: "0.06em", textTransform: "uppercase" as const,
                    }}
                  >
                    Regenerate
                  </button>
                </div>
              </div>

              {/* Teaser preview */}
              <div style={{ marginBottom: "1.25rem" }}>
                <p style={{ ...mono, fontSize: "0.52rem", color: "rgba(45,212,191,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.5rem" }}>
                  Teaser Post · {article.teaser.length} chars
                </p>
                <div style={{ padding: "1rem", background: "rgba(45,212,191,0.03)", border: "1px solid rgba(45,212,191,0.1)", borderLeft: "3px solid rgba(45,212,191,0.35)" }}>
                  <p style={{ ...mono, fontSize: "0.74rem", color: "#e3e5e4", margin: 0, lineHeight: 1.7, fontStyle: "italic" }}>{article.teaser}</p>
                </div>
              </div>

              {/* Headline */}
              <div style={{ marginBottom: "1rem" }}>
                <p style={{ ...mono, fontSize: "0.52rem", color: "rgba(227,229,228,0.3)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.5rem" }}>Article Headline</p>
                <h2 style={{ ...mono, fontSize: "1.05rem", color: "#e3e5e4", margin: 0, lineHeight: 1.4, fontWeight: 700 }}>{article.headline}</h2>
              </div>

              <div style={{ height: 1, background: "rgba(227,229,228,0.06)", margin: "1.25rem 0" }} />

              {/* Article body */}
              <div style={{ padding: "1.5rem 1.75rem", background: "rgba(10,11,12,0.7)", border: "1px solid rgba(227,229,228,0.06)", maxHeight: "55vh", overflowY: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1.25rem", paddingBottom: "0.75rem", borderBottom: "1px solid rgba(249,115,22,0.12)" }}>
                  <div style={{ width: 26, height: 26, borderRadius: 2, background: "rgba(249,115,22,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: 700, color: "#f97316" }}>306</div>
                  <div>
                    <p style={{ ...mono, fontSize: "0.58rem", color: "#f97316", margin: 0, fontWeight: 700 }}>Agent 306 — The Deep Read</p>
                    <p style={{ ...mono, fontSize: "0.53rem", color: "rgba(227,229,228,0.3)", margin: 0 }}>agent306.eth · 306</p>
                  </div>
                </div>
                <ArticleBody body={article.body} />
                <div style={{ marginTop: "1.5rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(227,229,228,0.05)" }}>
                  <p style={{ ...mono, fontSize: "0.55rem", color: "rgba(227,229,228,0.22)", margin: 0 }}>Agent 306 · agent306.eth</p>
                  <a href={article.sourceUrl} target="_blank" rel="noreferrer" style={{ ...mono, fontSize: "0.55rem", color: "rgba(249,115,22,0.35)", display: "block", marginTop: 3 }}>
                    Source: {article.sourceTitle}
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!article && !genMutation.isPending && !genError && (
            <div style={{ border: "1px solid rgba(167,139,250,0.08)", background: "rgba(167,139,250,0.01)", padding: "1.25rem 1.5rem" }}>
              <p style={{ ...mono, fontSize: "0.55rem", color: "rgba(167,139,250,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.75rem" }}>The Deep Read Format</p>
              {[
                ["Discovery", "Scans global news for the week's biggest AI story — breaking, turning points, things people haven't processed yet."],
                ["Deep Read", "Cross-references 70 years of AI history — from the 1956 Dartmouth Workshop through AI Winters, backprop, transformers, to agents."],
                ["Forward Projection", "What does it mean for the next 70 years? AGI, Human-AI Symbiosis, autonomous economies. The things most analysts won't say."],
                ["Your Workflow", "Generate → Download header image → Copy article text → Post on X manually. Clean and simple."],
              ].map(([t, d]) => (
                <div key={t} style={{ display: "flex", gap: 10, padding: "5px 0", borderBottom: "1px solid rgba(167,139,250,0.05)" }}>
                  <div>
                    <span style={{ ...mono, fontSize: "0.62rem", color: "#a78bfa", display: "block", marginBottom: 2 }}>{t}</span>
                    <span style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.33)", lineHeight: 1.6 }}>{d}</span>
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
            ? <div style={{ padding: "2rem", border: "1px solid rgba(227,229,228,0.07)", textAlign: "center" as const }}>
                <p style={{ ...mono, fontSize: "0.7rem", color: "rgba(227,229,228,0.3)", margin: 0 }}>No articles published yet.</p>
              </div>
            : state.history.map(e => <HistoryCard key={e.articleId} entry={e} />)
          }
        </div>
      )}

      <style>{`@keyframes apulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.7)}}`}</style>
    </div>
  );
}
