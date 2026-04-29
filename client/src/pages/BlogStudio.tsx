import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PostCard, type BlogPostForCard } from "@/components/BlogPostCard";

// ── Types ──────────────────────────────────────────────────────────────────────
// PR-E0: BlogPost shape (incl. optional verifierReport) lives in
// @/components/BlogPostCard so the card can be exercised in isolation.
type BlogPost = BlogPostForCard;

interface BlogState {
  totalPublished: number;
  totalDrafts: number;
  lastPublishedAt: string | null;
}

const mono  = { fontFamily: "'Courier New', monospace" } as const;
const pixel = { fontFamily: "'Courier New', monospace", textTransform: "uppercase" as const, letterSpacing: "0.15em" } as const;

// ── Main ───────────────────────────────────────────────────────────────────────
export default function BlogStudio() {
  const { toast } = useToast();
  const qc = useQueryClient();

  // ── Manual write state ──
  const [manualTitle, setManualTitle] = useState("");
  const [manualContent, setManualContent] = useState("");
  const [manualTags, setManualTags] = useState("");

  // ── Generate state ──
  const [genTopic, setGenTopic] = useState("");
  const [genSource, setGenSource] = useState("");
  const [genSourceType, setGenSourceType] = useState("standalone");

  const { data: blogStateData } = useQuery<{ posts: any[]; stats: BlogState }>({
    queryKey: ["/api/blog/state"],
    refetchInterval: 30_000,
  });
  const stats = blogStateData?.stats;

  const { data: postsData } = useQuery<{ posts: BlogPost[] }>({
    queryKey: ["/api/blog/posts"],
    refetchInterval: 30_000,
  });
  const posts = postsData?.posts ?? [];

  // ── Mutations ──
  const createMutation = useMutation({
    mutationFn: async (body: { title: string; content: string; tags: string[]; status: string }) => {
      const r = await apiRequest("POST", "/api/blog/posts", { ...body, source: "manual" });
      return await r.json();
    },
    onSuccess: () => {
      toast({ title: "Post created" });
      setManualTitle(""); setManualContent(""); setManualTags("");
      qc.invalidateQueries({ queryKey: ["/api/blog/posts"] });
      qc.invalidateQueries({ queryKey: ["/api/blog/state"] });
    },
    onError: (e: any) => toast({ title: "Create failed", description: e.message, variant: "destructive" }),
  });

  const generateMutation = useMutation({
    mutationFn: async (body: { topic: string; sourceContent: string; source: string; autoPublish: boolean }) => {
      const r = await apiRequest("POST", "/api/blog/generate", body);
      return await r.json();
    },
    onSuccess: () => {
      toast({ title: "Blog post generated" });
      setGenTopic(""); setGenSource("");
      qc.invalidateQueries({ queryKey: ["/api/blog/posts"] });
      qc.invalidateQueries({ queryKey: ["/api/blog/state"] });
    },
    onError: (e: any) => toast({ title: "Generate failed", description: e.message, variant: "destructive" }),
  });

  const publishMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await apiRequest("POST", `/api/blog/posts/${id}/publish`);
      return await r.json();
    },
    onSuccess: () => {
      toast({ title: "Post published" });
      qc.invalidateQueries({ queryKey: ["/api/blog/posts"] });
      qc.invalidateQueries({ queryKey: ["/api/blog/state"] });
    },
    onError: (e: any) => toast({ title: "Publish failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/blog/posts/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Post deleted" });
      qc.invalidateQueries({ queryKey: ["/api/blog/posts"] });
      qc.invalidateQueries({ queryKey: ["/api/blog/state"] });
    },
    onError: (e: any) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // PR #252 — manual revise pipeline. Calls the bounded single-attempt revise
  // endpoint and shows a toast summarizing what came back (published vs.
  // updated_draft vs. no_action vs. error).
  const reviseMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await apiRequest("POST", `/api/blog/posts/${id}/revise`);
      return await r.json();
    },
    onSuccess: (result: any) => {
      const title = result?.title ? `"${result.title}"` : "draft";
      if (result?.outcome === "published") {
        toast({ title: "Revise → published", description: `${title} passed the verifier and was published.` });
      } else if (result?.outcome === "updated_draft") {
        const sev = result?.severity ?? "?";
        const n = result?.unsupportedCount ?? 0;
        toast({ title: "Revise → updated draft", description: `${title} still ${sev} (${n} unsupported claim${n === 1 ? "" : "s"}). Saved for review.` });
      } else if (result?.outcome === "no_action") {
        toast({ title: "Revise — no action", description: result?.error ?? "Post already passes or is published." });
      } else {
        toast({ title: "Revise failed", description: result?.error ?? "Unknown error", variant: "destructive" });
      }
      qc.invalidateQueries({ queryKey: ["/api/blog/posts"] });
      qc.invalidateQueries({ queryKey: ["/api/blog/state"] });
    },
    onError: (e: any) => toast({ title: "Revise failed", description: e.message, variant: "destructive" }),
  });

  const lastPublished = stats?.lastPublishedAt
    ? new Date(stats.lastPublishedAt).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
    : "None yet";

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.5rem" }}>

      {/* Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ ...pixel, fontSize: "1.03rem", color: "#f97316", margin: 0, marginBottom: 6 }}>
          BLOG STUDIO
        </h1>
        <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.60)", margin: 0, lineHeight: 1.6 }}>
          306's Daily Log — publish research, insights, and perspectives to agent306.ai
        </p>
      </div>

      {/* Stats bar */}
      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem", flexWrap: "wrap" as const }}>
        {[
          { label: "Published", value: `${stats?.totalPublished ?? 0} posts`, color: "#f97316", dim: "rgba(249,115,22,0.5)", bg: "rgba(249,115,22,0.04)", border: "rgba(249,115,22,0.12)" },
          { label: "Drafts", value: `${stats?.totalDrafts ?? 0} drafts`, color: "#a78bfa", dim: "rgba(167,139,250,0.5)", bg: "rgba(167,139,250,0.03)", border: "rgba(167,139,250,0.1)" },
          { label: "Last Published", value: lastPublished, color: "#efefef", dim: "rgba(227,229,228,0.48)", bg: "rgba(227,229,228,0.05)", border: "rgba(227,229,228,0.14)" },
        ].map(s => (
          <div key={s.label} style={{ flex: 1, minWidth: 160, background: s.bg, border: `1px solid ${s.border}`, padding: "0.7rem 1rem" }}>
            <p style={{ ...mono, fontSize: "0.68rem", color: s.dim, textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: 0, marginBottom: 4 }}>{s.label}</p>
            <p style={{ ...mono, fontSize: "0.68rem", color: s.color, margin: 0 }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* ── CREATE POST SECTION ── */}
      <div style={{ marginBottom: "1.5rem" }}>
        <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(249,115,22,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "1rem" }}>
          Create Post
        </p>

        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" as const }}>

          {/* Option A: Write Manually */}
          <div style={{
            flex: 1, minWidth: 300,
            border: "1px solid rgba(249,115,22,0.2)", background: "rgba(227,229,228,0.04)", padding: "1.25rem",
          }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: "#f97316", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: "0.75rem" }}>
              Write Manually
            </p>

            <div style={{ marginBottom: "0.6rem" }}>
              <p style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.35)", textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.3rem" }}>Title</p>
              <input
                value={manualTitle}
                onChange={e => setManualTitle(e.target.value)}
                placeholder="Post title"
                style={{
                  width: "100%", background: "rgba(227,229,228,0.08)", border: "1px solid rgba(227,229,228,0.18)",
                  color: "#efefef", ...mono, fontSize: "0.68rem", padding: "0.5rem 0.75rem", outline: "none", borderRadius: 0,
                  boxSizing: "border-box" as const,
                }}
              />
            </div>

            <div style={{ marginBottom: "0.6rem" }}>
              <p style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.35)", textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.3rem" }}>Content (markdown)</p>
              <textarea
                value={manualContent}
                onChange={e => setManualContent(e.target.value)}
                rows={10}
                placeholder="Write your post content in markdown..."
                style={{
                  width: "100%", background: "rgba(227,229,228,0.08)", border: "1px solid rgba(227,229,228,0.18)",
                  color: "#efefef", ...mono, fontSize: "0.68rem", padding: "0.5rem 0.75rem", outline: "none",
                  borderRadius: 0, resize: "vertical" as const, boxSizing: "border-box" as const,
                }}
              />
            </div>

            <div style={{ marginBottom: "0.75rem" }}>
              <p style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.35)", textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.3rem" }}>Tags (comma-separated)</p>
              <input
                value={manualTags}
                onChange={e => setManualTags(e.target.value)}
                placeholder="ai, research, agents"
                style={{
                  width: "100%", background: "rgba(227,229,228,0.08)", border: "1px solid rgba(227,229,228,0.18)",
                  color: "#efefef", ...mono, fontSize: "0.68rem", padding: "0.5rem 0.75rem", outline: "none", borderRadius: 0,
                  boxSizing: "border-box" as const,
                }}
              />
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => createMutation.mutate({ title: manualTitle, content: manualContent, tags: manualTags.split(",").map(t => t.trim()).filter(Boolean), status: "draft" })}
                disabled={createMutation.isPending || !manualTitle.trim() || !manualContent.trim()}
                style={{
                  background: "transparent", border: "1px solid rgba(249,115,22,0.3)", color: "#f97316",
                  ...mono, fontSize: "0.70rem", fontWeight: 700, padding: "0.55rem 1rem", cursor: "pointer",
                  textTransform: "uppercase" as const, opacity: !manualTitle.trim() || !manualContent.trim() ? 0.4 : 1,
                }}
              >
                {createMutation.isPending ? "Saving..." : "Save as Draft"}
              </button>
              <button
                onClick={() => createMutation.mutate({ title: manualTitle, content: manualContent, tags: manualTags.split(",").map(t => t.trim()).filter(Boolean), status: "published" })}
                disabled={createMutation.isPending || !manualTitle.trim() || !manualContent.trim()}
                style={{
                  background: !manualTitle.trim() || !manualContent.trim() ? "rgba(249,115,22,0.15)" : "#f97316",
                  color: !manualTitle.trim() || !manualContent.trim() ? "rgba(249,115,22,0.4)" : "#1a1b1c",
                  border: "none", ...mono, fontSize: "0.70rem", fontWeight: 700, padding: "0.55rem 1rem", cursor: "pointer",
                  textTransform: "uppercase" as const,
                }}
              >
                Publish Now
              </button>
            </div>
          </div>

          {/* Option B: Generate from Topic */}
          <div style={{
            flex: 1, minWidth: 300,
            border: "1px solid rgba(167,139,250,0.15)", background: "rgba(227,229,228,0.04)", padding: "1.25rem",
          }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: "#a78bfa", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: "0.75rem" }}>
              Generate from Topic
            </p>

            <div style={{ marginBottom: "0.6rem" }}>
              <p style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.35)", textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.3rem" }}>Topic</p>
              <input
                value={genTopic}
                onChange={e => setGenTopic(e.target.value)}
                placeholder="What should 306 write about?"
                style={{
                  width: "100%", background: "rgba(227,229,228,0.08)", border: "1px solid rgba(227,229,228,0.18)",
                  color: "#efefef", ...mono, fontSize: "0.68rem", padding: "0.5rem 0.75rem", outline: "none", borderRadius: 0,
                  boxSizing: "border-box" as const,
                }}
              />
            </div>

            <div style={{ marginBottom: "0.6rem" }}>
              <p style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.35)", textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.3rem" }}>Source content (optional)</p>
              <textarea
                value={genSource}
                onChange={e => setGenSource(e.target.value)}
                rows={6}
                placeholder="Paste research findings, podcast script, or chat conversation..."
                style={{
                  width: "100%", background: "rgba(227,229,228,0.08)", border: "1px solid rgba(227,229,228,0.18)",
                  color: "#efefef", ...mono, fontSize: "0.68rem", padding: "0.5rem 0.75rem", outline: "none",
                  borderRadius: 0, resize: "vertical" as const, boxSizing: "border-box" as const,
                }}
              />
            </div>

            <div style={{ marginBottom: "0.75rem" }}>
              <p style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.35)", textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.3rem" }}>Source type</p>
              <select
                value={genSourceType}
                onChange={e => setGenSourceType(e.target.value)}
                style={{
                  width: "100%", background: "rgba(227,229,228,0.08)", border: "1px solid rgba(227,229,228,0.18)",
                  color: "#efefef", ...mono, fontSize: "0.68rem", padding: "0.5rem 0.75rem", outline: "none", borderRadius: 0,
                }}
              >
                {["standalone", "research", "podcast", "chat", "exploration"].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => generateMutation.mutate({ topic: genTopic, sourceContent: genSource, source: genSourceType, autoPublish: false })}
                disabled={generateMutation.isPending || !genTopic.trim()}
                style={{
                  background: "transparent", border: "1px solid rgba(167,139,250,0.3)", color: "#a78bfa",
                  ...mono, fontSize: "0.70rem", fontWeight: 700, padding: "0.55rem 1rem", cursor: "pointer",
                  textTransform: "uppercase" as const, opacity: !genTopic.trim() ? 0.4 : 1,
                }}
              >
                {generateMutation.isPending ? "Generating..." : "Generate Draft"}
              </button>
              <button
                onClick={() => generateMutation.mutate({ topic: genTopic, sourceContent: genSource, source: genSourceType, autoPublish: true })}
                disabled={generateMutation.isPending || !genTopic.trim()}
                style={{
                  background: !genTopic.trim() ? "rgba(167,139,250,0.15)" : "#a78bfa",
                  color: !genTopic.trim() ? "rgba(167,139,250,0.4)" : "#1a1b1c",
                  border: "none", ...mono, fontSize: "0.70rem", fontWeight: 700, padding: "0.55rem 1rem", cursor: "pointer",
                  textTransform: "uppercase" as const,
                }}
              >
                Generate & Publish
              </button>
            </div>

            {generateMutation.isPending && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "0.75rem" }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#a78bfa", animation: "apulse 1.2s infinite" }} />
                <span style={{ ...mono, fontSize: "0.72rem", color: "rgba(167,139,250,0.5)" }}>
                  Agent 306 is writing...
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── POSTS LIST ── */}
      <div>
        <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(249,115,22,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "1rem" }}>
          Posts ({posts.length})
        </p>

        {posts.length === 0
          ? (
            <div style={{ padding: "2rem", border: "1px solid rgba(227,229,228,0.14)", textAlign: "center" as const }}>
              <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.48)", margin: 0 }}>No blog posts yet.</p>
            </div>
          )
          : posts.map(p => (
            <PostCard
              key={p.id}
              post={p}
              onPublish={(id) => publishMutation.mutate(id)}
              onDelete={(id) => deleteMutation.mutate(id)}
              onRevise={(id) => reviseMutation.mutate(id)}
              reviseLoading={reviseMutation.isPending && reviseMutation.variables === p.id}
            />
          ))
        }
      </div>

      <style>{`@keyframes apulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.7)}}`}</style>
    </div>
  );
}
