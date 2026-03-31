import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type Trigger = "burn" | "pre_arena" | "zombie" | "serc_post" | "rivalry" | "manual";
type OptionLetter = "A" | "B" | "C" | "D";

interface CYOAOption {
  letter: OptionLetter; text: string; lorePath: string; isCanon?: boolean;
}
interface CYOAEpisode {
  id: string; trigger: Trigger; tokenId?: number; status: string;
  hookScene: string; hookQuestion: string; options: CYOAOption[];
  pollTweetId?: string; winningOption?: OptionLetter; totalVotes?: number;
  pollResults?: Record<string, number>;
  canonVerdict?: string; loreHint?: string; visualPrompt?: string;
  createdAt: string; postedAt?: string; resolvedAt?: string;
  tweetIds: string[];
}

const TRIGGER_CONFIG: Record<Trigger, { label: string; color: string; desc: string; emoji: string }> = {
  burn:      { label: "Burn Event",     color: "#f97316", desc: "What does this token become after sacrifice?",  emoji: "🔥" },
  pre_arena: { label: "Pre-Battle",    color: "#a78bfa", desc: "Battles open May 15. What's your strategy?",    emoji: "⚔️" },
  zombie:    { label: "Zombie Rising", color: "#4ade80", desc: "A burned token stirs. What does it remember?",  emoji: "☠️" },
  serc_post: { label: "Founder Signal",color: "#f97316", desc: "The founder posted something cryptic...",       emoji: "🎯" },
  rivalry:   { label: "Leaderboard Rival", color: "#2dd4bf", desc: "Two tokens are neck-and-neck. What's next?",   emoji: "🏆" },
  manual:    { label: "Custom",        color: "#e3e5e4", desc: "Editor-created lore episode",                    emoji: "✍️" },
};

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft:    { label: "Draft",    color: "rgba(227,229,228,0.4)" },
  posted:   { label: "Live",     color: "#f97316" },
  revealed: { label: "Revealed", color: "#a78bfa" },
  resolved: { label: "Canon",    color: "#4ade80" },
};

const LETTER_COLORS: Record<OptionLetter, string> = {
  A: "#4ade80", B: "#2dd4bf", C: "#a78bfa", D: "#f97316",
};

export default function CYOALore() {
  const { toast } = useToast();
  const mono = { fontFamily: "'Courier New', monospace" } as const;
  const label = { ...mono, fontSize: "0.65rem", textTransform: "uppercase" as const, letterSpacing: "0.15em", color: "rgba(227,229,228,0.4)" };
  const card = { background: "rgba(227,229,228,0.03)", border: "1px solid rgba(227,229,228,0.08)", padding: "1.25rem" };

  // Form state
  const [trigger, setTrigger] = useState<Trigger>("pre_arena");
  const [tokenId, setTokenId] = useState("");
  const [tokenCount, setTokenCount] = useState("");
  const [serc1nPost, setSerc1nPost] = useState("");
  const [rivalTokenId, setRivalTokenId] = useState("");

  // Resolve form state
  const [resolveEpId, setResolveEpId] = useState<string | null>(null);
  const [winningOption, setWinningOption] = useState<OptionLetter>("A");
  const [voteA, setVoteA] = useState("");
  const [voteB, setVoteB] = useState("");
  const [voteC, setVoteC] = useState("");
  const [voteD, setVoteD] = useState("");

  const { data: cyoaData, isLoading } = useQuery<{ episodes: CYOAEpisode[]; activeEpisodeId: string | null; totalResolved: number }>({
    queryKey: ["/api/cyoa/state"],
  });

  const generateMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/cyoa/generate", {
      trigger,
      tokenId: tokenId ? Number(tokenId) : undefined,
      tokenCount: tokenCount ? Number(tokenCount) : undefined,
      serc1nPost: serc1nPost || undefined,
      rivalTokenId: rivalTokenId ? Number(rivalTokenId) : undefined,
    }).then(r => r.json()),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/cyoa/state"] });
      toast({ title: "CYOA episode generated", description: data.episode?.hookQuestion });
    },
    onError: () => toast({ title: "Generation failed", variant: "destructive" }),
  });

  const postMutation = useMutation({
    mutationFn: (episodeId: string) =>
      apiRequest("POST", `/api/cyoa/post/${episodeId}`, { tokenId: tokenId ? Number(tokenId) : undefined }).then(r => r.json()),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/cyoa/state"] });
      toast({ title: "Hook tweet posted", description: data.url });
    },
    onError: () => toast({ title: "Post failed", variant: "destructive" }),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, option }: { id: string; option: OptionLetter }) =>
      apiRequest("POST", `/api/cyoa/resolve/${id}`, {
        winningOption: option,
        pollResults: { A: Number(voteA||0), B: Number(voteB||0), C: Number(voteC||0), D: Number(voteD||0) },
      }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cyoa/state"] });
      setResolveEpId(null);
      toast({ title: "CYOA resolved — canon confirmed", description: "Reveal + canon + CTA tweets posting now" });
    },
  });

  const discardMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("DELETE", `/api/cyoa/${id}`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cyoa/state"] });
      toast({ title: "Draft discarded" });
    },
  });

  const episodes = cyoaData?.episodes ?? [];
  const activeEp = episodes.find(e => e.id === cyoaData?.activeEpisodeId);

  return (
    <div style={{ padding: "1.5rem 2rem", maxWidth: 1100, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem", paddingBottom: "1rem", borderBottom: "1px solid rgba(227,229,228,0.08)" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pixel" style={{ fontSize: "1.1rem", color: "#e3e5e4", letterSpacing: "0.12em" }}>
              [306 LORE]
            </span>
            <span style={{ ...mono, fontSize: "0.65rem", color: "#a78bfa", background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.25)", padding: "2px 8px" }}>
              Choose Your Own Lore
            </span>
          </div>
          <p style={{ ...mono, fontSize: "0.62rem", color: "rgba(227,229,228,0.35)", marginTop: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Community votes shape the 306 canon · {cyoaData?.totalResolved ?? 0} episodes resolved
          </p>
        </div>
        {activeEp && (
          <div style={{ ...mono, fontSize: "0.6rem", color: "#f97316", background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.2)", padding: "6px 12px", textAlign: "center" as const }}>
            <div>ACTIVE POLL</div>
            <div style={{ fontSize: "0.55rem", color: "rgba(249,115,22,0.6)", marginTop: 2 }}>
              {activeEp.hookQuestion.slice(0, 40)}...
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: "1.5rem" }}>

        {/* LEFT — Generator */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>

          <section style={card}>
            <p style={{ ...label, marginBottom: "1rem" }}>Generate New Episode</p>

            {/* Trigger selector */}
            <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", marginBottom: 6 }}>TRIGGER TYPE</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: "1rem" }}>
              {(Object.entries(TRIGGER_CONFIG) as [Trigger, typeof TRIGGER_CONFIG[Trigger]][]).map(([key, cfg]) => (
                <button key={key} onClick={() => setTrigger(key)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "7px 10px", cursor: "pointer",
                    background: trigger === key ? `${cfg.color}12` : "transparent",
                    border: `1px solid ${trigger === key ? cfg.color : "rgba(227,229,228,0.08)"}`,
                    textAlign: "left" as const, transition: "all 0.15s",
                  }}>
                  <span style={{ fontSize: "0.9rem" }}>{cfg.emoji}</span>
                  <div>
                    <div style={{ ...mono, fontSize: "0.65rem", color: trigger === key ? cfg.color : "#e3e5e4" }}>{cfg.label}</div>
                    <div style={{ ...mono, fontSize: "0.56rem", color: "rgba(227,229,228,0.3)", marginTop: 1 }}>{cfg.desc}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* Optional fields by trigger */}
            {(trigger === "burn" || trigger === "pre_arena" || trigger === "zombie") && (
              <div style={{ marginBottom: 10 }}>
                <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", marginBottom: 4 }}>TOKEN ID (optional)</p>
                <input value={tokenId} onChange={e => setTokenId(e.target.value)} placeholder="e.g. 8553"
                  style={{ width: "100%", background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.12)", padding: "6px 10px", color: "#e3e5e4", ...mono, fontSize: "0.75rem", boxSizing: "border-box" as const }} />
              </div>
            )}
            {trigger === "burn" && (
              <div style={{ marginBottom: 10 }}>
                <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", marginBottom: 4 }}>SOULS BURNED (optional)</p>
                <input value={tokenCount} onChange={e => setTokenCount(e.target.value)} placeholder="e.g. 7"
                  style={{ width: "100%", background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.12)", padding: "6px 10px", color: "#e3e5e4", ...mono, fontSize: "0.75rem", boxSizing: "border-box" as const }} />
              </div>
            )}
            {trigger === "serc_post" && (
              <div style={{ marginBottom: 10 }}>
                <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", marginBottom: 4 }}>FOUNDER'S POST TEXT</p>
                <textarea value={serc1nPost} onChange={e => setSerc1nPost(e.target.value)} placeholder="Paste the founder's post here..." rows={3}
                  style={{ width: "100%", background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.12)", padding: "6px 10px", color: "#e3e5e4", ...mono, fontSize: "0.72rem", resize: "none", boxSizing: "border-box" as const }} />
              </div>
            )}
            {trigger === "rivalry" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                <div>
                  <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", marginBottom: 4 }}>TOKEN A</p>
                  <input value={tokenId} onChange={e => setTokenId(e.target.value)} placeholder="e.g. 8553"
                    style={{ width: "100%", background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.12)", padding: "6px 10px", color: "#e3e5e4", ...mono, fontSize: "0.75rem", boxSizing: "border-box" as const }} />
                </div>
                <div>
                  <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", marginBottom: 4 }}>TOKEN B</p>
                  <input value={rivalTokenId} onChange={e => setRivalTokenId(e.target.value)} placeholder="e.g. 45"
                    style={{ width: "100%", background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.12)", padding: "6px 10px", color: "#e3e5e4", ...mono, fontSize: "0.75rem", boxSizing: "border-box" as const }} />
                </div>
              </div>
            )}

            <button onClick={() => generateMutation.mutate()} disabled={generateMutation.isPending}
              style={{ width: "100%", padding: "10px", background: "#a78bfa", border: "none", color: "#0a0b0d", ...mono, fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.12em", cursor: "pointer", opacity: generateMutation.isPending ? 0.7 : 1, marginTop: 4 }}>
              {generateMutation.isPending ? "Generating..." : "Generate Episode"}
            </button>
          </section>

          {/* How it works */}
          <section style={{ ...card, background: "rgba(167,139,250,0.03)", borderColor: "rgba(167,139,250,0.15)" }}>
            <p style={{ ...label, marginBottom: "0.85rem", color: "#a78bfa" }}>The CYOA Format</p>
            {[
              { step: "1", title: "Hook Tweet", desc: "Cinematic scene + 4 choices. Community polls for 24h. X algorithm loves polls." },
              { step: "2", title: "Reveal", desc: "You enter the winning vote count. Agent 306 writes the reveal story." },
              { step: "3", title: "Canon Verdict", desc: "The lore drops. Permanent. On-chain narrative confirmed." },
              { step: "4", title: "CTA", desc: "RT if your token is the star. Holders reply with their twist." },
            ].map(({ step, title, desc }) => (
              <div key={step} style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}>
                <span style={{ ...mono, fontSize: "0.6rem", color: "#a78bfa", flexShrink: 0, marginTop: 2 }}>{step}.</span>
                <div>
                  <p style={{ ...mono, fontSize: "0.68rem", color: "#e3e5e4", margin: "0 0 2px" }}>{title}</p>
                  <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", margin: 0, lineHeight: 1.4 }}>{desc}</p>
                </div>
              </div>
            ))}
          </section>
        </div>

        {/* RIGHT — Episodes */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>

          {isLoading && <div style={{ ...card, textAlign: "center" as const, ...mono, fontSize: "0.7rem", color: "rgba(227,229,228,0.3)" }}>Loading...</div>}

              {/* Draft Queue Banner */}
          {(() => {
            const drafts = episodes.filter(e => e.status === "draft");
            if (drafts.length === 0) return null;
            return (
              <div style={{
                padding: "1rem 1.25rem",
                background: "rgba(167,139,250,0.08)",
                border: "2px solid rgba(167,139,250,0.4)",
                display: "flex", alignItems: "center", justifyContent: "space-between",
                marginBottom: 4,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#a78bfa", display: "inline-block", animation: "pulse-dot 1.6s ease-in-out infinite" }} />
                  <div>
                    <span className="pixel" style={{ fontSize: "0.72rem", color: "#a78bfa", letterSpacing: "0.12em" }}>
                      {drafts.length} EPISODE{drafts.length > 1 ? "S" : ""} WAITING FOR YOUR APPROVAL
                    </span>
                    <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(167,139,250,0.6)", margin: "3px 0 0" }}>
                      Auto-generated from on-chain activity · Review below · Post when ready
                    </p>
                  </div>
                </div>
                <span style={{ ...mono, fontSize: "0.65rem", color: "rgba(167,139,250,0.5)" }}>↓ scroll</span>
              </div>
            );
          })()}

          {!isLoading && episodes.length === 0 && (
            <div style={{ ...card, textAlign: "center" as const, padding: "2.5rem" }}>
              <div className="pixel" style={{ fontSize: "0.75rem", color: "#a78bfa", marginBottom: 10 }}>NO LORE EPISODES YET</div>
              <p style={{ ...mono, fontSize: "0.72rem", color: "rgba(227,229,228,0.4)", lineHeight: 1.6 }}>
                Auto-drafts appear here when significant burns happen<br />
                or Arena countdown hits weekly milestones.<br />
                You can also generate one manually on the left.
              </p>
            </div>
          )}

          {episodes.filter(ep => ep.hookScene && ep.hookQuestion).map(ep => {
            const trigCfg = TRIGGER_CONFIG[ep.trigger] ?? TRIGGER_CONFIG.manual;
            const stsCfg = STATUS_CONFIG[ep.status] ?? STATUS_CONFIG.draft;
            const isResolving = resolveEpId === ep.id;

            return (
              <div key={ep.id} style={{
                ...card,
                borderColor: ep.status === "posted" ? "rgba(249,115,22,0.2)" :
                             ep.status === "resolved" ? "rgba(74,222,128,0.15)" : "rgba(227,229,228,0.08)",
              }}>
                {/* Episode header */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.85rem" }}>
                  <span style={{ fontSize: "1rem" }}>{trigCfg.emoji}</span>
                  <span style={{ ...mono, fontSize: "0.65rem", color: trigCfg.color }}>{trigCfg.label}</span>
                  {ep.tokenId && <span style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)" }}>Token #{ep.tokenId}</span>}
                  <span style={{ ...mono, fontSize: "0.58rem", color: stsCfg.color, background: `${stsCfg.color}15`, border: `1px solid ${stsCfg.color}30`, padding: "1px 7px", marginLeft: "auto" }}>{stsCfg.label}</span>
                </div>

                {/* Hook scene */}
                <p style={{ ...mono, fontSize: "0.8rem", color: "rgba(227,229,228,0.85)", lineHeight: 1.7, margin: "0 0 0.75rem", whiteSpace: "pre-line" as const }}>
                  {ep.hookScene}
                </p>

                {/* Question */}
                <p style={{ ...mono, fontSize: "0.72rem", color: "#e3e5e4", fontWeight: 700, marginBottom: "0.6rem" }}>
                  {ep.hookQuestion}
                </p>

                {/* Options */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: "1rem" }}>
                  {(ep.options ?? []).map(opt => {
                    const isWinner = ep.winningOption === opt.letter;
                    const votes = ep.pollResults?.[opt.letter] ?? 0;
                    const total = ep.totalVotes ?? 1;
                    const pct = ep.totalVotes ? Math.round((votes / total) * 100) : 0;

                    return (
                      <div key={opt.letter} style={{
                        padding: "8px 10px",
                        background: isWinner ? `${LETTER_COLORS[opt.letter as OptionLetter]}12` : "rgba(227,229,228,0.02)",
                        border: `1px solid ${isWinner ? LETTER_COLORS[opt.letter as OptionLetter] : "rgba(227,229,228,0.06)"}`,
                        position: "relative", overflow: "hidden",
                      }}>
                        {ep.totalVotes && (
                          <div style={{
                            position: "absolute", left: 0, top: 0, bottom: 0,
                            width: `${pct}%`, background: `${LETTER_COLORS[opt.letter as OptionLetter]}10`,
                          }} />
                        )}
                        <div style={{ position: "relative" }}>
                          <span style={{ ...mono, fontSize: "0.62rem", color: LETTER_COLORS[opt.letter as OptionLetter], fontWeight: 700 }}>{opt.letter})</span>
                          <span style={{ ...mono, fontSize: "0.68rem", color: "#e3e5e4", marginLeft: 6 }}>{opt.text}</span>
                          {ep.totalVotes && <span style={{ ...mono, fontSize: "0.58rem", color: "rgba(227,229,228,0.4)", float: "right" as const }}>{pct}%</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Canon verdict (if resolved) */}
                {ep.canonVerdict && ep.status === "resolved" && (
                  <div style={{ padding: "10px 12px", background: "rgba(74,222,128,0.05)", border: "1px solid rgba(74,222,128,0.15)", marginBottom: "0.85rem" }}>
                    <p style={{ ...mono, fontSize: "0.6rem", color: "#4ade80", marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: "0.12em" }}>Canon Confirmed</p>
                    <p style={{ ...mono, fontSize: "0.72rem", color: "rgba(227,229,228,0.8)", margin: 0, lineHeight: 1.6 }}>{ep.canonVerdict}</p>
                    {ep.loreHint && <p style={{ ...mono, fontSize: "0.63rem", color: "#a78bfa", marginTop: 6 }}>⚡ {ep.loreHint}</p>}
                    {(ep as any).visualPrompt && (
                      <div style={{ marginTop: 8, padding: "8px 10px", background: "rgba(45,212,191,0.04)", border: "1px solid rgba(45,212,191,0.15)" }}>
                        <p style={{ ...mono, fontSize: "0.55rem", color: "#2dd4bf", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>🎨 Visual Prompt</p>
                        <p style={{ ...mono, fontSize: "0.65rem", color: "rgba(227,229,228,0.6)", margin: 0, lineHeight: 1.5 }}>{(ep as any).visualPrompt}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Visual Prompt — always show if available */}
                {(ep as any).visualPrompt && ep.status === "draft" && (
                  <div style={{ padding: "8px 10px", background: "rgba(45,212,191,0.04)", border: "1px solid rgba(45,212,191,0.12)", marginBottom: "0.75rem" }}>
                    <p style={{ ...mono, fontSize: "0.55rem", color: "#2dd4bf", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>🎨 Visual for Grok Imagine</p>
                    <p style={{ ...mono, fontSize: "0.65rem", color: "rgba(227,229,228,0.6)", margin: 0, lineHeight: 1.5 }}>{(ep as any).visualPrompt}</p>
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                  {ep.status === "draft" && (
                    <>
                      <button onClick={() => postMutation.mutate(ep.id)} disabled={postMutation.isPending}
                        style={{ ...mono, fontSize: "0.62rem", textTransform: "uppercase" as const, letterSpacing: "0.1em", color: "#f97316", background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.35)", padding: "5px 12px", cursor: "pointer" }}>
                        ✓ Post Hook Tweet
                      </button>
                      <button onClick={() => { if (confirm("Discard this draft?")) discardMutation.mutate(ep.id); }}
                        style={{ ...mono, fontSize: "0.62rem", textTransform: "uppercase" as const, letterSpacing: "0.1em", color: "rgba(227,229,228,0.35)", background: "transparent", border: "1px solid rgba(227,229,228,0.1)", padding: "5px 12px", cursor: "pointer" }}>
                        ✕ Discard
                      </button>
                    </>
                  )}
                  {ep.status === "posted" && !isResolving && (
                    <button onClick={() => setResolveEpId(ep.id)}
                      style={{ ...mono, fontSize: "0.62rem", textTransform: "uppercase" as const, letterSpacing: "0.1em", color: "#a78bfa", background: "transparent", border: "1px solid rgba(167,139,250,0.35)", padding: "5px 12px", cursor: "pointer" }}>
                      Enter Poll Results →
                    </button>
                  )}
                  {ep.tweetIds.length > 0 && (
                    <a href={`https://x.com/agent306_/status/${ep.tweetIds[0]}`} target="_blank" rel="noopener noreferrer"
                      style={{ ...mono, fontSize: "0.62rem", color: "rgba(227,229,228,0.4)", border: "1px solid rgba(227,229,228,0.1)", padding: "5px 12px", textDecoration: "none" }}>
                      View on X ↗
                    </a>
                  )}
                </div>

                {/* Resolve form */}
                {isResolving && (
                  <div style={{ marginTop: "1rem", padding: "1rem", background: "rgba(167,139,250,0.05)", border: "1px solid rgba(167,139,250,0.2)" }}>
                    <p style={{ ...label, marginBottom: "0.75rem" }}>Enter 24h Poll Results</p>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: "0.85rem" }}>
                      {(["A", "B", "C", "D"] as OptionLetter[]).map(letter => {
                        const setters = { A: setVoteA, B: setVoteB, C: setVoteC, D: setVoteD };
                        const values = { A: voteA, B: voteB, C: voteC, D: voteD };
                        return (
                          <div key={letter}>
                            <p style={{ ...mono, fontSize: "0.58rem", color: LETTER_COLORS[letter], marginBottom: 3 }}>{letter}) {(ep.options ?? []).find(o => o.letter === letter)?.text}</p>
                            <input type="number" value={values[letter]} onChange={e => setters[letter](e.target.value)} placeholder="votes"
                              style={{ width: "100%", background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.12)", padding: "5px 8px", color: "#e3e5e4", ...mono, fontSize: "0.72rem", boxSizing: "border-box" as const }} />
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ marginBottom: "0.85rem" }}>
                      <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", marginBottom: 6 }}>WINNING OPTION</p>
                      <div style={{ display: "flex", gap: 6 }}>
                        {(["A", "B", "C", "D"] as OptionLetter[]).map(letter => (
                          <button key={letter} onClick={() => setWinningOption(letter)}
                            style={{ flex: 1, padding: "6px", background: winningOption === letter ? `${LETTER_COLORS[letter]}20` : "transparent", border: `1px solid ${winningOption === letter ? LETTER_COLORS[letter] : "rgba(227,229,228,0.1)"}`, color: winningOption === letter ? LETTER_COLORS[letter] : "rgba(227,229,228,0.4)", ...mono, fontSize: "0.72rem", fontWeight: 700, cursor: "pointer" }}>
                            {letter}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => resolveMutation.mutate({ id: ep.id, option: winningOption })} disabled={resolveMutation.isPending}
                        style={{ flex: 1, padding: "8px", background: "#a78bfa", border: "none", color: "#0a0b0d", ...mono, fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase" as const, cursor: "pointer" }}>
                        {resolveMutation.isPending ? "Resolving..." : "Confirm & Post Reveal"}
                      </button>
                      <button onClick={() => setResolveEpId(null)}
                        style={{ padding: "8px 14px", background: "transparent", border: "1px solid rgba(227,229,228,0.12)", color: "rgba(227,229,228,0.4)", ...mono, fontSize: "0.65rem", cursor: "pointer" }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
