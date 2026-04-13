import { useState } from "react";
import DataIntake from "./DataIntake";
import KnowledgeGraph from "./KnowledgeGraph";

const mono = { fontFamily: "'Courier New', monospace" } as const;

type Tab = "intake" | "knowledge";

const tabs: { key: Tab; label: string }[] = [
  { key: "intake",    label: "\uD83D\uDCE5 Sources & Intake" },
  { key: "knowledge", label: "\uD83E\uDDEC Knowledge Graph" },
];

export default function Intelligence() {
  const [tab, setTab] = useState<Tab>("intake");

  return (
    <div style={{ padding: "1.5rem 2rem", maxWidth: 1200 }}>
      <div style={{ marginBottom: "1.25rem" }}>
        <h1 style={{ ...mono, fontSize: "1.35rem", color: "#efefef", textTransform: "uppercase", letterSpacing: "0.08em", margin: 0 }}>
          Intelligence
        </h1>
        <p style={{ ...mono, fontSize: "0.8rem", color: "rgba(227,229,228,0.5)", marginTop: "0.3rem" }}>
          AI source feeds &middot; Knowledge clusters &middot; Contradictions
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

      {tab === "intake" ? <DataIntake /> : <KnowledgeGraph />}
    </div>
  );
}
