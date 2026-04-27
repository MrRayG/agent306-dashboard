import { useState } from "react";
import { VerifierReport, type VerifierReportData } from "./VerifierReport";

// ── Types ──────────────────────────────────────────────────────────────────────
// PR-E0: Mirror of the server-persisted BlogPost shape from
// server/blogEngine.ts. The `verifierReport` field is what enables the
// quarantine detail panel below; everything else is the pre-PR-E0 shape.
export interface BlogPostForCard {
  id: string;
  title: string;
  slug: string;
  content: string;
  source: string;
  tags: string[];
  status: "draft" | "published" | "archived" | "quarantined";
  wordCount: number;
  readingTime: number;
  createdAt: string;
  publishedAt?: string;
  verifierReport?: VerifierReportData;
}

const mono = { fontFamily: "'Courier New', monospace" } as const;

// ── Quarantine signal ─────────────────────────────────────────────────────────
// Quarantine is currently expressed two ways on the wire:
//   1. status === "quarantined" (set by createBlogPost when verifier HARD_FAIL),
//   2. tags includes "claim-verifier-quarantine" (also set in the same path).
// Treat either as quarantined for rendering so the panel surfaces regardless of
// which signal the API path happens to expose at any given time.
export function isQuarantinedPost(post: { status?: string; tags?: string[] }): boolean {
  if (post.status === "quarantined") return true;
  return Array.isArray(post.tags) && post.tags.includes("claim-verifier-quarantine");
}

// ── PostCard ──────────────────────────────────────────────────────────────────
// Pure render component — no API/data-fetching imports, so it can be exercised
// directly in node:test via react-dom/server without pulling the whole
// BlogStudio page (with its query-client + hooks chain) into the test
// environment.
export function PostCard({
  post,
  onPublish,
  onDelete,
}: {
  post: BlogPostForCard;
  onPublish: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const quarantined = isQuarantinedPost(post);
  // Default the verifier panel OPEN on quarantined posts — the whole point of
  // PR-E0 is that operators see *why* without leaving the dashboard, so
  // collapsing it would defeat the spec's acceptance criterion.
  const [verifierOpen, setVerifierOpen] = useState<boolean>(quarantined);

  const created = new Date(post.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const published = post.publishedAt
    ? new Date(post.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  const statusColor = post.status === "published" ? "#f97316"
    : post.status === "archived" ? "rgba(227,229,228,0.35)"
    : post.status === "quarantined" ? "#f87171"
    : "rgba(227,229,228,0.55)";
  const statusBg = post.status === "published" ? "rgba(249,115,22,0.08)"
    : post.status === "archived" ? "rgba(227,229,228,0.04)"
    : post.status === "quarantined" ? "rgba(248,113,113,0.08)"
    : "rgba(227,229,228,0.06)";

  // Show the verifier panel only when the server actually persisted one AND
  // the entries array is non-empty. Posts without a verifierReport (or with
  // an empty entries array) fall back to the pre-PR-E0 layout exactly — no
  // panel, no extra height, no behavior change.
  const hasVerifierEntries = !!post.verifierReport && (post.verifierReport.entries?.length ?? 0) > 0;
  const showVerifierSection = hasVerifierEntries && quarantined;

  return (
    <div style={{ border: "1px solid rgba(227,229,228,0.14)", background: "rgba(227,229,228,0.04)", marginBottom: "0.6rem", padding: "1rem 1.25rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <p style={{ ...mono, fontSize: "0.90rem", color: "#efefef", margin: 0, fontWeight: 700 }}>{post.title}</p>
            <span style={{
              ...mono, fontSize: "0.60rem", textTransform: "uppercase" as const, letterSpacing: "0.1em",
              color: statusColor, background: statusBg, padding: "2px 6px", border: `1px solid ${statusColor}33`,
            }}>{post.status}</span>
          </div>
          <p style={{ ...mono, fontSize: "0.72rem", color: "rgba(227,229,228,0.48)", margin: 0 }}>
            {created}{published ? ` · Published ${published}` : ""} · {post.source} · {post.wordCount} words · {post.readingTime} min read
          </p>
          {post.tags.length > 0 && (
            <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" as const }}>
              {post.tags.map(t => (
                <span key={t} style={{ ...mono, fontSize: "0.58rem", color: "rgba(249,115,22,0.5)", border: "1px solid rgba(249,115,22,0.15)", padding: "1px 5px" }}>{t}</span>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {post.status === "draft" && (
            <button onClick={() => onPublish(post.id)} style={{
              ...mono, fontSize: "0.70rem", background: "#f97316", color: "#1a1b1c", border: "none",
              padding: "4px 10px", cursor: "pointer", textTransform: "uppercase" as const, fontWeight: 700,
            }}>Publish</button>
          )}
          {post.status === "published" && (
            <a href={`https://agent306.ai/blog/${post.slug}`} target="_blank" rel="noreferrer"
              style={{ ...mono, fontSize: "0.70rem", color: "#4ade80", border: "1px solid rgba(74,222,128,0.2)", padding: "4px 10px", textDecoration: "none", textTransform: "uppercase" as const }}>
              View →
            </a>
          )}
          <button onClick={() => setOpen(v => !v)} style={{
            ...mono, fontSize: "0.70rem", background: "transparent", border: "1px solid rgba(227,229,228,0.20)",
            color: "rgba(227,229,228,0.60)", cursor: "pointer", padding: "4px 10px", textTransform: "uppercase" as const,
          }}>{open ? "Collapse" : "Preview"}</button>
          <button onClick={() => onDelete(post.id)} style={{
            ...mono, fontSize: "0.70rem", background: "transparent", border: "1px solid rgba(248,113,113,0.2)",
            color: "rgba(248,113,113,0.5)", cursor: "pointer", padding: "4px 10px", textTransform: "uppercase" as const,
          }}>Delete</button>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid rgba(227,229,228,0.12)" }}>
          <div style={{ ...mono, fontSize: "0.74rem", color: "rgba(227,229,228,0.7)", lineHeight: 1.8, whiteSpace: "pre-wrap" as const, maxHeight: "40vh", overflowY: "auto" as const }}>
            {post.content.slice(0, 3000)}{post.content.length > 3000 ? "\n\n[truncated]" : ""}
          </div>
        </div>
      )}

      {/* PR-E0: quarantine detail panel.
          Renders only when the server persisted a non-empty verifierReport
          AND the post is quarantined. Posts without a verifierReport (or
          with an empty entries array) render exactly as before. */}
      {showVerifierSection && (
        <div
          data-testid="blog-verifier-section"
          style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(248,113,113,0.18)" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: verifierOpen ? "0.5rem" : 0 }}>
            <div style={{ ...mono, fontSize: "0.70rem", color: "#f87171", letterSpacing: "0.10em", textTransform: "uppercase" as const }}>
              Verifier report · {post.verifierReport!.entries.length} {post.verifierReport!.entries.length === 1 ? "entry" : "entries"}
            </div>
            <button
              onClick={() => setVerifierOpen(v => !v)}
              aria-label={verifierOpen ? "Collapse verifier report" : "Expand verifier report"}
              style={{
                ...mono,
                fontSize: "0.66rem",
                background: "transparent",
                border: "1px solid rgba(248,113,113,0.25)",
                color: "rgba(248,113,113,0.75)",
                cursor: "pointer",
                padding: "2px 8px",
                textTransform: "uppercase" as const,
              }}
            >
              {verifierOpen ? "Collapse" : "Expand"}
            </button>
          </div>
          {verifierOpen && (
            <VerifierReport report={post.verifierReport} compact />
          )}
        </div>
      )}
    </div>
  );
}
