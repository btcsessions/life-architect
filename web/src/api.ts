export interface Task {
  id: number;
  area_id: string;
  title: string;
  note: string | null;
  importance: number;
  due: string | null;
  minutes: number | null;
  status: "open" | "done";
  delegate: string | null;
  snoozed_until: string | null;
  needs_you?: boolean;
  area_name?: string;
}
export interface AreaView { id: string; name: string; locked: boolean; need: number; items: Task[] }
export interface NextItem { id: number; area_id: string; title: string; locked: boolean; why: string[] }
export interface Deck { today: string; next: NextItem[]; areas: AreaView[]; addedToday: number }
export interface Config { model: string | null; stt: boolean }
export interface Settings {
  llm_url: string; llm_model: string; llm_key_set: boolean;
  stt_url: string; stt_model: string; stt_key_set: boolean;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("Can't reach the Umbrel. Check that Tailscale is on.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Something went wrong (${res.status}).`);
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

export const api = {
  deck: () => call<Deck>("/api/deck"),
  config: () => call<Config>("/api/config"),
  capture: (text: string) => call<{ via: string; created: Task[] }>("/api/capture", json("POST", { text })),
  patch: (id: number, body: Record<string, unknown>) => call<Task>(`/api/tasks/${id}`, json("PATCH", body)),
  remove: (id: number) => call<{ ok: true }>(`/api/tasks/${id}`, { method: "DELETE" }),
  settings: () => call<Settings>("/api/settings"),
  saveSettings: (body: Record<string, string>) => call<Settings>("/api/settings", json("PUT", body)),
  models: (body: Record<string, string>) =>
    call<{ ok: boolean; models: string[]; message: string }>("/api/settings/models", json("POST", body)),
  testModel: () => call<{ ok: boolean; message: string }>("/api/settings/test", { method: "POST" }),
  transcribe: (audio: Blob, name = "note.webm") => {
    const form = new FormData();
    form.set("audio", audio, name);
    return call<{ text: string }>("/api/transcribe", { method: "POST", body: form });
  },
};

export function dueLabel(due: string, today: string): string {
  const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const days = Math.round((d(due) - d(today)) / 86_400_000);
  if (days < -1) return `${-days} days overdue`;
  if (days === -1) return "Due yesterday";
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days < 7) return "Due " + new Date(d(due)).toLocaleDateString("en", { weekday: "long", timeZone: "UTC" });
  return "Due " + new Date(d(due)).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}
