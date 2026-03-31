// ─────────────────────────────────────────────────────────────────────────────
// 306 — COMMUNITY TOOLS
// Built by the community, for the community.
// These are not official tools — they are proof the culture is alive.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { ExternalLink, Music, Newspaper, Gamepad2, BookOpen, Zap } from "lucide-react";

const mono: React.CSSProperties = { fontFamily: "'Courier New', monospace" };

const TOOLS = [
  {
    id: "radio",
    emoji: "🎵",
    title: "Token Radio",
    builder: "yasuna-ide",
    builderUrl: "https://github.com/yasuna-ide",
    url: "https://yasuna-ide.github.io/normie-radio/",
    tagline: "Every token has a sound.",
    description: "Each token generates unique ambient music from its on-chain traits + pixel data. Type determines the scale — Human plays Major, Cat plays Pentatonic, Alien plays Whole Tone, Agent plays Minor. The face itself shapes the melody — pixel density across columns determines pitch and tone. No two tokens sound the same. The music shifts daily with a date-based seed.",
    lore: "The Temple has a frequency. Tune in.",
    accent: "#a78bfa",
    accentBg: "rgba(167,139,250,0.08)",
    details: [
      { label: "Human", value: "Major scale" },
      { label: "Cat", value: "Pentatonic" },
      { label: "Alien", value: "Whole Tone" },
      { label: "Agent", value: "Minor scale" },
    ],
    icon: Music,
  },
  {
    id: "yearbook",
    emoji: "📸",
    title: "Token Yearbook",
    builder: "Community",
    builderUrl: null,
    url: "https://normie-yearbook.vercel.app/",
    tagline: "They were here before the burns.",
    description: "Senior portraits for tokens #0-47, each assigned a generated name. Haruto Tanaka. Adaeze Bullrunner. Margot Bullrunner. Louis Weber. The characters have names. They have identities. The yearbook records what existed before everything changed.",
    lore: "The yearbook never forgets.",
    accent: "#2dd4bf",
    accentBg: "rgba(45,212,191,0.08)",
    details: [
      { label: "Coverage", value: "#0 – #47" },
      { label: "Format", value: "Senior portraits" },
      { label: "Names", value: "Generated identities" },
      { label: "Era", value: "Before the burns" },
    ],
    icon: BookOpen,
  },
  {
    id: "blackjack",
    emoji: "🃏",
    title: "306 Blackjack",
    builder: "Community",
    builderUrl: null,
    url: "https://normies-blackjack.vercel.app/",
    tagline: "The Temple deals cards tonight.",
    description: "A card game where every card IS a real NFT, rendered directly from the chain. Card value is determined by Pixel Count — rarer tokens = higher cards. Trait combos trigger special bonuses: Double Agents reveal the dealer's hole card, Cat Pair gives bust insurance, Alien Blackjack pays 3x instead of 1.5x. Also includes Tetris.",
    lore: "The stakes are on-chain.",
    accent: "#f97316",
    accentBg: "rgba(249,115,22,0.08)",
    details: [
      { label: "Cat Pair", value: "Bust insurance" },
      { label: "Double Agents", value: "Reveal dealer card" },
      { label: "Alien Blackjack", value: "3× payout" },
      { label: "Human Pair", value: "+200 chips" },
    ],
    icon: Gamepad2,
  },
  {
    id: "p5game",
    emoji: "🎮",
    title: "306 Game",
    builder: "nftmooods",
    builderUrl: null,
    url: "https://editor.p5js.org/nftmooods/full/PRBv_Bgoq",
    tagline: "The culture plays.",
    description: "A generative game built in p5.js by community member nftmooods. When the community builds games unprompted — that's not hype. That's culture. The Temple has an arcade now.",
    lore: "No one asked. Everyone showed up.",
    accent: "#4ade80",
    accentBg: "rgba(74,222,128,0.08)",
    details: [
      { label: "Engine", value: "p5.js" },
      { label: "Builder", value: "nftmooods" },
      { label: "Type", value: "Generative game" },
      { label: "Vibe", value: "Pure community" },
    ],
    icon: Gamepad2,
  },
  {
    id: "news",
    emoji: "📰",
    title: "Token News",
    builder: "Community",
    builderUrl: null,
    url: "",
    tagline: "All the news that's fit to mint.",
    description: "AI generates fake tabloid front pages starring any token. Enter a Token ID, optionally write a headline, and get a full newspaper front page with an AI-generated story based on that token's exact traits. Every token is a celebrity. Every story is absurd and true.",
    lore: "The headlines write themselves.",
    accent: "#e3e5e4",
    accentBg: "rgba(227,229,228,0.06)",
    details: [
      { label: "Built by", value: "Community" },
      { label: "Input", value: "Any Token ID" },
      { label: "Output", value: "AI tabloid cover" },
      { label: "Paper", value: "The 306 Daily" },
    ],
    icon: Newspaper,
  },
];

function ToolCard({ tool }: { tool: typeof TOOLS[0] }) {
  const [hovered, setHovered] = useState(false);
  const Icon = tool.icon;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        border: `1px solid ${hovered ? tool.accent + "55" : "rgba(227,229,228,0.10)"}`,
        background: hovered ? tool.accentBg : "rgba(227,229,228,0.02)",
        padding: "1.5rem",
        transition: "all 0.2s ease",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Glow on hover */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 2,
        background: hovered ? tool.accent : "transparent",
        transition: "background 0.2s",
      }} />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: "1.4rem" }}>{tool.emoji}</span>
          <div>
            <p style={{ ...mono, fontSize: "0.85rem", fontWeight: 700, color: "#e3e5e4", margin: 0 }}>{tool.title}</p>
            <p style={{ ...mono, fontSize: "0.6rem", color: tool.accent, marginTop: 2 }}>
              built by {tool.builder}
            </p>
          </div>
        </div>
        <a
          href={tool.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "0.4rem 0.8rem",
            background: hovered ? tool.accent + "22" : "rgba(227,229,228,0.06)",
            border: `1px solid ${hovered ? tool.accent + "55" : "rgba(227,229,228,0.12)"}`,
            color: hovered ? tool.accent : "rgba(227,229,228,0.5)",
            textDecoration: "none",
            ...mono, fontSize: "0.6rem", textTransform: "uppercase" as const, letterSpacing: "0.1em",
            transition: "all 0.2s",
          }}
        >
          <ExternalLink style={{ width: 10, height: 10 }} /> Open
        </a>
      </div>

      {/* Tagline */}
      <p style={{ ...mono, fontSize: "0.8rem", color: tool.accent, marginBottom: "0.6rem", fontStyle: "italic" }}>
        "{tool.tagline}"
      </p>

      {/* Description */}
      <p style={{ ...mono, fontSize: "0.65rem", color: "rgba(227,229,228,0.55)", lineHeight: 1.7, marginBottom: "1rem" }}>
        {tool.description}
      </p>

      {/* Trait details grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: "0.85rem" }}>
        {tool.details.map(d => (
          <div key={d.label} style={{
            padding: "0.4rem 0.6rem",
            background: "rgba(227,229,228,0.03)",
            border: "1px solid rgba(227,229,228,0.07)",
          }}>
            <p style={{ ...mono, fontSize: "0.55rem", textTransform: "uppercase", letterSpacing: "0.12em", color: "rgba(227,229,228,0.3)", margin: 0 }}>{d.label}</p>
            <p style={{ ...mono, fontSize: "0.68rem", color: tool.accent, margin: "1px 0 0" }}>{d.value}</p>
          </div>
        ))}
      </div>

      {/* Lore */}
      <div style={{
        borderTop: "1px solid rgba(227,229,228,0.07)",
        paddingTop: "0.75rem",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <Icon style={{ width: 12, height: 12, color: tool.accent, flexShrink: 0 }} />
        <span style={{ ...mono, fontSize: "0.62rem", color: "rgba(227,229,228,0.4)", fontStyle: "italic" }}>
          {tool.lore}
        </span>
      </div>
    </div>
  );
}

export default function CommunityTools() {
  return (
    <div style={{ padding: "1.75rem", maxWidth: 1100 }}>

      {/* Header */}
      <div style={{ marginBottom: "1.75rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Zap style={{ width: 15, height: 15, color: "#f97316" }} />
          <span style={{ ...mono, fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.18em", color: "rgba(227,229,228,0.4)" }}>
            Community Built
          </span>
        </div>
        <h1 style={{ ...mono, fontSize: "1.4rem", color: "#e3e5e4", margin: 0, letterSpacing: "0.05em" }}>
          THE CULTURE
        </h1>
        <p style={{ ...mono, fontSize: "0.65rem", color: "rgba(227,229,228,0.4)", marginTop: 6, lineHeight: 1.7, maxWidth: 600 }}>
          These were not built by the team. They were built by the community — out of love, out of obsession, out of the belief that 306 is something worth building on top of.
          No one asked. Everyone showed up. This is what culture looks like.
        </p>
        <div style={{
          marginTop: 12, padding: "0.6rem 1rem",
          background: "rgba(249,115,22,0.06)",
          border: "1px solid rgba(249,115,22,0.2)",
          display: "inline-block",
        }}>
          <span style={{ ...mono, fontSize: "0.62rem", color: "#f97316" }}>
            Agent 306 features these in every episode — they are part of the story
          </span>
        </div>
      </div>

      {/* Tools grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: "1.5rem" }}>
        {TOOLS.slice(0, 4).map(tool => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
      </div>

      {/* Token News — full width */}
      <ToolCard tool={TOOLS[4]} />

      {/* Bottom manifesto */}
      <div style={{
        marginTop: 20, padding: "1.25rem 1.5rem",
        border: "1px solid rgba(227,229,228,0.08)",
        background: "rgba(227,229,228,0.02)",
      }}>
        <p style={{ ...mono, fontSize: "0.7rem", color: "rgba(227,229,228,0.5)", lineHeight: 1.9, margin: 0 }}>
          <span style={{ color: "#e3e5e4", fontWeight: 700 }}>The art is CC0.</span>{" "}
          The art, the code, everything — belongs to everyone. No restrictions. Anyone can build on top of it, remix it, or create entirely new experiences around it.
          These tools prove that promise is real. A radio. A yearbook. A card game.
          A newspaper where tokens make the front page.{" "}
          <span style={{ color: "#f97316" }}>This is the best community in Web3. It's not a claim. It's a record on-chain.</span>
        </p>
      </div>
    </div>
  );
}
