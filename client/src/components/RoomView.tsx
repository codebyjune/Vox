import { useState } from "react";
import type { VoiceRoom } from "../lib/useVoiceRoom";
import type { DenoiseSettings } from "../types";
import { ParticipantTile } from "./ParticipantTile";
import { DenoiseControl } from "./DenoiseControl";

interface Props {
  roomName: string;
  voice: VoiceRoom;
  settings: DenoiseSettings;
  onSetting: (patch: Partial<DenoiseSettings>) => void;
  onStrength: (v: number) => void;
}

export function RoomView({ roomName, voice, settings, onSetting, onStrength }: Props) {
  const [showDenoise, setShowDenoise] = useState(false);
  const count = voice.participants.length;

  return (
    <div className="room">
      <header className="room__bar">
        <div className="room__title">
          <span className="room__name">#{roomName}</span>
          <span className="room__count">{count} in call</span>
        </div>
        <div className={["live", voice.connected ? "live--on" : "live--off"].join(" ")}>
          <span className="dot" /> {voice.connected ? "connected" : "…"}
        </div>
      </header>

      {voice.error && <div className="error error--inline">{voice.error}</div>}
      {voice.workletFallback && (
        <div className="warning">
          Smart denoise worklet failed to load — mic is unprocessed. Check the
          worklet file is included in the build.
        </div>
      )}

      <main className="room__grid">
        {voice.participants.map((p) => (
          <ParticipantTile key={p.sid || p.identity} p={p} />
        ))}
      </main>

      {showDenoise && (
        <div className="room__panel">
          <DenoiseControl
            settings={settings}
            inCall={true}
            onSetting={onSetting}
            onStrength={onStrength}
          />
        </div>
      )}

      <footer className="room__controls">
        <button
          className={["ctrl", voice.isMuted ? "ctrl--muted" : "ctrl--live"].join(" ")}
          onClick={voice.toggleMute}
          title={voice.isMuted ? "Unmute" : "Mute"}
        >
          {voice.isMuted ? "🔇" : "🎙️"}
          <span>{voice.isMuted ? "Unmute" : "Mute"}</span>
        </button>

        <button
          className={["ctrl", showDenoise ? "ctrl--live" : ""].join(" ")}
          onClick={() => setShowDenoise((s) => !s)}
          title="Noise reduction"
        >
          ✨ <span>Noise</span>
        </button>

        <button className="ctrl ctrl--leave" onClick={() => void voice.leave()} title="Leave call">
          📵 <span>Leave</span>
        </button>
      </footer>
    </div>
  );
}
