import { useEffect, useState } from "react";
import { api, call, type Settings } from "./api";

type Msg = { ok: boolean; text: string } | null;

function ModelGroup({ prefix, title, hint, s, form, set, setForm }: {
  prefix: string; title: string; hint: string; s: Settings; form: Record<string, string>;
  set: (k: string) => (e: { target: { value: string } }) => void; setForm: (f: Record<string, string>) => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [typeIt, setTypeIt] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const U = `${prefix}_url`, K = `${prefix}_key`, M = `${prefix}_model`;
  const val = (k: string) => form[k] ?? String(s[k] ?? "");

  const find = async (url: string) => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await api.models({ prefix, url, ...(form[K] ? { key: form[K] } : {}) });
      setModels(r.ok ? r.models : null);
      setTypeIt(false);
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok && r.models.length === 1) setForm({ ...form, [M]: r.models[0] });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { if (s[U]) find(String(s[U])); /* eslint-disable-next-line */ }, []);

  const test = async () => {
    setBusy(true);
    try {
      await api.saveSettings(Object.fromEntries([U, K, M].filter((k) => k in form).map((k) => [k, form[k]])));
      const r = await api.testModel(prefix);
      setMsg({ ok: r.ok, text: r.message });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset>
      <legend className="eyebrow">{title}</legend>
      <p className="muted small">{hint}</p>
      <div className="fields">
        <label htmlFor={U}>Address
          <input id={U} type="url" inputMode="url" placeholder="http://…/v1" value={val(U)} onChange={set(U)} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== s[U]) find(e.target.value); }} />
        </label>
        <label htmlFor={K}>Key, if it needs one
          <input id={K} type="password" autoComplete="off" placeholder={s[`${K}_set`] ? "Saved. Type to replace" : "None saved"} value={form[K] ?? ""} onChange={set(K)} />
        </label>
        <label htmlFor={M}>Model
          {models && !typeIt ? (
            <select id={M} value={val(M)} onChange={set(M)}>
              <option value="">Choose a model…</option>
              {val(M) && !models.includes(val(M)) && <option value={val(M)}>{val(M)}</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input id={M} type="text" autoCapitalize="off" placeholder="Find models, or type the name" value={val(M)} onChange={set(M)} />
          )}
        </label>
      </div>
      <div className="row">
        <button className="btn" type="button" disabled={busy || !val(U).trim()} onClick={() => find(val(U))}>Find models</button>
        <button className="btn" type="button" disabled={busy || !val(U).trim() || !val(M).trim()} onClick={test}>Save and test</button>
        {models && <button className="btn ghost" type="button" onClick={() => setTypeIt(!typeIt)}>{typeIt ? "Pick from the list" : "Type it instead"}</button>}
      </div>
      {msg && <p className={msg.ok ? "small electro" : "small accent"} role="status">{msg.text}</p>}
    </fieldset>
  );
}

export function SettingsPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [relay, setRelay] = useState<{ set: boolean; token?: string } | null>(null);

  useEffect(() => {
    api.settings().then(setS).catch((e) => setMsg({ ok: false, text: (e as Error).message }));
    call<{ set: boolean }>("/api/settings/relay-token").then(setRelay).catch(() => {});
  }, []);

  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setS(await api.saveSettings(form));
      setForm({});
      onSaved();
      setMsg({ ok: true, text: "Saved." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!s) return <section className="card settings"><p className="muted">{msg?.text ?? "Loading settings…"}</p></section>;
  const val = (k: string) => form[k] ?? String(s[k] ?? "");
  const group = { s, form, set, setForm };
  return (
    <section className="card settings" aria-label="Settings">
      <div className="settings-head">
        <h2 className="module-name">Settings</h2>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>

      <ModelGroup prefix="llm" title="Model that files your quick-adds" hint="Any OpenAI-style address, such as Hermes on this Umbrel. Leave empty to file by simple rules." {...group} />
      <ModelGroup prefix="money_llm" title="Model for Money" hint="Used only inside Money, for sorting transactions it can't place. Leave empty and Money sorts by rules alone." {...group} />
      <ModelGroup prefix="people_llm" title="Model for People" hint="Used only inside People, for the chat and readings. People never uses the deck's model. Leave empty and those two features stay off." {...group} />

      <fieldset>
        <legend className="eyebrow">Speech-to-text for the mic</legend>
        <p className="muted small">The Umbrel app comes with its own. Change this only to use a different service.</p>
        <div className="fields">
          <label htmlFor="stt_url">Address
            <input id="stt_url" type="url" inputMode="url" value={val("stt_url")} onChange={set("stt_url")} />
          </label>
          <label htmlFor="stt_model">Model name
            <input id="stt_model" type="text" autoCapitalize="off" placeholder="whisper-1" value={val("stt_model")} onChange={set("stt_model")} />
          </label>
          <label htmlFor="stt_key">Key
            <input id="stt_key" type="password" autoComplete="off" placeholder={s.stt_key_set ? "Saved. Type to replace" : "None saved"} value={form.stt_key ?? ""} onChange={set("stt_key")} />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className="eyebrow">Email (Gmail)</legend>
        <p className="muted small">Use a Gmail app password, not your normal password: Google Account → Security → 2-Step Verification → App passwords.</p>
        <div className="fields">
          <label htmlFor="mail_user">Gmail address
            <input id="mail_user" type="email" autoCapitalize="off" value={val("mail_user")} onChange={set("mail_user")} />
          </label>
          <label htmlFor="mail_password">App password
            <input id="mail_password" type="password" autoComplete="off" placeholder={s.mail_password_set ? "Saved. Type to replace" : "None saved"} value={form.mail_password ?? ""} onChange={set("mail_password")} />
          </label>
          <label htmlFor="mail_from_name">Your name on replies
            <input id="mail_from_name" type="text" value={val("mail_from_name")} onChange={set("mail_from_name")} />
          </label>
        </div>
        <label className="check" htmlFor="mail_auto_delegate">
          <input id="mail_auto_delegate" type="checkbox" checked={val("mail_auto_delegate") === "on"} onChange={(e) => setForm({ ...form, mail_auto_delegate: e.target.checked ? "on" : "" })} />
          <span>Hand off automatically when a rule matches. Off: every hand-off waits for your tap.</span>
        </label>
      </fieldset>

      <fieldset>
        <legend className="eyebrow">Relay for Hermes</legend>
        <p className="muted small">Lets Hermes add to the deck and ask what's next, for things you say in Claude, ChatGPT or Telegram. People can never be read this way; Hermes can only drop notes into it for you to file.</p>
        {relay?.token ? (
          <div className="token">
            <p className="small">Give Hermes these two things. The token is shown only now.</p>
            <code>http://btcsessions-life-architect_web_1:4600/api/relay</code>
            <code>{relay.token}</code>
          </div>
        ) : (
          <p className="small muted">{relay?.set ? "A token exists. Creating a new one stops the old one working." : "No token yet, so the relay is off."}</p>
        )}
        <div className="row">
          <button className="btn" type="button" onClick={async () => setRelay({ set: true, ...(await call<{ token: string }>("/api/settings/relay-token", { method: "POST" })) })}>
            {relay?.set ? "Create a new token" : "Create a token"}
          </button>
        </div>
      </fieldset>

      {msg && <p className={msg.ok ? "small electro" : "small accent"} role="status">{msg.text}</p>}
      <div className="row">
        <button className="btn" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </section>
  );
}
