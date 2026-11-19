// The PIN screen for a locked module (Money, People). Shows nothing about what's inside.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { call, json } from "./api";

interface Status { set: boolean; open: boolean; idle_minutes: number }
export interface Session {
  /** Like call(), but drops back to the PIN screen if the module has locked itself. */
  call: <T>(path: string, init?: RequestInit) => Promise<T>;
  lock: () => void;
  idleMinutes: number;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

export function LockGate({ name, title, note, onBack, children }: { name: "money" | "people"; title: string; note: string; onBack: () => void; children: (s: Session) => ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [pin, setPin] = useState("");
  const [first, setFirst] = useState<string | null>(null); // when setting a PIN: the first entry, to confirm
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(() => call<Status>(`/api/${name}/status`).then(setStatus).catch((e) => setMsg(e.message)), [name]);
  useEffect(() => { refresh(); }, [refresh]);

  const submit = async (value: string) => {
    if (!status || value.length < 4) return setMsg("A PIN is at least 4 digits.");
    setMsg(null);
    try {
      if (!status.set) {
        if (first === null) { setFirst(value); setPin(""); return; }
        if (first !== value) { setFirst(null); setPin(""); return setMsg("Those didn't match. Start again."); }
        await call(`/api/${name}/pin`, json("POST", { pin: value }));
      } else await call(`/api/${name}/unlock`, json("POST", { pin: value }));
      setPin(""); setFirst(null);
      await refresh();
    } catch (e) {
      setPin("");
      setMsg((e as Error).message);
    }
  };
  const press = (d: string) => { if (d === "⌫") setPin(pin.slice(0, -1)); else if (d && pin.length < 12) setPin(pin + d); };

  if (!status) return <p className="muted">{msg ?? "Loading…"}</p>;

  if (status.open) {
    const session: Session = {
      idleMinutes: status.idle_minutes,
      lock: () => { call(`/api/${name}/lock`, { method: "POST" }).finally(refresh); },
      call: async (path, init) => {
        try { return await call(path, init); }
        catch (e) { if ((e as Error).message === "Locked.") { await refresh(); throw new Error(`${title} locked itself after sitting idle. Enter the PIN to carry on.`); } throw e; }
      },
    };
    return <>{children(session)}</>;
  }

  const prompt = !status.set ? (first === null ? "Choose a PIN (4 to 12 digits)" : "Enter it again to confirm") : "Enter your PIN to open";
  return (
    <div className="lock">
      <button className="btn ghost back" onClick={onBack}>‹ Deck</button>
      <svg aria-hidden="true" width="40" height="40" viewBox="0 0 20 20" fill="none" stroke="#f7931a" strokeWidth="1.4"><path d="M6 9V6.5a4 4 0 018 0V9M5 9h10a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6a1 1 0 011-1z" /></svg>
      <h1>{title}</h1>
      <form onSubmit={(e) => { e.preventDefault(); submit(pin); }}>
        <label htmlFor="pin" className="muted">{prompt}</label>
        <input id="pin" type="password" inputMode="numeric" autoComplete="off" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))} />
        <div className="keypad">
          {DIGITS.map((d, i) => d ? <button key={i} type="button" aria-label={d === "⌫" ? "Delete digit" : d} onClick={() => press(d)}>{d}</button> : <span key={i} />)}
        </div>
        {msg && <p className="accent small" role="alert">{msg}</p>}
        <button className="btn" type="submit" disabled={pin.length < 4}>{status.set ? "Open" : first === null ? "Next" : "Set PIN"}</button>
      </form>
      <p className="muted small note-box">{note}{!status.set && " There is no way to recover a forgotten PIN, so pick one you'll remember."}</p>
    </div>
  );
}
