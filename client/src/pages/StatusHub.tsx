import { useState } from "react";
import MorningBriefing from "./MorningBriefing";
import AgentStatus from "./AgentStatus";

const mono = { fontFamily: "'Courier New', monospace" } as const;

type Tab = "brief" | "agent";

const tabs: { key: Tab; label: string }[] = [
  { key: "brief", label: "\uD83D\uDCCB Daily Brief" },
  { key: "agent", label: "\uD83D\uDCCA Agent Status" },
];

export default function StatusHub() {
  const [tab, setTab] = useState<Tab>("brief");

  return (
    <div style={{ padding: "1.5rem 2rem", maxWidth: 1200 }}>
      <div style={{ marginBottom: "1.25rem" }}>
        <h1 style={{ ...mono, fontSize: "1.35rem", color: "#efefef", textTransform: "uppercase", letterSpacing: "0.08em", margin: 0 }}>
          Status
        </h1>
        <p style={{ ...mono, fontSize: "0.8rem", color: "rgba(227,229,228,0.5)", marginTop: "0.3rem" }}>
          Daily intelligence briefing &middot; Agent vitals &middot; Evolution &middot; Exploration
        </p>
      </div>

      <div style={{ display: "flex", borderBottom: "1px solid rgba(227,229,228,0.15)", marginBottom: "1.5rem" }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            ...mono, fontSize: "0.80rem", textTransform: "uppercase", letterSpacing: "0.12em",
            background: "transparent", border: "none",
            borderBottom: tab === t.key ? "2px solid #f97316" : "2px solid transparent",
            color: tab === t.key ? "#f97316" : "rgba(227,229,228,0.55)",
            padding: "0.6rem 1.25rem", cursor: "pointer", marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === "brief" ? <MorningBriefing /> : <AgentStatus />}
    </div>
  );
}
