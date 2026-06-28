import type { DenoiseMode, DenoiseSettings } from "../types";

interface Props {
  settings: DenoiseSettings;
  inCall: boolean;
  onSetting: (patch: Partial<DenoiseSettings>) => void;
  onStrength: (v: number) => void;
}

const MODES: { id: DenoiseMode; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Raw mic, no processing" },
  { id: "basic", label: "Basic", hint: "Browser noise suppression + AEC" },
  { id: "smart", label: "Smart", hint: "AI/worklet denoise (best quality)" },
];

const MODELS = [
  { id: "", label: "Built-in DSP" },
  { id: "rnnoise", label: "RNNoise (WASM)" },
  { id: "dtln", label: "DTLN-rs (WASM)" },
  { id: "deepfilter", label: "DeepFilterNet (WASM)" },
];

export function DenoiseControl({ settings, inCall, onSetting, onStrength }: Props) {
  return (
    <div className="denoise">
      <div className="denoise__title">
        Noise Reduction
        {inCall && <span className="badge">live</span>}
      </div>

      <div className="segmented" role="radiogroup" aria-label="Denoise mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="radio"
            aria-checked={settings.mode === m.id}
            className={settings.mode === m.id ? "seg seg--active" : "seg"}
            title={m.hint}
            onClick={() => onSetting({ mode: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>

      {settings.mode === "smart" && (
        <>
          <label className="field">
            <span>Strength</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.strength}
              onChange={(e) => onStrength(parseFloat(e.target.value))}
            />
            <span className="val">{Math.round(settings.strength * 100)}%</span>
          </label>

          <label className="field field--select">
            <span>Engine</span>
            <select
              value={settings.model ?? ""}
              onChange={(e) => onSetting({ model: e.target.value || null })}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      <div className="toggles">
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.echoCancellation}
            onChange={(e) => onSetting({ echoCancellation: e.target.checked })}
          />
          <span>Acoustic echo cancellation</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.agc}
            onChange={(e) => onSetting({ agc: e.target.checked })}
          />
          <span>Auto gain control</span>
        </label>
      </div>

      <p className="denoise__note">
        Smart mode runs on the audio thread (Web Audio Worklet). AI models are
        loaded from <code>public/wasm/</code> — see the WASM README to enable.
      </p>
    </div>
  );
}
