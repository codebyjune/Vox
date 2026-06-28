import { useState } from "react";
import { useSettings } from "./lib/useSettings";
import { useVoiceRoom } from "./lib/useVoiceRoom";
import { useAuth } from "./lib/useAuth";
import { Auth } from "./components/Auth";
import { Lobby } from "./components/Lobby";
import { RoomView } from "./components/RoomView";
import type { DenoiseSettings, JoinResponse } from "./types";

export default function App() {
  const auth = useAuth();
  const { settings, update } = useSettings();
  const voice = useVoiceRoom();
  const [roomName, setRoomName] = useState("");

  // mode / model / echo / agc changes: persist, and if in a call, rebuild pipeline
  const handleSetting = (patch: Partial<DenoiseSettings>) => {
    const next: DenoiseSettings = { ...settings, ...patch };
    update(patch);
    if (voice.connected) void voice.applyDenoise(next);
  };

  // strength slider: live-adjust the worklet, persist the value
  const handleStrength = (v: number) => {
    update({ strength: v });
    voice.setLiveStrength(v);
  };

  const onJoined = async (res: JoinResponse, s: DenoiseSettings) => {
    setRoomName(res.room);
    await voice.join(res, s);
  };

  // sign out = leave any active room, then clear the session
  const signOut = async () => {
    if (voice.connected) await voice.leave();
    await auth.logout();
  };

  // 1. restoring session on launch
  if (auth.loading) {
    return (
      <div className="lobby">
        <div className="lobby__card">
          <h1 className="brand">Vox</h1>
          <p className="tagline">Restoring session…</p>
        </div>
      </div>
    );
  }

  // 2. not logged in
  if (!auth.user) {
    return <Auth onLogin={auth.login} onRegister={auth.register} error={auth.error} />;
  }

  // 3. logged in, not in a call
  if (!voice.connected && !voice.connecting) {
    return (
      <Lobby
        user={auth.user}
        settings={settings}
        onSetting={handleSetting}
        onStrength={handleStrength}
        onJoined={onJoined}
        onLogout={auth.logout}
        joinError={voice.error}
      />
    );
  }

  // 4. in a call
  return (
    <RoomView
      roomName={roomName}
      voice={voice}
      settings={settings}
      onSetting={handleSetting}
      onStrength={handleStrength}
      onSignOut={signOut}
    />
  );
}
