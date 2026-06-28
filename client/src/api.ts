import { API_URL } from "./config";
import type { AuthResult, IceServer, JoinResponse, User } from "./types";

// Module-level session token. Set by useAuth after login/register/restore;
// every authenticated request (me/join/leave/logout) sends it as a Bearer.
let sessionToken: string | null = null;
export function setSessionToken(t: string | null): void {
  sessionToken = t;
}

function authHeaders(): Record<string, string> {
  return sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => res.statusText);
  try {
    const j = JSON.parse(text);
    return j.error || text || res.statusText;
  } catch {
    return text || res.statusText;
  }
}

// ---------- auth ----------

export async function register(username: string, password: string): Promise<AuthResult> {
  const res = await fetch(`${API_URL}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AuthResult;
}

export async function login(username: string, password: string): Promise<AuthResult> {
  const res = await fetch(`${API_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AuthResult;
}

/** Validate the stored session token by asking the backend who we are. */
export async function me(): Promise<User> {
  const res = await fetch(`${API_URL}/api/me`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as User;
}

export async function logout(): Promise<void> {
  await fetch(`${API_URL}/api/logout`, {
    method: "POST",
    headers: authHeaders(),
    keepalive: true,
  }).catch(() => {});
}

// ---------- rooms ----------

/** Request a LiveKit join token for the authenticated user. */
export async function join(room: string): Promise<JoinResponse> {
  const res = await fetch(`${API_URL}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ room }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as {
    token: string;
    livekitHost: string;
    iceServers?: { urls: string[]; username?: string; credential?: string }[];
    room: string;
    identity: string;
  };
  const iceServers: IceServer[] | undefined = data.iceServers?.map((s) => ({
    urls: s.urls,
    username: s.username,
    credential: s.credential,
  }));
  return { ...data, iceServers };
}

/** Tell the backend the participant left (best-effort, for history). */
export function reportLeave(room: string): void {
  fetch(`${API_URL}/api/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ room }),
    keepalive: true,
  }).catch(() => {
    /* best-effort */
  });
}
