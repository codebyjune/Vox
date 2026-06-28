import { useState } from "react";
import { join as apiJoin } from "../api";
import type { DenoiseSettings, JoinResponse, User } from "../types";
import { DenoiseControl } from "./DenoiseControl";

interface Props {
  user: User;
  settings: DenoiseSettings;
  onSetting: (patch: Partial<DenoiseSettings>) => void;
  onStrength: (v: number) => void;
  onJoined: (res: JoinResponse, settings: DenoiseSettings) => void;
  onLogout: () => void;
  /** Error from the room connect step (token already obtained). */
  joinError?: string | null;
}

export function Lobby({ user, settings, onSetting, onStrength, onJoined, onLogout, joinError }: Props) {
  const [room, setRoom] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canJoin = room.trim().length > 0 && !busy;

  async function handleJoin() {
    setErr(null);
    setBusy(true);
    try {
      // identity comes from the logged-in session, not this form.
      const res = await apiJoin(room.trim());
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
        <div className="lobby__userrow">
          <div>
            <h1 className="brand" style={{ margin: 0 }}>Vox</h1>
            <p className="tagline" style={{ margin: "4px 0 0" }}>
              Signed in as <strong>{user.username}</strong>
            </p>
          </div>
          <button className="btn btn--ghost" onClick={onLogout}>Sign out</button>
        </div>

        <form
          className="lobby__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canJoin) void handleJoin();
          }}
        >
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
              autoFocus
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
