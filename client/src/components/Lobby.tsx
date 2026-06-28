import { useState } from "react";
import { join as apiJoin } from "../api";
import type { DenoiseSettings, JoinResponse } from "../types";
import { DenoiseControl } from "./DenoiseControl";

interface Props {
  settings: DenoiseSettings;
  onSetting: (patch: Partial<DenoiseSettings>) => void;
  onStrength: (v: number) => void;
  onJoined: (res: JoinResponse, settings: DenoiseSettings) => void;
  /** Error from the room connect step (token already obtained). */
  joinError?: string | null;
}

export function Lobby({ settings, onSetting, onStrength, onJoined, joinError }: Props) {
  const [name, setName] = useState("");
  const [room, setRoom] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canJoin = name.trim().length > 0 && room.trim().length > 0 && !busy;

  async function handleJoin() {
    setErr(null);
    setBusy(true);
    try {
      const res = await apiJoin(room.trim(), name.trim(), name.trim());
      onJoined(res, settings);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lobby">
      <div className="lobby__card">
        <h1 className="brand">VoiceApp</h1>
        <p className="tagline">High-quality group voice — 3 to 5 people, AI noise removal.</p>

        <form
          className="lobby__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canJoin) void handleJoin();
          }}
        >
          <label className="field">
            <span>Your name</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (err) setErr(null);
              }}
              placeholder="e.g. june"
              maxLength={32}
              autoFocus
            />
          </label>
          <label className="field">
            <span>Room</span>
            <input
              value={room}
              onChange={(e) => {
                setRoom(e.target.value);
                if (err) setErr(null);
              }}
              placeholder="e.g. team-standup"
              maxLength={32}
            />
          </label>

          {err && <div className="error">{err}</div>}
          {!err && joinError && <div className="error">{joinError}</div>}

          <button type="submit" className="btn btn--primary" disabled={!canJoin}>
            {busy ? "Connecting…" : "Join call"}
          </button>
        </form>

        <div className="lobby__denoise">
          <DenoiseControl settings={settings} inCall={false} onSetting={onSetting} onStrength={onStrength} />
        </div>
      </div>
    </div>
  );
}
