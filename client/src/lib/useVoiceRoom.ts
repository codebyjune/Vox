import { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteAudioTrack,
} from "livekit-client";
import { MicPipeline } from "./denoise";
import { reportLeave } from "../api";
import type { DenoiseSettings, JoinResponse } from "../types";

export interface ParticipantState {
  sid: string;
  identity: string;
  isLocal: boolean;
  isSpeaking: boolean;
  muted: boolean;
}

export interface VoiceRoom {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  participants: ParticipantState[];
  isMuted: boolean;
  identity: string | null;
  /** True when smart mode was selected but the worklet failed to load. */
  workletFallback: boolean;
  join: (res: JoinResponse, settings: DenoiseSettings) => Promise<void>;
  toggleMute: () => void;
  applyDenoise: (settings: DenoiseSettings) => Promise<void>;
  setLiveStrength: (v: number) => void;
  leave: () => Promise<void>;
}

export function useVoiceRoom(): VoiceRoom {
  const roomRef = useRef<Room | null>(null);
  const pipelineRef = useRef<MicPipeline | null>(null);
  const localPubRef = useRef<LocalTrackPublication | null>(null);
  const remoteAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const settingsRef = useRef<DenoiseSettings | null>(null);
  // Mirror of React state for handlers that were bound once (room.on() at join
  // time) and therefore see stale closure values. Always read via .current.
  const isMutedRef = useRef(false);

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMutedState] = useState(false);
  const setIsMuted = useCallback((v: boolean) => {
    isMutedRef.current = v;
    setIsMutedState(v);
  }, []);
  const [identity, setIdentity] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ParticipantState[]>([]);
  const [workletFallback, setWorkletFallback] = useState(false);

  const refreshParticipants = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const active = new Set(room.activeSpeakers.map((p) => p.sid));
    const list: ParticipantState[] = [];
    const local = room.localParticipant;
    list.push({
      sid: local.sid,
      identity: local.identity,
      isLocal: true,
      isSpeaking: active.has(local.sid),
      // Mirror the latest isMuted ref so the UI doesn't flicker between
      // toggles (setMicrophoneEnabled's effect on isMicrophoneEnabled is async).
      muted: isMutedRef.current,
    });
    room.remoteParticipants.forEach((p) => {
      list.push({
        sid: p.sid,
        identity: p.identity,
        isLocal: false,
        isSpeaking: active.has(p.sid),
        muted: !p.isMicrophoneEnabled,
      });
    });
    setParticipants(list);
  }, []);

  const attachRemoteAudio = useCallback((track: RemoteAudioTrack, sid: string) => {
    let el = remoteAudioRef.current.get(sid);
    if (!el) {
      el = new Audio();
      el.autoplay = true;
      remoteAudioRef.current.set(sid, el);
    }
    track.attach(el);
  }, []);

  const join = useCallback(
    async (res: JoinResponse, settings: DenoiseSettings) => {
      setConnecting(true);
      setError(null);
      try {
        const room = new Room({
          adaptiveStream: false,
          dynacast: false,
        });
        roomRef.current = room;
        settingsRef.current = settings;
        setIdentity(res.identity);

        room.on(RoomEvent.ParticipantConnected, refreshParticipants);
        room.on(RoomEvent.ParticipantDisconnected, refreshParticipants);
        room.on(RoomEvent.ActiveSpeakersChanged, refreshParticipants);
        room.on(RoomEvent.TrackMuted, refreshParticipants);
        room.on(RoomEvent.TrackUnmuted, refreshParticipants);
        room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
          if (track.kind === Track.Kind.Audio) {
            attachRemoteAudio(track as RemoteAudioTrack, participant.sid);
          }
          refreshParticipants();
        });
        room.on(RoomEvent.Disconnected, () => {
          setConnected(false);
          refreshParticipants();
        });

        await room.connect(res.livekitHost, res.token, {
          rtcConfig: res.iceServers && res.iceServers.length ? { iceServers: res.iceServers } : undefined,
        });

        // Build the denoise pipeline and publish the processed mic.
        const pipeline = new MicPipeline(settings);
        pipelineRef.current = pipeline;
        const micTrack = await pipeline.getMicTrack();
        const pub = await room.localParticipant.publishTrack(micTrack, {
          source: Track.Source.Microphone,
          name: "mic",
        });
        localPubRef.current = pub;
        setWorkletFallback(pipeline.workletFallback);

        setConnected(true);
        refreshParticipants();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setConnected(false);
        // Tear down any partially-initialized pipeline so the next attempt
        // doesn't leak a dangling AudioContext or media stream.
        pipelineRef.current?.stop();
        pipelineRef.current = null;
        localPubRef.current = null;
      } finally {
        setConnecting(false);
      }
    },
    [attachRemoteAudio, refreshParticipants],
  );

  const toggleMute = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const cur = room.localParticipant.isMicrophoneEnabled; // current enabled state
    void room.localParticipant
      .setMicrophoneEnabled(!cur)
      .then(() => {
        setIsMuted(cur); // we just toggled it off -> muted == previous enabled
        refreshParticipants();
      });
  }, [refreshParticipants, setIsMuted]);

  // Serialize mid-call rebuilds so rapid mode toggles don't race.
  const rebuildingRef = useRef<Promise<void>>(Promise.resolve());

  // Rebuild pipeline + republish when denoise settings change mid-call.
  const applyDenoise = useCallback(
    (settings: DenoiseSettings) => {
      const job = (async () => {
        // Chain after any in-flight rebuild.
        await rebuildingRef.current;
        const room = roomRef.current;
        if (!room || !connected) {
          settingsRef.current = settings;
          return;
        }
        settingsRef.current = settings;
        const wasMuted = isMutedRef.current;
        const oldPub = localPubRef.current;
        if (oldPub?.track) {
          await room.localParticipant.unpublishTrack(oldPub.track, false);
          localPubRef.current = null;
        }
        pipelineRef.current?.stop();

        const pipeline = new MicPipeline(settings);
        pipelineRef.current = pipeline;
        const micTrack = await pipeline.getMicTrack();
        const pub = await room.localParticipant.publishTrack(micTrack, {
          source: Track.Source.Microphone,
          name: "mic",
        });
        localPubRef.current = pub;
        setWorkletFallback(pipeline.workletFallback);
        // restore mute state
        if (wasMuted) await room.localParticipant.setMicrophoneEnabled(false);
        refreshParticipants();
      })();
      // Swallow errors here; voice.error is set by join()'s own catch. Avoid
      // leaving the chain broken: this promise is stored so subsequent calls
      // await it.
      rebuildingRef.current = job.catch(() => {});
      return job;
    },
    [connected, refreshParticipants],
  );

  const setLiveStrength = useCallback((v: number) => {
    pipelineRef.current?.setStrength(v);
  }, []);

  const leave = useCallback(async () => {
    const room = roomRef.current;
    const id = identity;
    remoteAudioRef.current.forEach((el) => {
      el.srcObject = null;
      el.remove();
    });
    remoteAudioRef.current.clear();
    pipelineRef.current?.stop();
    pipelineRef.current = null;
    localPubRef.current = null;
    if (room) {
      const roomName = room.name;
      await room.disconnect();
      if (id) reportLeave(roomName, id);
    }
    roomRef.current = null;
    setConnected(false);
    setIsMuted(false);
    setIdentity(null);
    setParticipants([]);
    setWorkletFallback(false);
  }, [identity]);

  useEffect(() => {
    return () => {
      remoteAudioRef.current.forEach((el) => {
        el.srcObject = null;
      });
      void roomRef.current?.disconnect();
      pipelineRef.current?.stop();
    };
  }, []);

  return {
    connected,
    connecting,
    error,
    participants,
    isMuted,
    identity,
    workletFallback,
    join,
    toggleMute,
    applyDenoise,
    setLiveStrength,
    leave,
  };
}
