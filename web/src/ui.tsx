// Small pieces the module screens share.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";

export function Mic({ size = 26 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0014 0M12 18v3" />
    </svg>
  );
}

export function ScreenHead({ title, eyebrow, onBack, right }: { title: string; eyebrow?: string; onBack: () => void; right?: ReactNode }) {
  return (
    <div className="screen-head">
      <button className="btn ghost back" onClick={onBack}>‹ Deck</button>
      <div className="screen-title">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
      </div>
      <div className="screen-right">{right}</div>
    </div>
  );
}

/**
 * Talk, and get the words back as text. Live recording where the browser allows it (HTTPS),
 * otherwise the device's own recorder through a file picker.
 */
export function useDictation(stt: boolean, onText: (text: string) => void, onError: (m: string) => void) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!recording) return;
    setSeconds(0);
    const t = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const hear = async (audio: Blob, name?: string) => {
    setBusy(true);
    try {
      const { text } = await api.transcribe(audio, name);
      if (text) onText(text);
      else onError("Didn't catch anything. Try again a little closer to the mic.");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (recording) return recorder.current?.stop();
    if (!stt) return onError("Voice needs the speech-to-text service, which isn't set up. Type for now.");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
      return fileInput.current?.click();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const type = rec.mimeType || "audio/webm";
        hear(new Blob(chunks, { type }), /mp4|aac/.test(type) ? "note.m4a" : /ogg/.test(type) ? "note.ogg" : "note.webm");
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      onError("Microphone access was blocked. Allow it for this site in the browser's settings.");
    }
  };

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const input = (
    <input
      ref={fileInput}
      className="sr"
      type="file"
      accept="audio/*"
      capture
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) hear(f, f.name);
      }}
    />
  );
  return { recording, busy, clock, toggle, input };
}

export function MicButton({ d, small }: { d: ReturnType<typeof useDictation>; small?: boolean }) {
  return (
    <>
      {d.input}
      <button type="button" className={`mic${d.recording ? " on" : ""}${small ? " small" : ""}`} aria-label={d.recording ? `Stop (${d.clock})` : "Talk"} aria-pressed={d.recording} onClick={d.toggle} disabled={d.busy}>
        <Mic size={small ? 20 : 26} />
      </button>
    </>
  );
}

export const money = (n: number, currency = "CAD") =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }).format(n);
