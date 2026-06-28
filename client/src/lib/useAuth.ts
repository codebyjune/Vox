import { useCallback, useEffect, useState } from "react";
import type { Store } from "@tauri-apps/plugin-store";
import type { User } from "../types";
import * as api from "../api";

// Persisted in the Tauri plugin-store (production) or localStorage (browser dev).
// The token is opaque and server-revocable; on app launch we validate it via
// /api/me, so a stale/expired token auto-clears.
const STORE_FILE = "session.json";
const STORE_KEY = "token";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let storePromise: Promise<Store | null> | null = null;
function loadStore(): Promise<Store | null> {
  if (!isTauri) return Promise.resolve(null);
  if (!storePromise) {
    storePromise = (async () => {
      const { load } = await import("@tauri-apps/plugin-store");
      return load(STORE_FILE, { autoSave: false, defaults: {} });
    })();
  }
  return storePromise;
}

async function readToken(): Promise<string | null> {
  if (isTauri) {
    const store = await loadStore();
    return (await store?.get<string>(STORE_KEY)) ?? null;
  }
  return localStorage.getItem(STORE_KEY);
}

async function writeToken(t: string | null): Promise<void> {
  if (isTauri) {
    const store = await loadStore();
    if (t) await store?.set(STORE_KEY, t);
    else await store?.delete(STORE_KEY);
    await store?.save();
  } else if (t) {
    localStorage.setItem(STORE_KEY, t);
  } else {
    localStorage.removeItem(STORE_KEY);
  }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true); // restoring session on launch
  const [error, setError] = useState<string | null>(null);

  // On mount: restore the stored token and validate it. If valid, we're logged
  // in for up to 30 days without re-entering credentials.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await readToken();
      if (!token) {
        if (!cancelled) setLoading(false);
        return;
      }
      api.setSessionToken(token);
      try {
        const u = await api.me();
        if (!cancelled) setUser(u);
      } catch {
        // token invalid/expired — drop it
        api.setSessionToken(null);
        await writeToken(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    setError(null);
    try {
      const r = await api.register(username, password);
      api.setSessionToken(r.token);
      await writeToken(r.token);
      setUser(r.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setError(null);
    try {
      const r = await api.login(username, password);
      api.setSessionToken(r.token);
      await writeToken(r.token);
      setUser(r.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    api.setSessionToken(null);
    await writeToken(null);
    setUser(null);
  }, []);

  return { user, loading, error, register, login, logout };
}
