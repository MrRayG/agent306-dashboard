import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const mono  = { fontFamily: "'Courier New', monospace" } as const;
const pixel = { fontFamily: "'Courier New', monospace", textTransform: "uppercase" as const, letterSpacing: "0.15em" } as const;
const card  = { background: "rgba(227,229,228,0.05)", border: "1px solid rgba(227,229,228,0.15)", padding: "1.25rem 1.5rem" } as const;

interface VoiceClip {
  id: string; text: string; audioUrl: string;
  createdAt: string; characters: number; source: string;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function AudioPlayer({ url, id }: { url: string; id: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const toggle = () => {
    if (!audioRef.current) return;
    if (playing) { audioRef.current.pause(); setPlaying(false); }
    else { audioRef.current.play(); setPlaying(true); }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <audio
        ref={audioRef}
        src={url}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        onTimeUpdate={() => {
          if (audioRef.current && audioRef.current.duration) {
            setProgress(audioRef.current.currentTime / audioRef.current.duration);
          }
        }}
      />
      <button
        onClick={toggle}
        style={{
          width: 32, height: 32, borderRadius: "50%",
          background: playing ? "rgba(249,115,22,0.15)" : "#f97316",
          border: `1px solid ${playing ? "rgba(249,115,22,0.4)" : "#f97316"}`,
          color: playing ? "#f97316" : "#1a1b1c",
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "15px", flexShrink: 0,
        }}
      >
        {playing ? "⏸" : "▶"}
      </button>
      <div style={{ flex: 1, height: 3, background: "rgba(227,229,228,0.15)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${progress * 100}%`, background: "#f97316", transition: "width 0.1s linear" }} />
      </div>
      <a
        href={url}
        download={`agent306-${id}.mp3`}
        style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.48)", textDecoration: "none" }}
      >
        ↓ mp3
      </a>
    </div>
  );
}

export default function VoiceStudio() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [lastClip, setLastClip] = useState<VoiceClip | null>(null);

  const { data: quota } = useQuery<any>({
    queryKey: ["/api/voice/quota"],
  });

  const { data: recentData } = useQuery<{ clips: VoiceClip[] }>({
    queryKey: ["/api/voice/recent"],
  });

  const generateMutation = useMutation({
    mutationFn: (inputText: string) =>
      apiRequest("POST", "/api/voice/generate", { text: inputText, source: "manual" }).then(r => r.json()),
    onSuccess: (data: any) => {
      setLastClip(data.clip);
      setText("");
      qc.invalidateQueries({ queryKey: ["/api/voice/recent"] });
      qc.invalidateQueries({ queryKey: ["/api/voice/quota"] });
    },
    onError: (err: any) => {
      toast({ title: "Voice generation failed", description: err.message, variant: "destructive" });
    },
  });

  const quotaPct = quota ? Math.round((quota.used / quota.limit) * 100) : 0;
  const remaining = quota ? (quota.limit - quota.used) : 10000;

  return (
    <div style={{ maxWidth: 780, margin: "0 auto", padding: "2rem 1.5rem", display: "flex", flexDirection: "column", gap: "1.75rem" }}>

      {/* Header */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <img src="/agent306-avatar.png" alt="Agent 306"
            style={{ width: 36, height: 36, imageRendering: "pixelated", border: "1px solid rgba(249,115,22,0.3)" }} />
          <div>
            <h1 style={{ ...pixel, fontSize: "1.03rem", color: "#f97316", margin: 0 }}>VOICE STUDIO</h1>
            <p style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.55)", margin: 0 }}>Agent 306 · Matilda Voice · ElevenLabs</p>
          </div>
        </div>
        <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.45)", lineHeight: 1.6, margin: 0 }}>
          Type anything — a burn narration, a dispatch, a spotlight. Agent 306 speaks it.
        </p>
      </div>

      {/* Quota bar */}
      {quota && (
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.60)", textTransform: "uppercase", letterSpacing: "0.12em" }}>
              Monthly Usage · {quota.tier} plan
            </span>
            <span style={{ ...mono, fontSize: "0.83rem", color: quotaPct > 80 ? "#f87171" : "#4ade80" }}>
              {quota.used.toLocaleString()} / {quota.limit.toLocaleString()} chars
            </span>
          </div>
          <div style={{ height: 4, background: "rgba(227,229,228,0.12)", borderRadius: 2 }}>
            <div style={{
              height: "100%", width: `${Math.min(quotaPct, 100)}%`,
              background: quotaPct > 80 ? "#f87171" : "#4ade80",
              borderRadius: 2, transition: "width 0.3s ease",
            }} />
          </div>
          <p style={{ ...mono, fontSize: "0.74rem", color: "rgba(227,229,228,0.40)", marginTop: 6, marginBottom: 0 }}>
            ~{Math.floor(remaining / 180)} narrations remaining this month
          </p>
        </div>
      )}

      {/* Generate */}
      <div style={{ ...card, borderColor: "rgba(249,115,22,0.15)" }}>
        <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(249,115,22,0.6)", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: "0.85rem" }}>
          Generate Voice Clip
        </p>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={5}
          placeholder={`#3284 burned at 2am. No tweet. No announcement. Just a transaction.\n\nI've been watching this wallet for three weeks. Something is being built.`}
          style={{
            width: "100%", background: "rgba(227,229,228,0.06)",
            border: "1px solid rgba(227,229,228,0.18)", color: "#efefef",
            ...mono, fontSize: "0.93rem", lineHeight: 1.7,
            padding: "0.85rem", resize: "vertical", outline: "none",
            boxSizing: "border-box" as const, marginBottom: "0.85rem",
          }}
        />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.40)" }}>
            {text.length} chars · ~{Math.ceil(text.length / 5)} seconds of audio
          </span>
          <button
            onClick={() => text.trim() && generateMutation.mutate(text.trim())}
            disabled={!text.trim() || generateMutation.isPending}
            style={{
              background: !text.trim() || generateMutation.isPending ? "rgba(249,115,22,0.12)" : "#f97316",
              color: !text.trim() || generateMutation.isPending ? "rgba(249,115,22,0.4)" : "#1a1b1c",
              border: "none", ...mono, fontSize: "0.68rem", fontWeight: 700,
              padding: "0.6rem 1.25rem", cursor: generateMutation.isPending ? "not-allowed" : "pointer",
              textTransform: "uppercase" as const, letterSpacing: "0.08em",
            }}
          >
            {generateMutation.isPending ? "Speaking..." : "Speak →"}
          </button>
        </div>

        {/* Loading state */}
        {generateMutation.isPending && (
          <div style={{ marginTop: "0.85rem", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex", gap: 3 }}>
              {[0,1,2].map(i => (
                <div key={i} style={{
                  width: 4, height: 4, borderRadius: "50%", background: "#f97316",
                  animation: "voice-pulse 0.8s infinite",
                  animationDelay: `${i * 0.15}s`,
                }} />
              ))}
            </div>
            <span style={{ ...mono, fontSize: "0.63rem", color: "rgba(249,115,22,0.6)" }}>
              Agent 306 is speaking...
            </span>
          </div>
        )}
      </div>

      {/* Latest clip */}
      {lastClip && (
        <div style={{ ...card, borderColor: "rgba(74,222,128,0.2)", background: "rgba(74,222,128,0.02)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.85rem" }}>
            <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(74,222,128,0.6)", textTransform: "uppercase", letterSpacing: "0.15em", margin: 0 }}>
              Latest · Just now
            </p>
            <span style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.40)" }}>
              {lastClip.characters} chars
            </span>
          </div>
          <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.75)", lineHeight: 1.6, marginBottom: "0.85rem" }}>
            {lastClip.text.slice(0, 180)}{lastClip.text.length > 180 ? "..." : ""}
          </p>
          <AudioPlayer url={lastClip.audioUrl} id={lastClip.id} />
        </div>
      )}

      {/* Recent clips */}
      {recentData && recentData.clips.length > 0 && (
        <div style={card}>
          <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.55)", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: "1rem" }}>
            Recent Clips
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {recentData.clips.map((clip) => (
              <div key={clip.id} style={{ paddingBottom: "0.85rem", borderBottom: "1px solid rgba(227,229,228,0.10)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ ...mono, fontSize: "0.74rem", color: "rgba(249,115,22,0.5)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    {clip.source}
                  </span>
                  <span style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.40)" }}>
                    {timeAgo(clip.createdAt)}
                  </span>
                </div>
                <p style={{ ...mono, fontSize: "0.67rem", color: "rgba(227,229,228,0.68)", lineHeight: 1.5, marginBottom: 8 }}>
                  {clip.text.slice(0, 120)}{clip.text.length > 120 ? "..." : ""}
                </p>
                <AudioPlayer url={clip.audioUrl} id={clip.id} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {(!recentData || recentData.clips.length === 0) && !lastClip && !generateMutation.isPending && (
        <div style={{ ...card, textAlign: "center", padding: "2rem", borderColor: "rgba(249,115,22,0.1)" }}>
          <img src="/agent306-avatar.png" alt="Agent 306"
            style={{ width: 48, height: 48, imageRendering: "pixelated", margin: "0 auto 1rem", border: "1px solid rgba(249,115,22,0.2)" }} />
          <p style={{ ...mono, fontSize: "0.88rem", color: "#f97316", marginBottom: 6 }}>Agent 306 is ready to speak.</p>
          <p style={{ ...mono, fontSize: "0.80rem", color: "rgba(227,229,228,0.48)", lineHeight: 1.6 }}>
            Type any narration above. Burns. Rankings. Dispatches.<br />
            She'll speak it in her voice. You hear it before it posts.
          </p>
        </div>
      )}

      <style>{`
        @keyframes voice-pulse { 0%,100%{opacity:0.3;transform:scale(0.7)}50%{opacity:1;transform:scale(1)} }
        textarea:focus { border-color: rgba(249,115,22,0.3) !important; }
      `}</style>
    </div>
  );
}
