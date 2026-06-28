import { API_URL } from "./config";
import type { JoinResponse, IceServer } from "./types";

interface RawJoin {
  token: string;
  livekitHost: string;
  iceServers?: { urls: string[]; username?: string; credential?: string }[];
  room: string;
  identity: string;
}

/** Request a join token + TURN credentials from the Go backend. */
export async function join(room: string, identity: string, name: string): Promise<JoinResponse> {
  const res = await fetch(`${API_URL}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room, identity, name }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`join failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as RawJoin;

  const iceServers: IceServer[] | undefined = data.iceServers?.map((s) => ({
    urls: s.urls,
    username: s.username,
    credential: s.credential,
  }));

  return { ...data, iceServers };
}

/** Tell the backend a participant left (best-effort, for history). */
export function reportLeave(room: string, identity: string): void {
  fetch(`${API_URL}/api/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room, identity }),
    keepalive: true,
  }).catch(() => {
    /* best-effort */
  });
}
