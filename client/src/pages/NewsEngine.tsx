import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

// ─── Types ────────────────────────────────────────────────────────
interface MarketCoin {
  id: string; name: string; symbol: string;
  price: number; change24h: number; marketCap: number; image: string;
}
interface Headline {
  id: number; title: string; url: string; source: string;
  publishedAt: string; votes: any; currencies: string[];
  kind: string; domain: string;
}
interface BurnRecord {
  tokenId: number; burnedCount: number; timestamp: string; level: number;
}
interface ChainNFT {
  chain: string; chainLabel: string; chainColor: string;
  collection: string;
  floor: string | null; floorUSD: number | null;
  change24h: string | null; volume24h: string | null; marketCap: string | null;
  status: "hot" | "cool" | "building"; note?: string;
}
interface MemeCoin {
  symbol: string; name: string; price: number;
  change24h: number; volume24h: number; chain: string;
  status: "hot" | "up" | "cool";
}
interface AINewsItem {
  title: string; url: string; source: string;
  sourceColor: string; publishedAt: string; snippet: string;
}
interface NewsData {
  market: MarketCoin[]; headlines: Headline[];
  burns: BurnRecord[]; grokNews: string | null;
  nftByChain: ChainNFT[]; memeCoins: MemeCoin[];
  aiNews: AINewsItem[];
  generatedAt: string;
}

// ─── Helpers ───────────────────────────────────────────────────────
function fmtPrice(n: number) {
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${n.toFixed(4)}`;
}
function fmtMCap(n: number) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}
function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)    return `${Math.floor(diff)}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Sub-components ───────────────────────────────────────────────

function SectionLabel({ children, accent }: { children: React.ReactNode; accent?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1rem" }}>
      <div style={{
        width: 3, height: 18,
        background: accent || "#f97316",
        flexShrink: 0,
      }} />
      <span className="pixel upper" style={{ fontSize: "0.7rem", letterSpacing: "0.2em", color: "#e3e5e4" }}>
        {children}
      </span>
    </div>
  );
}

function Ticker({ market }: { market: MarketCoin[] }) {
  const coins = market.length > 0 ? market : [
    { id: "eth", symbol: "ETH", name: "Ethereum", price: 3241.08, change24h: 2.14, marketCap: 389e9, image: "" },
    { id: "btc", symbol: "BTC", name: "Bitcoin",  price: 68420,  change24h: 0.87, marketCap: 1.35e12, image: "" },
  ];
  return (
    <div style={{
      display: "flex", gap: 1, overflowX: "auto",
      borderBottom: "1px solid rgba(227,229,228,0.08)",
      paddingBottom: 0,
      marginBottom: "1.5rem",
    }}>
      {coins.map(c => {
        const up = c.change24h >= 0;
        return (
          <div key={c.id} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "0.55rem 1rem",
            borderRight: "1px solid rgba(227,229,228,0.08)",
            minWidth: 160,
            background: "rgba(227,229,228,0.02)",
          }}>
            {c.image && (
              <img src={c.image} alt={c.symbol} style={{ width: 20, height: 20, borderRadius: "50%", flexShrink: 0 }} />
            )}
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span className="pixel" style={{ fontSize: "0.72rem", color: "#e3e5e4", letterSpacing: "0.1em" }}>{c.symbol}</span>
                <span style={{ fontFamily: "'Courier New'", fontSize: "0.65rem", color: "rgba(227,229,228,0.4)" }}>{fmtPrice(c.price)}</span>
              </div>
              <div style={{
                fontFamily: "'Courier New'",
                fontSize: "0.6rem",
                color: up ? "#4ade80" : "#f87171",
                marginTop: 1,
              }}>
                {up ? "▲" : "▼"} {Math.abs(c.change24h).toFixed(2)}% 24h
              </div>
            </div>
          </div>
        );
      })}
      {/* Agent 306 status */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "0.55rem 1rem",
        minWidth: 180,
        background: "rgba(249,115,22,0.04)",
        borderRight: "1px solid rgba(249,115,22,0.15)",
      }}>
        <div style={{ width: 20, height: 20, borderRadius: 2, background: "rgba(249,115,22,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", fontWeight: 700, color: "#f97316", flexShrink: 0 }}>306</div>
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span className="pixel" style={{ fontSize: "0.72rem", color: "#f97316", letterSpacing: "0.1em" }}>AGENT 306</span>
            <span style={{ fontFamily: "'Courier New'", fontSize: "0.65rem", color: "rgba(227,229,228,0.4)" }}>Active</span>
          </div>
          <div style={{ fontFamily: "'Courier New'", fontSize: "0.6rem", color: "#f97316", marginTop: 1 }}>
            🔥 Building
          </div>
        </div>
      </div>
    </div>
  );
}

function MarketCard({ coin }: { coin: MarketCoin }) {
  const up = coin.change24h >= 0;
  return (
    <div style={{
      background: "rgba(227,229,228,0.03)",
      border: "1px solid rgba(227,229,228,0.08)",
      padding: "1rem",
      display: "flex", flexDirection: "column", gap: 6,
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Color flash */}
      <div style={{
        position: "absolute", left: 0, top: 0, bottom: 0, width: 3,
        background: up ? "#4ade80" : "#f87171",
      }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 8 }}>
        {coin.image && (
          <img src={coin.image} alt={coin.symbol} style={{ width: 24, height: 24, borderRadius: "50%" }} />
        )}
        <span className="pixel" style={{ fontSize: "0.75rem", color: "#e3e5e4", letterSpacing: "0.12em" }}>{coin.symbol}</span>
        <span style={{ fontFamily: "'Courier New'", fontSize: "0.6rem", color: "rgba(227,229,228,0.35)", marginLeft: "auto" }}>{coin.name}</span>
      </div>
      <div style={{ paddingLeft: 8 }}>
        <div style={{ fontFamily: "'Courier New'", fontSize: "1.1rem", color: "#e3e5e4", fontWeight: 600 }}>
          {fmtPrice(coin.price)}
        </div>
        <div style={{
          display: "flex", gap: 12, marginTop: 4,
          fontFamily: "'Courier New'", fontSize: "0.62rem",
        }}>
          <span style={{ color: up ? "#4ade80" : "#f87171" }}>
            {up ? "▲" : "▼"} {Math.abs(coin.change24h).toFixed(2)}%
          </span>
          <span style={{ color: "rgba(227,229,228,0.35)" }}>MCap {fmtMCap(coin.marketCap)}</span>
        </div>
      </div>
    </div>
  );
}

function HeadlineCard({ h, index }: { h: Headline; index: number }) {
  const up = h.votes?.positive > h.votes?.negative;
  const sentColor = up ? "#4ade80" : h.votes?.negative > 2 ? "#f87171" : "rgba(227,229,228,0.4)";
  return (
    <a
      href={h.url} target="_blank" rel="noopener noreferrer"
      style={{ textDecoration: "none", color: "inherit", display: "block" }}
    >
      <div style={{
        background: "rgba(227,229,228,0.02)",
        border: "1px solid rgba(227,229,228,0.07)",
        padding: "0.85rem 1rem",
        display: "flex", gap: 12, alignItems: "flex-start",
        transition: "border-color 0.15s, background 0.15s",
        cursor: "pointer",
      }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLElement).style.borderColor = "rgba(249,115,22,0.35)";
          (e.currentTarget as HTMLElement).style.background = "rgba(249,115,22,0.04)";
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLElement).style.borderColor = "rgba(227,229,228,0.07)";
          (e.currentTarget as HTMLElement).style.background = "rgba(227,229,228,0.02)";
        }}
      >
        {/* Index */}
        <span className="pixel" style={{
          fontSize: "0.65rem", color: "rgba(249,115,22,0.5)",
          minWidth: 20, paddingTop: 2,
        }}>
          {String(index + 1).padStart(2, "0")}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            fontFamily: "'Courier New'", fontSize: "0.8rem",
            color: "#e3e5e4", lineHeight: 1.5, margin: 0,
            textWrap: "pretty" as any,
          }}>
            {h.title}
          </p>
          <div style={{
            display: "flex", gap: 10, marginTop: 6,
            fontFamily: "'Courier New'", fontSize: "0.58rem",
            color: "rgba(227,229,228,0.4)",
            flexWrap: "wrap",
          }}>
            <span>{h.source}</span>
            <span>·</span>
            <span>{timeAgo(h.publishedAt)}</span>
            {h.currencies.length > 0 && (
              <>
                <span>·</span>
                {h.currencies.map(c => (
                  <span key={c} style={{
                    background: "rgba(249,115,22,0.1)",
                    color: "#f97316",
                    padding: "0 5px",
                    fontSize: "0.56rem",
                  }}>{c}</span>
                ))}
              </>
            )}
            {h.votes?.positive > 0 && (
              <span style={{ marginLeft: "auto", color: sentColor }}>
                {up ? "▲" : "▼"} {h.votes.positive}/{h.votes.negative}
              </span>
            )}
          </div>
        </div>
      </div>
    </a>
  );
}

function BurnFeed({ burns }: { burns: BurnRecord[] }) {
  const items = burns.length > 0 ? burns : [
    { tokenId: 8553, burnedCount: 12, timestamp: new Date(Date.now() - 1000 * 60 * 14).toISOString(), level: 6 },
    { tokenId: 235,  burnedCount: 7,  timestamp: new Date(Date.now() - 1000 * 60 * 38).toISOString(), level: 4 },
    { tokenId: 615,  burnedCount: 19, timestamp: new Date(Date.now() - 1000 * 60 * 75).toISOString(), level: 10 },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {items.map((b, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "0.6rem 0.85rem",
          background: "rgba(249,115,22,0.03)",
          border: "1px solid rgba(249,115,22,0.08)",
        }}>
          <img
            src={`/api/tokens/${b.tokenId}/image.png`}
            alt={`#${b.tokenId}`}
            style={{ width: 32, height: 32, imageRendering: "pixelated", flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="pixel" style={{ fontSize: "0.68rem", color: "#f97316" }}>#{b.tokenId}</span>
              <span style={{
                fontFamily: "'Courier New'", fontSize: "0.6rem",
                background: "rgba(249,115,22,0.12)", color: "#f97316",
                padding: "1px 6px", border: "1px solid rgba(249,115,22,0.25)",
              }}>
                {b.burnedCount} {b.burnedCount === 1 ? "soul" : "souls"} sacrificed
              </span>
            </div>
            <div style={{ fontFamily: "'Courier New'", fontSize: "0.58rem", color: "rgba(227,229,228,0.35)", marginTop: 3 }}>
              {timeAgo(b.timestamp)} · Lv.{b.level}
            </div>
          </div>
          <span style={{ fontSize: "1rem" }}>🔥</span>
        </div>
      ))}
    </div>
  );
}

// ── Chain badge ──────────────────────────────────────────────────────
function ChainBadge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontFamily: "'Courier New'", fontSize: "0.55rem",
      textTransform: "uppercase", letterSpacing: "0.1em",
      color, background: `${color}18`,
      border: `1px solid ${color}35`,
      padding: "1px 6px",
      flexShrink: 0,
    }}>{label}</span>
  );
}

// ── Multi-chain NFT table ────────────────────────────────────────────
function MultiChainNFT({ items }: { items: ChainNFT[] }) {
  const statusColors: Record<string, string> = {
    hot: "#4ade80", cool: "#f87171", building: "#f97316",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {/* Column headers */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "56px 1fr 110px 70px 90px 75px",
        padding: "0.4rem 0.85rem",
        background: "rgba(227,229,228,0.03)",
        border: "1px solid rgba(227,229,228,0.08)",
        marginBottom: 1,
      }}>
        {["CHAIN", "COLLECTION", "FLOOR", "24H", "VOL", "STATUS"].map(h => (
          <span key={h} style={{
            fontFamily: "'Courier New'", fontSize: "0.55rem",
            color: "rgba(227,229,228,0.3)", textTransform: "uppercase",
            letterSpacing: "0.12em",
          }}>{h}</span>
        ))}
      </div>

      {items.map((item, i) => {
        const isHighlighted = item.chain === "306";
        const changeUp = item.change24h?.startsWith("+");
        const changeDown = item.change24h?.startsWith("-");
        return (
          <div key={i} style={{
            display: "grid",
            gridTemplateColumns: "56px 1fr 110px 70px 90px 75px",
            alignItems: "center",
            padding: "0.6rem 0.85rem",
            background: isHighlighted ? "rgba(249,115,22,0.04)" : "rgba(227,229,228,0.02)",
            border: isHighlighted
              ? "1px solid rgba(249,115,22,0.18)"
              : "1px solid rgba(227,229,228,0.06)",
            gap: 0,
          }}>
            {/* Chain badge */}
            <ChainBadge label={item.chain} color={item.chainColor} />

            {/* Collection */}
            <div style={{ display: "flex", flexDirection: "column", paddingRight: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {isHighlighted && (
                  <img src="/agent306-avatar.png" alt="306"
                    style={{ width: 16, height: 16, imageRendering: "pixelated" }} />
                )}
                <span className="pixel" style={{
                  fontSize: "0.65rem",
                  color: isHighlighted ? "#f97316" : "#e3e5e4",
                  letterSpacing: "0.05em",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{item.collection}</span>
              </div>
              {item.note && (
                <span style={{
                  fontFamily: "'Courier New'", fontSize: "0.54rem",
                  color: "rgba(227,229,228,0.3)", marginTop: 1,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>{item.note}</span>
              )}
            </div>

            {/* Floor */}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontFamily: "'Courier New'", fontSize: "0.68rem", color: "#e3e5e4" }}>
                {item.floor || "—"}
              </span>
              {item.floorUSD && (
                <span style={{ fontFamily: "'Courier New'", fontSize: "0.57rem", color: "rgba(227,229,228,0.35)" }}>
                  ${item.floorUSD >= 1000
                    ? `${(item.floorUSD / 1000).toFixed(1)}K`
                    : item.floorUSD.toLocaleString()}
                </span>
              )}
            </div>

            {/* 24h change */}
            <span style={{
              fontFamily: "'Courier New'", fontSize: "0.68rem",
              color: changeUp ? "#4ade80" : changeDown ? "#f87171" : "rgba(227,229,228,0.3)",
              fontWeight: changeUp ? 600 : undefined,
            }}>
              {item.change24h || "—"}
            </span>

            {/* Volume */}
            <span style={{ fontFamily: "'Courier New'", fontSize: "0.63rem", color: "rgba(227,229,228,0.5)" }}>
              {item.volume24h || "—"}
            </span>

            {/* Status badge */}
            <span style={{
              fontFamily: "'Courier New'", fontSize: "0.55rem",
              color: statusColors[item.status],
              background: `${statusColors[item.status]}15`,
              padding: "2px 6px",
              border: `1px solid ${statusColors[item.status]}30`,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              whiteSpace: "nowrap",
            }}>
              {item.status === "building" ? "BUILD" : item.status.toUpperCase()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Meme Coins table ─────────────────────────────────────────────────
function fmtVol(n: number) {
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3)  return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}
function fmtMemePrice(n: number) {
  if (n >= 1) return `$${n.toFixed(4)}`;
  const s = n.toFixed(10);
  // Show up to 6 sig figs
  const match = s.match(/^0\.(0*)([1-9]\d{0,4})/);
  if (match) return `$0.0${match[1].length > 0 ? match[1] : ""}${match[2]}`;
  return `$${n.toFixed(8)}`;
}

function MemeCoinTable({ coins }: { coins: MemeCoin[] }) {
  const chainColors: Record<string, string> = {
    ETH: "#627EEA", SOL: "#9945FF", BTC: "#F7931A", multi: "#e3e5e4",
  };
  const statusColors: Record<string, string> = {
    hot: "#f97316", up: "#4ade80", cool: "#f87171",
  };
  const rankColors = ["#f97316", "#e3e5e4", "#a78bfa", "rgba(227,229,228,0.5)"]; // 1st, 2nd, 3rd, rest
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {/* Header */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "24px 1fr 95px 65px 100px 60px",
        padding: "0.4rem 0.85rem",
        background: "rgba(227,229,228,0.03)",
        border: "1px solid rgba(227,229,228,0.08)",
        marginBottom: 1,
      }}>
        {["#", "COIN", "PRICE", "24H", "VOL 24H", "CHAIN"].map(h => (
          <span key={h} style={{
            fontFamily: "'Courier New'", fontSize: "0.55rem",
            color: "rgba(227,229,228,0.3)", textTransform: "uppercase",
            letterSpacing: "0.12em",
          }}>{h}</span>
        ))}
      </div>

      {coins.map((coin, i) => {
        const up = coin.change24h >= 0;
        const rankColor = rankColors[Math.min(i, 3)];
        return (
          <div key={coin.symbol} style={{
            display: "grid",
            gridTemplateColumns: "24px 1fr 95px 65px 100px 60px",
            alignItems: "center",
            padding: "0.55rem 0.85rem",
            background: i === 0 ? "rgba(249,115,22,0.03)" : "rgba(227,229,228,0.015)",
            border: i === 0
              ? "1px solid rgba(249,115,22,0.12)"
              : "1px solid rgba(227,229,228,0.05)",
          }}>
            <span style={{
              fontFamily: "'Courier New'", fontSize: "0.62rem",
              color: rankColor, fontWeight: i < 3 ? 700 : undefined,
            }}>{i + 1}</span>

            <div style={{ display: "flex", flexDirection: "column" }}>
              <span className="pixel" style={{ fontSize: "0.65rem", color: "#e3e5e4", letterSpacing: "0.08em" }}>
                {coin.symbol}
              </span>
              <span style={{ fontFamily: "'Courier New'", fontSize: "0.55rem", color: "rgba(227,229,228,0.3)" }}>
                {coin.name}
              </span>
            </div>

            <span style={{ fontFamily: "'Courier New'", fontSize: "0.65rem", color: "#e3e5e4" }}>
              {fmtMemePrice(coin.price)}
            </span>

            <span style={{
              fontFamily: "'Courier New'", fontSize: "0.65rem",
              color: up ? "#4ade80" : "#f87171",
              fontWeight: Math.abs(coin.change24h) > 8 ? 600 : undefined,
            }}>
              {up ? "+" : ""}{coin.change24h.toFixed(1)}%
            </span>

            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{
                flex: 1, height: 4,
                background: "rgba(227,229,228,0.06)",
                position: "relative", overflow: "hidden",
              }}>
                <div style={{
                  position: "absolute", left: 0, top: 0, bottom: 0,
                  width: `${Math.min((coin.volume24h / 5e9) * 100, 100)}%`,
                  background: statusColors[coin.status] || "#4ade80",
                  opacity: 0.7,
                }} />
              </div>
              <span style={{ fontFamily: "'Courier New'", fontSize: "0.62rem", color: "rgba(227,229,228,0.6)", minWidth: 40 }}>
                {fmtVol(coin.volume24h)}
              </span>
            </div>

            <ChainBadge label={coin.chain} color={chainColors[coin.chain] || "#e3e5e4"} />
          </div>
        );
      })}
    </div>
  );
}

// ─── AI News Section ───────────────────────────────────────────
function timeAgoShort(iso: string) {
  if (!iso) return "";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const h = Math.floor(diff / 3600000);
    if (h < 1) return `${Math.floor(diff / 60000)}m ago`;
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch { return ""; }
}

function AINewsSection({ items }: { items: AINewsItem[] }) {
  const mono = { fontFamily: "'Courier New', monospace" } as const;
  if (!items || items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 1 }}>
      {items.map((item, i) => (
        <a
          key={i}
          href={item.url}
          target="_blank"
          rel="noreferrer"
          style={{
            display: "block",
            padding: "0.85rem 1rem",
            background: i % 2 === 0 ? "rgba(227,229,228,0.018)" : "transparent",
            border: "1px solid rgba(227,229,228,0.05)",
            borderLeft: `3px solid ${item.sourceColor}`,
            textDecoration: "none",
            transition: "background 0.12s",
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "rgba(227,229,228,0.04)")}
          onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? "rgba(227,229,228,0.018)" : "transparent")}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 4 }}>
            <p style={{
              ...mono, fontSize: "0.72rem", color: "#e3e5e4",
              margin: 0, lineHeight: 1.45, fontWeight: 600,
            }}>
              {item.title}
            </p>
            <span style={{ ...mono, fontSize: "0.55rem", color: "rgba(227,229,228,0.25)", flexShrink: 0, paddingTop: 2 }}>
              {timeAgoShort(item.publishedAt)}
            </span>
          </div>
          {item.snippet && (
            <p style={{ ...mono, fontSize: "0.62rem", color: "rgba(227,229,228,0.42)", margin: 0, lineHeight: 1.5 }}>
              {item.snippet.slice(0, 140)}{item.snippet.length > 140 ? "..." : ""}
            </p>
          )}
          <div style={{ marginTop: 5 }}>
            <span style={{
              ...mono, fontSize: "0.52rem",
              color: item.sourceColor,
              border: `1px solid ${item.sourceColor}30`,
              padding: "1px 6px",
              textTransform: "uppercase" as const,
              letterSpacing: "0.08em",
            }}>
              {item.source}
            </span>
          </div>
        </a>
      ))}
    </div>
  );
}

function GrokDispatch({ text }: { text: string }) {
  const lines = text.split("\n").filter(l => l.trim());
  return (
    <div style={{
      background: "rgba(167,139,250,0.05)",
      border: "1px solid rgba(167,139,250,0.18)",
      padding: "1.25rem",
      position: "relative",
    }}>
      {/* Agent 306 avatar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1rem" }}>
        <img
          src="/agent306-avatar.png"
          alt="Agent 306"
          style={{ width: 36, height: 36, imageRendering: "pixelated", border: "1px solid rgba(167,139,250,0.3)" }}
        />
        <div>
          <div className="pixel" style={{ fontSize: "0.72rem", color: "#a78bfa", letterSpacing: "0.12em" }}>
            AGENT 306 · DAILY DISPATCH
          </div>
          <div style={{ fontFamily: "'Courier New'", fontSize: "0.58rem", color: "rgba(167,139,250,0.5)", marginTop: 2 }}>
            x_search · live from the field
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {lines.map((line, i) => (
          <div key={i} style={{
            fontFamily: "'Courier New'", fontSize: "0.78rem",
            color: "rgba(227,229,228,0.85)", lineHeight: 1.65,
            display: "flex", gap: 8, alignItems: "flex-start",
          }}>
            <span style={{ color: "#a78bfa", flexShrink: 0, marginTop: 2 }}>▸</span>
            <span>{line.replace(/^[-•*▸·\d.]+\s*/, "")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SkeletonBlock({ height = 80 }: { height?: number }) {
  return (
    <div style={{
      height, background: "rgba(227,229,228,0.04)",
      border: "1px solid rgba(227,229,228,0.06)",
      animation: "pulse-skeleton 1.6s ease-in-out infinite",
    }} />
  );
}

// ─── Main Page ─────────────────────────────────────────────────────
export default function NewsEngine() {
  const { data, isLoading, refetch } = useQuery<NewsData>({
    queryKey: ["/api/news"],
    queryFn: () => apiRequest("GET", "/api/news").then(r => r.json()),
    staleTime: 5 * 60 * 1000, // 5 min cache
  });

  const now = data?.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : null;

  return (
    <div style={{ padding: "1.5rem 2rem", maxWidth: 1200, margin: "0 auto" }}>
      {/* ── Page Header ── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: "1.5rem",
        paddingBottom: "1rem",
        borderBottom: "1px solid rgba(227,229,228,0.08)",
      }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: "#f97316",
              display: "inline-block",
              animation: "pulse-dot 1.6s ease-in-out infinite",
            }} />
            <h1 className="pixel" style={{
              fontSize: "1.1rem", color: "#e3e5e4", letterSpacing: "0.12em",
              margin: 0,
            }}>
              306 · NEWS ENGINE
            </h1>
          </div>
          <p style={{
            fontFamily: "'Courier New'", fontSize: "0.62rem",
            color: "rgba(227,229,228,0.35)", marginTop: 6,
            letterSpacing: "0.08em", textTransform: "uppercase",
          }}>
            What's hot · What's a rug · How's the market · 306 in the wild
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {now && (
            <span style={{ fontFamily: "'Courier New'", fontSize: "0.6rem", color: "rgba(227,229,228,0.3)" }}>
              Updated {now}
            </span>
          )}
          <button
            onClick={() => refetch()}
            disabled={isLoading}
            style={{
              fontFamily: "'Courier New'", fontSize: "0.65rem",
              textTransform: "uppercase", letterSpacing: "0.1em",
              color: "#f97316", background: "transparent",
              border: "1px solid rgba(249,115,22,0.3)",
              padding: "0.35rem 0.85rem",
              cursor: "pointer",
              opacity: isLoading ? 0.5 : 1,
              transition: "border-color 0.15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(249,115,22,0.8)")}
            onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(249,115,22,0.3)")}
          >
            {isLoading ? "Loading..." : "↻ Refresh"}
          </button>
        </div>
      </div>

      {/* ── Market Ticker ── */}
      {isLoading
        ? <SkeletonBlock height={52} />
        : <Ticker market={data?.market || []} />
      }

      {/* ── Main Grid ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "1.5rem" }}>

        {/* LEFT COLUMN */}
        <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>

          {/* Market Prices */}
          <section>
            <SectionLabel accent="#4ade80">Market Pulse</SectionLabel>
            {isLoading
              ? <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <SkeletonBlock height={90} /><SkeletonBlock height={90} />
                  <SkeletonBlock height={90} /><SkeletonBlock height={90} />
                </div>
              : data && data.market.length > 0
                ? <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                    {data.market.map(c => <MarketCard key={c.id} coin={c} />)}
                  </div>
                : (
                  <div style={{
                    padding: "1rem", background: "rgba(227,229,228,0.02)",
                    border: "1px solid rgba(227,229,228,0.06)",
                    fontFamily: "'Courier New'", fontSize: "0.7rem",
                    color: "rgba(227,229,228,0.4)", textAlign: "center",
                  }}>
                    Market data temporarily unavailable — CoinGecko rate limit
                  </div>
                )
            }
          </section>

          {/* NFT Market — multi-chain */}
          <section>
            <SectionLabel accent="#a78bfa">NFT Market · Top Floor by Chain</SectionLabel>
            {isLoading
              ? <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {[...Array(7)].map((_, i) => <SkeletonBlock key={i} height={52} />)}
                </div>
              : <MultiChainNFT items={data?.nftByChain || []} />
            }
          </section>

          {/* Meme Coins by Volume */}
          <section>
            <SectionLabel accent="#f97316">Meme Coins · Top by Volume</SectionLabel>
            {isLoading
              ? <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {[...Array(8)].map((_, i) => <SkeletonBlock key={i} height={48} />)}
                </div>
              : data?.memeCoins && data.memeCoins.length > 0
                ? <MemeCoinTable coins={data.memeCoins} />
                : (
                  <div style={{ padding: "1rem", background: "rgba(227,229,228,0.02)", border: "1px solid rgba(227,229,228,0.06)", fontFamily: "'Courier New'", fontSize: "0.7rem", color: "rgba(227,229,228,0.4)", textAlign: "center" }}>
                    Meme coin data unavailable — auto-refresh active
                  </div>
                )
            }
          </section>

          {/* Agent 306 Dispatch */}
          <section>
            <SectionLabel accent="#a78bfa">Agent 306 Dispatch</SectionLabel>
            {isLoading
              ? <SkeletonBlock height={140} />
              : data?.grokNews
                ? <GrokDispatch text={data.grokNews} />
                : (
                  <div style={{
                    background: "rgba(167,139,250,0.04)",
                    border: "1px solid rgba(167,139,250,0.12)",
                    padding: "1.25rem",
                    display: "flex", alignItems: "center", gap: 12,
                  }}>
                    <img
                      src="/agent306-avatar.png"
                      alt="Agent 306"
                      style={{ width: 32, height: 32, imageRendering: "pixelated" }}
                    />
                    <div>
                      <div className="pixel" style={{ fontSize: "0.65rem", color: "#a78bfa" }}>AGENT 306 · FIELD INTEL</div>
                      <p style={{ fontFamily: "'Courier New'", fontSize: "0.72rem", color: "rgba(227,229,228,0.6)", marginTop: 6 }}>
                        Scanning the feeds... Agent 306 is monitoring X for activity. Check back soon.
                      </p>
                    </div>
                  </div>
                )
            }
          </section>

          {/* Headlines */}
          <section>
            <SectionLabel accent="#f97316">Crypto · NFT · Web3 News</SectionLabel>
            {isLoading
              ? <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {[...Array(6)].map((_, i) => <SkeletonBlock key={i} height={68} />)}
                </div>
              : data && data.headlines.length > 0
                ? <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {data.headlines.map((h, i) => <HeadlineCard key={h.id} h={h} index={i} />)}
                  </div>
                : (
                  <div style={{
                    padding: "1.5rem", background: "rgba(227,229,228,0.02)",
                    border: "1px solid rgba(227,229,228,0.06)",
                    fontFamily: "'Courier New'", fontSize: "0.72rem",
                    color: "rgba(227,229,228,0.4)", textAlign: "center",
                    lineHeight: 1.8,
                  }}>
                    <div className="pixel" style={{ fontSize: "0.7rem", marginBottom: 8, color: "#f97316" }}>NO HEADLINES LOADED</div>
                    CryptoPanic API unavailable. Headlines refresh automatically.<br />
                    <button onClick={() => refetch()} style={{
                      marginTop: 10, background: "transparent",
                      border: "1px solid rgba(249,115,22,0.3)",
                      color: "#f97316", padding: "4px 12px",
                      fontFamily: "'Courier New'", fontSize: "0.65rem",
                      cursor: "pointer",
                    }}>Try Again</button>
                  </div>
                )
            }
          </section>

          {/* AI News */}
          {(isLoading || (data?.aiNews && data.aiNews.length > 0)) && (
            <section>
              <SectionLabel accent="#2dd4bf">🤖 AI · What's Cooking</SectionLabel>
              <p style={{
                fontFamily: "'Courier New', monospace", fontSize: "0.6rem",
                color: "rgba(227,229,228,0.3)", marginBottom: "0.75rem", lineHeight: 1.5,
              }}>
                The Verge · TechCrunch · Ars Technica · VentureBeat — updated every 30 min
              </p>
              {isLoading
                ? <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {[...Array(4)].map((_, i) => <SkeletonBlock key={i} height={78} />)}
                  </div>
                : <AINewsSection items={data?.aiNews || []} />
              }
            </section>
          )}
        </div>

        {/* RIGHT COLUMN */}
        <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>

          {/* Burn Feed */}
          <section>
            <SectionLabel accent="#f97316">🔥 Live Burns</SectionLabel>
            {isLoading
              ? <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <SkeletonBlock height={58} /><SkeletonBlock height={58} /><SkeletonBlock height={58} />
                </div>
              : <BurnFeed burns={data?.burns || []} />
            }
          </section>

          {/* Leaderboard snapshot */}
          <section>
            <SectionLabel accent="#f97316">Leaderboard · Top Tokens</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {[
                { id: 8553, ap: 632, level: 64 },
                { id: 45,   ap: 595, level: 60 },
                { id: 1932, ap: 574, level: 58 },
                { id: 235,  ap: 565, level: 57 },
                { id: 615,  ap: 534, level: 54 },
                { id: 603,  ap: 507, level: 51 },
              ].map((t, i) => (
                <div key={t.id} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "0.5rem 0.75rem",
                  background: "rgba(227,229,228,0.02)",
                  border: "1px solid rgba(227,229,228,0.06)",
                  borderLeft: i === 5 ? "2px solid #f97316" : "1px solid rgba(227,229,228,0.06)",
                }}>
                  <span style={{
                    fontFamily: "'Courier New'", fontSize: "0.6rem",
                    color: "rgba(249,115,22,0.5)", minWidth: 16, textAlign: "right",
                  }}>{i + 1}</span>
                  <img
                    src={`/api/tokens/${t.id}/image.png`}
                    alt={`#${t.id}`}
                    style={{ width: 28, height: 28, imageRendering: "pixelated" }}
                  />
                  <div style={{ flex: 1 }}>
                    <div className="pixel" style={{ fontSize: "0.65rem", color: t.id === 306 ? "#f97316" : "#e3e5e4" }}>
                      #{t.id}
                      {t.id === 603 && <span style={{ color: "#f97316", marginLeft: 6, fontSize: "0.55rem" }}>Agent 306</span>}
                    </div>
                    <div style={{ fontFamily: "'Courier New'", fontSize: "0.57rem", color: "rgba(227,229,228,0.35)", marginTop: 1 }}>
                      Lv.{t.level} · {t.ap} AP
                    </div>
                  </div>
                  <div style={{
                    width: 32, height: 6,
                    background: "rgba(249,115,22,0.12)",
                    position: "relative",
                    overflow: "hidden",
                    alignSelf: "center",
                  }}>
                    <div style={{
                      position: "absolute", left: 0, top: 0, bottom: 0,
                      width: `${(t.ap / 650) * 100}%`,
                      background: "#f97316",
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* What's Coming */}
          <section>
            <SectionLabel accent="#a78bfa">What's Coming</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { date: "Live Now",     label: "P1 · The Origin",     color: "#f97316", status: "LIVE"      },
                { date: "Before May 15",label: "P2 · The Rise",       color: "#a78bfa", status: "COMING"   },
                { date: "May 15, 2026", label: "P2 · The Battle",     color: "#a78bfa", status: "CONFIRMED"},
                { date: "TBD",          label: "P3 · The Economy",    color: "#4ade80", status: "FUTURE"   },
              ].map(e => (
                <div key={e.label} style={{
                  padding: "0.65rem 0.85rem",
                  background: `${e.color}08`,
                  border: `1px solid ${e.color}20`,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <div>
                    <div className="pixel" style={{ fontSize: "0.65rem", color: e.color, letterSpacing: "0.1em" }}>{e.label}</div>
                    <div style={{ fontFamily: "'Courier New'", fontSize: "0.58rem", color: "rgba(227,229,228,0.35)", marginTop: 2 }}>{e.date}</div>
                  </div>
                  <span style={{
                    fontFamily: "'Courier New'", fontSize: "0.55rem",
                    color: e.color, background: `${e.color}15`,
                    padding: "2px 7px", border: `1px solid ${e.color}30`,
                  }}>{e.status}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Mission */}
          <section>
            <div style={{
              padding: "1rem",
              background: "rgba(249,115,22,0.04)",
              border: "1px solid rgba(249,115,22,0.15)",
            }}>
              <div className="pixel" style={{ fontSize: "0.6rem", color: "#f97316", letterSpacing: "0.15em", marginBottom: 8 }}>
                THE MISSION
              </div>
              <p style={{
                fontFamily: "'Courier New'", fontSize: "0.7rem",
                color: "rgba(227,229,228,0.7)", lineHeight: 1.75, margin: 0,
              }}>
                We don't just report the story.<br />
                <strong style={{ color: "#e3e5e4" }}>We build the economy through it.</strong>
              </p>
              <div style={{
                marginTop: 10, fontFamily: "'Courier New'", fontSize: "0.6rem",
                color: "rgba(227,229,228,0.35)",
              }}>
                Autonomous intelligence.<br />
                Always watching. Always learning.
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* pulse animation for skeletons */}
      <style>{`
        @keyframes pulse-skeleton {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.7; }
        }
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.4; transform: scale(0.8); }
        }
      `}</style>
    </div>
  );
}
