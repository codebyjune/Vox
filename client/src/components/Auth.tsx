import { useState } from "react";

interface Props {
  onLogin: (username: string, password: string) => Promise<void>;
  onRegister: (username: string, password: string) => Promise<void>;
  error: string | null;
}

type Mode = "login" | "register";

export function Auth({ onLogin, onRegister, error }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const canSubmit = username.trim().length >= 3 && password.length >= 6 && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      if (mode === "register") await onRegister(username.trim(), password);
      else await onLogin(username.trim(), password);
    } catch {
      /* error surfaced via props */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lobby">
      <div className="lobby__card">
        <h1 className="brand">Vox</h1>
        <p className="tagline">
          {mode === "login" ? "Sign in to join a call" : "Create an account"}
        </p>

        <div className="segmented" role="tablist">
          <button
            role="tab"
            className={mode === "login" ? "seg seg--active" : "seg"}
            onClick={() => setMode("login")}
          >
            Sign in
          </button>
          <button
            role="tab"
            className={mode === "register" ? "seg seg--active" : "seg"}
            onClick={() => setMode("register")}
          >
            Register
          </button>
        </div>

        <form className="lobby__form" onSubmit={submit}>
          <label className="field">
            <span>Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="3-32 chars, a-z 0-9 _ -"
              maxLength={32}
              autoComplete="username"
              autoFocus
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="at least 6 characters"
              maxLength={128}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>

          {error && <div className="error">{error}</div>}

          <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
            {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <p className="denoise__note" style={{ marginTop: 16 }}>
          You stay signed in for 30 days. Your password is stored as a bcrypt hash —
          the server never sees the plaintext.
        </p>
      </div>
    </div>
  );
}
