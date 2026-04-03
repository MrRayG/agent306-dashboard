import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

// ── Types ──────────────────────────────────────────────────────────────────────
interface ChatMessage {
  id:        string;
  role:      "user" | "agent";
  text:      string;
  timestamp: string;
  mood?:     "thinking" | "direct" | "questioning" | "reporting";
  needsHelp?: boolean;  // Agent flagged she needs guidance
}

interface ChatState {
  messages:    ChatMessage[];
  lastActive:  string | null;
  totalTurns:  number;
}

const mono = { fontFamily: "'Courier New', monospace" } as const;

// ── Mood indicator ─────────────────────────────────────────────────────────────
function MoodDot({ mood }: { mood?: ChatMessage["mood"] }) {
  const colors: Record<string, string> = {
    thinking:    "#a78bfa",
    direct:      "#f97316",
    questioning: "#2dd4bf",
    reporting:   "#4ade80",
  };
  const labels: Record<string, string> = {
    thinking:    "thinking",
    direct:      "direct",
    questioning: "asks you",
    reporting:   "reporting",
  };
  if (!mood) return null;
  return (
    <span style={{
      ...mono, fontSize: "0.68rem", color: colors[mood] ?? "#e3e5e4",
      border: `1px solid ${colors[mood]}30`,
      padding: "1px 6px", textTransform: "uppercase" as const,
      letterSpacing: "0.1em", flexShrink: 0,
    }}>
      {labels[mood]}
    </span>
  );
}

// ── Message bubble ─────────────────────────────────────────────────────────────
function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isAgent = msg.role === "agent";
  const time = new Date(msg.timestamp).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
  });

  return (
    <div style={{
      display: "flex",
      flexDirection: isAgent ? "row" : "row-reverse",
      gap: 10,
      marginBottom: "1rem",
      alignItems: "flex-start",
    }}>
      {/* Avatar */}
      {isAgent && (
        <img
          src="/agent306-avatar.png"
          alt="#306"
          style={{ width: 28, height: 28, imageRendering: "pixelated", borderRadius: 2, flexShrink: 0, marginTop: 2 }}
        />
      )}

      <div style={{ maxWidth: "75%", display: "flex", flexDirection: "column" as const, gap: 4,
        alignItems: isAgent ? "flex-start" : "flex-end" }}>

        {/* Name + mood */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ ...mono, fontSize: "0.73rem", color: isAgent ? "#f97316" : "rgba(227,229,228,0.60)",
            textTransform: "uppercase" as const, letterSpacing: "0.1em" }}>
            {isAgent ? "Agent 306" : "MrRayG"}
          </span>
          {isAgent && <MoodDot mood={msg.mood} />}
          <span style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.35)" }}>{time}</span>
        </div>

        {/* Bubble */}
        <div style={{
          padding: "0.85rem 1rem",
          background: isAgent
            ? "rgba(249,115,22,0.04)"
            : "rgba(227,229,228,0.12)",
          border: `1px solid ${isAgent
            ? msg.needsHelp ? "rgba(251,191,36,0.4)" : "rgba(249,115,22,0.15)"
            : "rgba(227,229,228,0.18)"}`,
          borderLeft: isAgent ? `3px solid ${msg.needsHelp ? "#fbbf24" : "#f97316"}` : "none",
          borderRight: !isAgent ? "3px solid rgba(227,229,228,0.48)" : "none",
        }}>
          {msg.needsHelp && (
            <div style={{ ...mono, fontSize: "0.70rem", color: "#fbbf24", textTransform: "uppercase" as const,
              letterSpacing: "0.12em", marginBottom: 6 }}>
              ⚠ Agent needs your guidance
            </div>
          )}
          <p style={{ ...mono, fontSize: "0.93rem", color: "rgba(227,229,228,0.88)",
            lineHeight: 1.75, margin: 0, whiteSpace: "pre-wrap" as const }}>
            {msg.text}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Typing indicator ───────────────────────────────────────────────────────────
function TypingIndicator() {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: "1rem" }}>
      <img src="/agent306-avatar.png" alt="#306"
        style={{ width: 28, height: 28, imageRendering: "pixelated", borderRadius: 2, flexShrink: 0 }} />
      <div style={{ padding: "0.75rem 1rem", background: "rgba(249,115,22,0.04)",
        border: "1px solid rgba(249,115,22,0.12)", borderLeft: "3px solid rgba(249,115,22,0.4)",
        display: "flex", alignItems: "center", gap: 6 }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ width: 5, height: 5, borderRadius: "50%", background: "#f97316",
            animation: `chat-bounce 1.2s ease-in-out ${i * 0.2}s infinite` }} />
        ))}
        <span style={{ ...mono, fontSize: "0.78rem", color: "rgba(249,115,22,0.5)", marginLeft: 4 }}>
          Agent 306 is thinking...
        </span>
      </div>
    </div>
  );
}

// ── Quick prompt chips ─────────────────────────────────────────────────────────
const QUICK_PROMPTS = [
  "What are you working on right now?",
  "What do you need from me to grow the media operation?",
  "Give me your honest take on where we stand",
  "What's the most important thing you've learned this week?",
  "What should we post about today?",
  "What gaps in your knowledge do you need filled?",
  "What's the most interesting thing happening in AI right now?",
  "How should we evolve the content strategy?",
];

// ── Main ───────────────────────────────────────────────────────────────────────
export default function CommandChat() {
  const [input, setInput]     = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId]           = useState(() => `session_${Date.now()}`);
  const bottomRef             = useRef<HTMLDivElement>(null);
  const inputRef              = useRef<HTMLTextAreaElement>(null);

  // Load chat history
  const { data: chatState } = useQuery<ChatState>({
    queryKey: ["/api/chat/history"],
    refetchInterval: false,
    onSuccess: (data) => {
      if (data?.messages?.length && messages.length === 0) {
        setMessages(data.messages.slice(-40)); // load last 40
      }
    },
  } as any);

  // Send message
  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      const r = await apiRequest("POST", "/api/chat/send", { text, sessionId });
      return r.json();
    },
    onSuccess: (data: { reply: ChatMessage }) => {
      setMessages(prev => [...prev, data.reply]);
    },
  });

  function send(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || sendMutation.isPending) return;

    const userMsg: ChatMessage = {
      id:        `user_${Date.now()}`,
      role:      "user",
      text:      msg,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    sendMutation.mutate(msg);
  }

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sendMutation.isPending]);

  // Welcome message on first load
  useEffect(() => {
    if (messages.length === 0 && !chatState?.messages?.length) {
      setMessages([{
        id: "welcome",
        role: "agent",
        text: `MrRayG. Good to connect.\n\nThis is your direct line to me. Ask me anything — what I'm researching, what I think about the latest in AI, where I see things heading, what I need from you.\n\nI won't filter it. I'm built to have a point of view. Use it.\n\nWhat do you want to know?`,
        timestamp: new Date().toISOString(),
        mood: "direct",
      }]);
    }
  }, []);

  const isEmpty = messages.length <= 1;

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, height: "calc(100vh - 0px)", maxWidth: 800, margin: "0 auto" }}>

      {/* Header */}
      <div style={{
        padding: "1.25rem 1.5rem",
        borderBottom: "1px solid rgba(227,229,228,0.15)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img src="/agent306-avatar.png" alt="#306"
            style={{ width: 32, height: 32, imageRendering: "pixelated", borderRadius: 2 }} />
          <div>
            <p style={{ ...mono, fontSize: "0.93rem", color: "#f97316", margin: 0, fontWeight: 700 }}>
              Agent 306
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 1 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#4ade80",
                animation: "chat-pulse 2s infinite" }} />
              <span style={{ ...mono, fontSize: "0.73rem", color: "rgba(74,222,128,0.7)",
                textTransform: "uppercase" as const, letterSpacing: "0.1em" }}>
                Online · @agent3zero6
              </span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {[
            { label: "33 Knowledge", color: "rgba(167,139,250,0.5)" },
            { label: "Direct Line", color: "rgba(249,115,22,0.5)" },
          ].map(tag => (
            <span key={tag.label} style={{ ...mono, fontSize: "0.68rem", color: tag.color,
              border: `1px solid ${tag.color}50`, padding: "2px 8px",
              textTransform: "uppercase" as const, letterSpacing: "0.1em" }}>
              {tag.label}
            </span>
          ))}
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "1.5rem" }}>

        {/* Quick prompts — shown when chat is empty */}
        {isEmpty && (
          <div style={{ marginBottom: "1.5rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.40)",
              textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.75rem" }}>
              Quick prompts
            </p>
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
              {QUICK_PROMPTS.map(q => (
                <button key={q} onClick={() => send(q)} style={{
                  ...mono, fontSize: "0.78rem", background: "rgba(227,229,228,0.06)",
                  border: "1px solid rgba(227,229,228,0.18)", color: "rgba(227,229,228,0.68)",
                  padding: "5px 10px", cursor: "pointer", textAlign: "left" as const,
                  transition: "all 0.15s",
                }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLElement).style.borderColor = "rgba(249,115,22,0.3)";
                    (e.currentTarget as HTMLElement).style.color = "#e3e5e4";
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.borderColor = "rgba(227,229,228,0.18)";
                    (e.currentTarget as HTMLElement).style.color = "rgba(227,229,228,0.68)";
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
        {sendMutation.isPending && <TypingIndicator />}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: "1rem 1.5rem",
        borderTop: "1px solid rgba(227,229,228,0.15)",
        background: "#0e0f10",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            rows={2}
            placeholder="Talk to Agent 306 directly... (Enter to send, Shift+Enter for new line)"
            style={{
              flex: 1,
              background: "rgba(227,229,228,0.08)",
              border: "1px solid rgba(227,229,228,0.18)",
              color: "#efefef",
              ...mono, fontSize: "0.90rem",
              lineHeight: 1.6, padding: "0.65rem 0.85rem",
              resize: "none", outline: "none", borderRadius: 0,
              transition: "border-color 0.15s",
            }}
            onFocus={e => (e.target.style.borderColor = "rgba(249,115,22,0.3)")}
            onBlur={e => (e.target.style.borderColor = "rgba(227,229,228,0.18)")}
          />
          <button
            onClick={() => send()}
            disabled={!input.trim() || sendMutation.isPending}
            style={{
              background: !input.trim() || sendMutation.isPending ? "rgba(249,115,22,0.12)" : "#f97316",
              color: !input.trim() || sendMutation.isPending ? "rgba(249,115,22,0.35)" : "#1a1b1c",
              border: "none", ...mono, fontSize: "0.83rem", fontWeight: 700,
              padding: "0.65rem 1.25rem",
              cursor: !input.trim() || sendMutation.isPending ? "not-allowed" : "pointer",
              textTransform: "uppercase" as const, letterSpacing: "0.08em",
              alignSelf: "stretch", flexShrink: 0,
            }}
          >
            {sendMutation.isPending ? "..." : "Send →"}
          </button>
        </div>
        <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.35)", marginTop: 6 }}>
          Agent 306 has access to full knowledge base · 33 entries · Responds with her genuine POV
        </p>
      </div>

      <style>{`
        @keyframes chat-bounce {
          0%, 80%, 100% { transform: scale(0); opacity: 0.3; }
          40% { transform: scale(1); opacity: 1; }
        }
        @keyframes chat-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
