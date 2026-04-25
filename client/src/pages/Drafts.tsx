import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Types ──────────────────────────────────────────────────────────────────

type DraftEngine = "article" | "podcast" | "breakthrough" | "blog";

interface ArticleDraft {
  source: "article";
  id: string;
  engine: "article";
  generatedAt: string;
  headline: string;
  teaser: string;
  body: string;
  content: string;
  sourceUrl?: string;
  sourceTitle?: string;
  imageUrl?: string;
}

interface TweetDraft {
  source: "tweet";
  id: string;
  // engine="article" identifies the long-form [306 ARTICLE] top-card
  // manuscript draft (no 280-char limit). Other values are short-form
  // tweet promos.
  engine: "podcast" | "breakthrough" | "blog" | "article";
  generatedAt: string;
  content: string;
  platforms?: string[];
  metadata?: {
    sourceTitle?: string;
    sourceUrl?: string;
    episodeUrl?: string;
    blogSlug?: string;
  };
}

type AnyDraft = ArticleDraft | TweetDraft;

interface DraftsResponse {
  drafts: AnyDraft[];
  counts: {
    total: number;
    article: number;
    podcast: number;
    breakthrough: number;
    blog: number;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const ENGINE_ACCENT: Record<DraftEngine, string> = {
  article:      "#2dd4bf",
  podcast:      "#a78bfa",
  breakthrough: "#f97316",
  blog:         "#60a5fa",
};

const ENGINE_LABEL: Record<DraftEngine, string> = {
  article:      "DEEP READ",
  podcast:      "PODCAST",
  breakthrough: "BREAKTHROUGH",
  blog:         "BLOG",
};

type Filter = "all" | DraftEngine;

// ── Page ───────────────────────────────────────────────────────────────────

export default function Drafts() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>("all");

  const { data, refetch, isLoading } = useQuery<DraftsResponse>({
    queryKey: ["/api/drafts"],
    refetchInterval: 60_000,
  });

  const drafts = data?.drafts ?? [];
  const counts = data?.counts ?? { total: 0, article: 0, podcast: 0, breakthrough: 0, blog: 0 };

  const visible = useMemo(() => {
    if (filter === "all") return drafts;
    return drafts.filter(d => d.engine === filter);
  }, [drafts, filter]);

  // Article drafts live under /api/article/drafts/*; tweet drafts under /api/tweet-drafts/*.
  function endpointBase(d: AnyDraft): string {
    return d.source === "article" ? "/api/article/drafts" : "/api/tweet-drafts";
  }

  async function copyContent(d: AnyDraft) {
    // For articles, prefer headline + body. For tweets, content is already the full copy.
    const text = d.source === "article"
      ? `${d.headline}\n\n${d.body}`
      : d.content;
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: d.source === "article" ? "Draft copied — paste into X Article composer" : "Tweet copied — paste into X" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  }

  async function copyTeaser(d: ArticleDraft) {
    try {
      await navigator.clipboard.writeText(d.teaser);
      toast({ title: "Teaser copied" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  }

  async function markPosted(d: AnyDraft) {
    const postedUrl = window.prompt("Posted URL (optional — press OK to record without URL):") ?? undefined;
    const body = d.source === "article" ? { tweetUrl: postedUrl } : { postedUrl };
    try {
      const r = await apiRequest("POST", `${endpointBase(d)}/${d.id}/mark-posted`, body);
      const out = await r.json();
      if (out.ok) { toast({ title: "Marked as posted" }); refetch(); }
      else toast({ title: out.error ?? "Failed", variant: "destructive" });
    } catch { toast({ title: "Server error", variant: "destructive" }); }
  }

  async function deleteDraft(d: AnyDraft) {
    if (!window.confirm("Delete this draft? This cannot be undone.")) return;
    try {
      const r = await apiRequest("DELETE", `${endpointBase(d)}/${d.id}`);
      const out = await r.json();
      if (out.ok) { toast({ title: "Draft deleted" }); refetch(); }
      else toast({ title: out.error ?? "Failed", variant: "destructive" });
    } catch { toast({ title: "Server error", variant: "destructive" }); }
  }

  return (
    <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.2em", marginBottom: "4px" }}>DRAFTS</div>
        <h1 style={{ fontSize: "26px", fontWeight: 800, color: "#efefef", margin: "0 0 8px", letterSpacing: "-0.02em" }}>
          Unified <span style={{ color: "#f97316" }}>drafts inbox</span>
        </h1>
        <p style={{ fontSize: "15px", color: "rgba(227,229,228,0.68)", margin: 0, lineHeight: 1.6 }}>
          Every engine with auto-post turned off writes here first. Review, copy into X, mark as posted — or delete.
        </p>
      </div>

      {/* Filter chips */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "20px" }}>
        <Chip
          label={`ALL (${counts.total})`}
          accent="#efefef"
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        <Chip
          label={`DEEP READ (${counts.article})`}
          accent={ENGINE_ACCENT.article}
          active={filter === "article"}
          onClick={() => setFilter("article")}
        />
        <Chip
          label={`PODCAST (${counts.podcast})`}
          accent={ENGINE_ACCENT.podcast}
          active={filter === "podcast"}
          onClick={() => setFilter("podcast")}
        />
        <Chip
          label={`BREAKTHROUGH (${counts.breakthrough})`}
          accent={ENGINE_ACCENT.breakthrough}
          active={filter === "breakthrough"}
          onClick={() => setFilter("breakthrough")}
        />
        <Chip
          label={`BLOG (${counts.blog})`}
          accent={ENGINE_ACCENT.blog}
          active={filter === "blog"}
          onClick={() => setFilter("blog")}
        />
      </div>

      {/* List */}
      {isLoading ? (
        <Empty text="Loading drafts…" />
      ) : visible.length === 0 ? (
        <Empty text={filter === "all" ? "No open drafts. Engines with auto-post off will queue work here." : `No open ${ENGINE_LABEL[filter as DraftEngine]} drafts.`} />
      ) : (
        <div>
          {visible.map(d => (
            <DraftCard
              key={`${d.source}-${d.id}`}
              draft={d}
              onCopyContent={() => copyContent(d)}
              onCopyTeaser={d.source === "article" ? () => copyTeaser(d) : undefined}
              onMarkPosted={() => markPosted(d)}
              onDelete={() => deleteDraft(d)}
            />
          ))}
        </div>
      )}

      <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.35)", fontFamily: "monospace", textAlign: "center", marginTop: "24px" }}>
        Drafts refresh every 60 seconds. Flip auto-post on from each engine's page to skip this queue.
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Chip({ label, accent, active, onClick }: { label: string; accent: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background:   active ? accent : "transparent",
        color:        active ? "#0e0f10" : accent,
        border:       `1px solid ${accent}`,
        padding:      "6px 14px",
        fontFamily:   "monospace",
        fontSize:     "12px",
        fontWeight:   700,
        letterSpacing:"0.12em",
        cursor:       "pointer",
      }}
    >
      {label}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{
      border: "1px dashed rgba(227,229,228,0.20)",
      background: "#141516",
      padding: "40px",
      textAlign: "center",
      fontFamily: "monospace",
      fontSize: "14px",
      color: "rgba(227,229,228,0.55)",
    }}>
      {text}
    </div>
  );
}

function DraftCard({
  draft, onCopyContent, onCopyTeaser, onMarkPosted, onDelete,
}: {
  draft: AnyDraft;
  onCopyContent: () => void;
  onCopyTeaser?: () => void;
  onMarkPosted: () => void;
  onDelete: () => void;
}) {
  const accent = ENGINE_ACCENT[draft.engine as DraftEngine];
  // Both the top long-form card (tweet/engine=article) and the bottom Deep
  // Read card (article-source) share engine="article", but they need
  // different badges: the top card is the publish-ready manuscript
  // ([306 ARTICLE]) and the bottom card is the working summary with
  // copy-actions ([306 DEEP READ]).
  const isArticleLongForm = draft.source === "tweet" && draft.engine === "article";
  const label = isArticleLongForm
    ? "ARTICLE"
    : ENGINE_LABEL[draft.engine as DraftEngine];

  // Source display: article drafts have sourceTitle/sourceUrl; tweet drafts may have metadata.sourceTitle/URL or episodeUrl.
  const meta = draft.source === "tweet" ? draft.metadata : undefined;
  const sourceTitle = draft.source === "article" ? draft.sourceTitle : meta?.sourceTitle;
  const sourceUrl   = draft.source === "article" ? draft.sourceUrl   : meta?.sourceUrl;
  const episodeUrl  = draft.source === "tweet" ? meta?.episodeUrl : undefined;

  // The [306 ARTICLE] top-card is a tweet draft whose content is the full
  // long-form manuscript (~600-1500 words). The 280-char tweet counter is
  // misleading there, so show a word count for that one case.
  const charCount = draft.source === "tweet" && !isArticleLongForm
    ? draft.content.length
    : null;
  const wordCount = isArticleLongForm
    ? (draft.content.trim().split(/\s+/).filter(Boolean).length)
    : null;

  return (
    <div style={{
      background:   "#0e0f10",
      border:       `1px solid ${accent}40`,
      borderLeft:   `3px solid ${accent}`,
      padding:      "16px",
      marginBottom: "12px",
    }}>
      {/* Badge + timestamp */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
        <span style={{
          fontSize:     "11px",
          fontFamily:   "monospace",
          letterSpacing:"0.18em",
          fontWeight:   700,
          color:        accent,
          padding:      "3px 8px",
          border:       `1px solid ${accent}`,
        }}>
          [306 {label}]
        </span>
        <span style={{ fontSize: "12px", fontFamily: "monospace", color: "rgba(227,229,228,0.50)" }}>
          {timeAgo(draft.generatedAt)}
        </span>
      </div>

      {/* Headline (articles) */}
      {draft.source === "article" && (
        <div style={{ fontSize: "16px", fontWeight: 700, color: accent, marginBottom: "6px", lineHeight: 1.3 }}>
          {draft.headline}
        </div>
      )}

      {/* Source line */}
      {(sourceTitle || sourceUrl) && (
        <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.50)", fontFamily: "monospace", marginBottom: "10px" }}>
          Source: {sourceUrl ? (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: accent }}>
              {sourceTitle ?? sourceUrl}
            </a>
          ) : sourceTitle}
        </div>
      )}

      {episodeUrl && (
        <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.50)", fontFamily: "monospace", marginBottom: "10px" }}>
          Episode: <a href={episodeUrl} target="_blank" rel="noopener noreferrer" style={{ color: accent }}>{episodeUrl}</a>
        </div>
      )}

      {/* Content preview */}
      <div style={{
        fontSize:   "14px",
        color:      "rgba(227,229,228,0.85)",
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        maxHeight:  (draft.source === "article" || isArticleLongForm) ? "180px" : undefined,
        overflow:   (draft.source === "article" || isArticleLongForm) ? "hidden" : undefined,
        marginBottom: "12px",
      }}>
        {draft.source === "article" ? draft.teaser : draft.content}
      </div>

      {charCount !== null && (
        <div style={{ fontSize: "12px", color: charCount > 240 ? "#f87171" : "rgba(227,229,228,0.48)", fontFamily: "monospace", marginBottom: "10px" }}>
          {charCount} / 240 chars
        </div>
      )}

      {wordCount !== null && (
        <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.48)", fontFamily: "monospace", marginBottom: "10px" }}>
          {wordCount} words · long-form manuscript
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button onClick={onCopyContent}
          style={{ background: "#f97316", color: "#0e0f10", border: "none", padding: "6px 14px", fontFamily: "monospace", fontSize: "12px", fontWeight: 700, cursor: "pointer", letterSpacing: "0.08em" }}>
          {draft.source === "article" ? "COPY ARTICLE" : "COPY CONTENT"}
        </button>
        {onCopyTeaser && (
          <button onClick={onCopyTeaser}
            style={{ background: "transparent", color: accent, border: `1px solid ${accent}`, padding: "6px 14px", fontFamily: "monospace", fontSize: "12px", fontWeight: 700, cursor: "pointer", letterSpacing: "0.08em" }}>
            COPY TEASER
          </button>
        )}
        <button onClick={onMarkPosted}
          style={{ background: "transparent", color: "#4ade80", border: "1px solid #4ade80", padding: "6px 14px", fontFamily: "monospace", fontSize: "12px", fontWeight: 700, cursor: "pointer", letterSpacing: "0.08em" }}>
          MARK POSTED
        </button>
        <button onClick={onDelete}
          style={{ background: "transparent", color: "rgba(248,113,113,0.8)", border: "1px solid rgba(248,113,113,0.3)", padding: "6px 14px", fontFamily: "monospace", fontSize: "12px", cursor: "pointer", letterSpacing: "0.08em" }}>
          DELETE
        </button>
      </div>
    </div>
  );
}
