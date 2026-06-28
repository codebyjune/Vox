import { useCallback, useEffect, useState } from "react";
import type { Store } from "@tauri-apps/plugin-store";
import { DEFAULT_SETTINGS, type DenoiseSettings } from "../types";

// Persisted in the Tauri plugin-store (production) or localStorage (browser dev).
const STORE_FILE = "settings.json";
const STORE_KEY = "denoise";

// Detect whether we are running inside Tauri (plugin-store available).
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Reuse the Store instance: opening the file on every persist() leaks file
// handles and races on autoSave. Cache the load promise module-wide.
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

export function useSettings() {
  const [settings, setSettings] = useState<DenoiseSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (isTauri) {
          const store = await loadStore();
          const saved = await store?.get<DenoiseSettings>(STORE_KEY);
          if (!cancelled && saved) setSettings({ ...DEFAULT_SETTINGS, ...saved });
        } else {
          const raw = localStorage.getItem(STORE_KEY);
          if (raw && !cancelled) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
        }
      } catch (e) {
        console.warn("settings load failed", e);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next: DenoiseSettings) => {
    try {
      if (isTauri) {
        const store = await loadStore();
        await store?.set(STORE_KEY, next);
        await store?.save();
      } else {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      }
    } catch (e) {
      console.warn("settings save failed", e);
    }
  }, []);

  const update = useCallback(
    (patch: Partial<DenoiseSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  return { settings, update, loaded };
}

