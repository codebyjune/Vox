import type { ParticipantState } from "../lib/useVoiceRoom";

function initials(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9]/g, "");
  if (!clean) return "?";
  return clean.slice(0, 2).toUpperCase();
}

export function ParticipantTile({ p }: { p: ParticipantState }) {
  return (
    <div className={["tile", p.isSpeaking ? "tile--speaking" : "", p.isLocal ? "tile--local" : ""].join(" ")}>
      <div className="tile__avatar">{initials(p.identity)}</div>
      <div className="tile__name">
        {p.identity}
        {p.isLocal && <span className="tile__you">you</span>}
      </div>
      <div className="tile__status">
        {p.muted ? (
          <span className="icon icon--muted" title="muted">🔇</span>
        ) : p.isSpeaking ? (
          <span className="icon icon--speaking" title="speaking">🎙️</span>
        ) : (
          <span className="icon icon--idle" title="listening">👤</span>
        )}
      </div>
    </div>
  );
}
