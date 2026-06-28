import { useState } from "react";
import { useSettings } from "./lib/useSettings";
import { useVoiceRoom } from "./lib/useVoiceRoom";
import { Lobby } from "./components/Lobby";
import { RoomView } from "./components/RoomView";
import type { DenoiseSettings, JoinResponse } from "./types";

export default function App() {
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

  if (!voice.connected && !voice.connecting) {
    return (
      <Lobby
        settings={settings}
        onSetting={handleSetting}
        onStrength={handleStrength}
        onJoined={onJoined}
        joinError={voice.error}
      />
    );
  }

  return (
    <RoomView
      roomName={roomName}
      voice={voice}
      settings={settings}
      onSetting={handleSetting}
      onStrength={handleStrength}
    />
  );
}
