import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { upload } from "./Construction";
import { Dialog, Field, Form, FormError } from "./forms";
import { DataTable, date, Icon, Loaded, PageHeader, Panel, Pill } from "./ui";

// Portal v2: the franchisee's to-do list, documents and messages; the staff side of messages and the brand library.

const LEVEL_TEXT: Record<string, string> = { overdue: "Overdue", due: "Due now", soon: "Coming up", info: "For info" };
const LEVEL_TONE: Record<string, string> = { overdue: "bad", due: "warn", soon: "info", info: "neutral" };
const CATEGORY_TEXT: Record<string, string> = { MANUAL: "Manuals", MARKETING: "Marketing", TRAINING: "Training", POLICY: "Policies", FORM: "Forms", OTHER: "Other" };
const DOCS = "image/jpeg,image/png,image/webp,application/pdf";
const openUrl = async (path: string) => { const r = await api<{ url: string }>("GET", path); window.open(r.url, "_blank", "noopener"); };
const time = (v: unknown) => (v ? new Date(String(v)).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

/** The to-do items as tappable rows. */
export function TodoList({ items, empty = "Nothing to do right now." }: { items: Row[]; empty?: string }) {
  if (!items.length) return <div className="state"><Icon name="check" />{empty}</div>;
  return (
    <ul className="todo-list">
      {items.map((t) => (
        <li key={String(t.key)} className={String(t.level)}>
          <Link to={String(t.path)}>
            <span className="todo-main">
              <strong>{t.title}</strong>
              <span className="cell-sub">{[t.project_code, t.detail].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="todo-side">
              <Pill value={LEVEL_TEXT[String(t.level)]} tone={LEVEL_TONE[String(t.level)]} />
              {t.due && <span className="cell-sub">{t.level === "overdue" ? "Was due " : "Due "}{date(t.due)}</span>}
            </span>
            <Icon name="chevron" size={16} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Portal: everything to do, filterable by store. */
export function PortalTodo() {
  const load = useLoad(() => api<Row>("GET", "/portal/todo"), []);
  const [store, setStore] = useState("");
  return (
    <>
      <PageHeader title="To do" subtitle="Everything that needs you, across your stores, most urgent first." />
      <Loaded load={load}>{(d) => {
        const items = d.items as Row[];
        const stores = [...new Set(items.map((i) => i.project_code).filter(Boolean))] as string[];
        const shown = store ? items.filter((i) => i.project_code === store) : items;
        return (
          <Panel flush action={stores.length > 1 && <select aria-label="Store" value={store} onChange={(e) => setStore(e.target.value)}><option value="">All stores</option>{stores.map((s) => <option key={s}>{s}</option>)}</select>}
            title={<>{shown.length} thing{shown.length === 1 ? "" : "s"} to do{d.counts.overdue > 0 && <Pill value={`${d.counts.overdue} overdue`} tone="bad" />}</>}>
            <TodoList items={shown} empty="You're all caught up." />
          </Panel>
        );
      }}</Loaded>
    </>
  );
}

/** Portal: the brand library and the franchisee's own files. */
export function PortalDocuments() {
  const load = useLoad(() => api<Row>("GET", "/portal/documents"), []);
  const act = useAction(() => undefined);
  return (
    <>
      <PageHeader title="Documents" subtitle="Brand manuals and guides, and the files from your own stores." />
      {act.error && <div className="notice bad"><Icon name="alert" />{act.error.message}</div>}
      <Loaded load={load}>{(d) => {
        const library = d.library as Row[], records = d.records as Row[];
        const groups = (rows: Row[], key: string) => [...new Set(rows.map((r) => String(r[key])))];
        return (
          <>
            <Panel title="From the brand" flush>
              {library.length ? groups(library, "category").map((c) => (
                <div key={c}>
                  <h3 className="sub-head">{CATEGORY_TEXT[c] ?? c}</h3>
                  <ul className="module-list docs">{library.filter((x) => x.category === c).map((x) => (
                    <li key={String(x.ROWID)}><span>{x.title}<span className="cell-sub">{x.notes ? `${x.notes} · ` : ""}Added {date(x.uploaded_at)}</span></span>
                      <button className="btn ghost sm" onClick={() => act.run(`d${x.ROWID}`, () => openUrl(`/documents/${x.ROWID}/file`))}>Open</button></li>
                  ))}</ul>
                </div>
              )) : <div className="state">The brand hasn't shared any documents yet.</div>}
            </Panel>
            <Panel title="Your files" flush>
              {records.length ? groups(records, "group").map((g) => (
                <div key={g}>
                  <h3 className="sub-head">{g}</h3>
                  <ul className="module-list docs">{records.filter((x) => x.group === g).map((x) => (
                    <li key={String(x.path)}><span>{x.title}<span className="cell-sub">{[x.project_code, x.date ? date(x.date) : null].filter(Boolean).join(" · ")}</span></span>
                      <button className="btn ghost sm" onClick={() => act.run(String(x.path), () => openUrl(String(x.path)))}>Open</button></li>
                  ))}</ul>
                </div>
              )) : <div className="state">Licences, lease, sanction letter, designs and certificates you upload appear here.</div>}
            </Panel>
          </>
        );
      }}</Loaded>
    </>
  );
}

/** A conversation and the box to reply in. `me` is the side reading it. */
function Conversation({ messages, me, stores, onSend }: { messages: Row[]; me: "FRANCHISEE" | "BRAND"; stores?: Row[]; onSend: (b: Row) => Promise<unknown> }) {
  const [textValue, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [store, setStore] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length]);
  const send = async () => {
    if (!textValue.trim()) return;
    setBusy(true); setError(null);
    try {
      await onSend({ text: textValue.trim(), ...(store ? { project_id: store } : {}), ...(file ? { attachment: await upload(file) } : {}) });
      setText(""); setFile(null);
    } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  };
  return (
    <div className="chat">
      <ol className="chat-list">
        {!messages.length && <li className="state">{me === "FRANCHISEE" ? "Ask the brand team anything. Your franchise manager is told straight away." : "No messages yet."}</li>}
        {messages.map((m) => (
          <li key={String(m.ROWID)} className={m.from_side === me ? "mine" : "theirs"}>
            <div className="bubble">
              <p>{m.message_text}</p>
              {m.attachment_ref && <button className="btn ghost sm" onClick={() => openUrl(`/messages/${m.ROWID}/attachment`)}>Attachment</button>}
            </div>
            <span className="cell-sub">{me === "FRANCHISEE" && m.from_side === me ? "You" : m.sender ?? (m.from_side === "BRAND" ? "Brand team" : "Franchisee")} · {time(m.sent_at)}{m.from_side === me && m.read_at ? " · Read" : ""}</span>
          </li>
        ))}
        <div ref={end} />
      </ol>
      <form className="chat-box" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea rows={2} placeholder="Write a message" aria-label="Message" value={textValue} onChange={(e) => setText(e.target.value)} maxLength={4000}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        <div className="chat-tools">
          {stores && stores.length > 1 && <select aria-label="About store" value={store} onChange={(e) => setStore(e.target.value)}><option value="">About: general</option>{stores.map((s) => <option key={String(s.ROWID)} value={String(s.ROWID)}>{s.project_code}</option>)}</select>}
          <label className="btn ghost sm">{file ? file.name.slice(0, 18) : "Attach"}<input type="file" accept={DOCS} hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <button className="btn" disabled={busy || !textValue.trim()}><Icon name="send" size={16} />{busy ? "Sending…" : "Send"}</button>
        </div>
        {error && <FormError error={error} />}
      </form>
    </div>
  );
}

/** Portal: the franchisee's conversation with the brand team. */
export function PortalMessages() {
  const load = useLoad(() => api<Row[]>("GET", "/portal/messages"), []);
  const stores = useLoad(() => api<Row[]>("GET", "/projects"), []);
  return (
    <>
      <PageHeader title="Messages" subtitle="Talk to the brand team. Replies come back here, and you are told when one arrives." />
      <Panel flush><Loaded load={load}>{(m) => <Conversation messages={m} me="FRANCHISEE" stores={(stores.data ?? []) as Row[]} onSend={(b) => api("POST", "/portal/messages", { body: b }).then(load.reload)} />}</Loaded></Panel>
    </>
  );
}

/** Staff: every franchisee conversation, newest first. */
export function MessagesInbox() {
  const load = useLoad(() => api<Row[]>("GET", "/messages"), []);
  return (
    <>
      <PageHeader title="Messages" crumbs={[["Overview"], ["Messages"]]} subtitle="Conversations with franchisees. A new message goes to the franchisee's application owner, or franchise managers." />
      <Panel flush><Loaded load={load}>{(rows) => (
        <DataTable rows={rows} href={(r) => `/messages/${r.franchisee_id}`} searchKeys={["franchisee", "preview"]} empty="No conversations yet." columns={[
          { key: "franchisee", label: "Franchisee", render: (r) => <><Link to={`/messages/${r.franchisee_id}`}>{String(r.franchisee)}</Link><span className="cell-sub">{String(r.franchise_code ?? "")}</span></> },
          { key: "preview", label: "Last message", render: (r) => <span style={{ display: "block", maxWidth: "36rem" }}>{r.last_from === "BRAND" ? <span className="muted">You: </span> : null}{r.preview}</span> },
          { key: "last_at", label: "When", render: (r) => time(r.last_at) },
          { key: "unread", label: "Unread", align: "right", render: (r) => r.unread ? <Pill value={`${r.unread} new`} tone="warn" /> : <span className="muted">—</span> },
        ]} />
      )}</Loaded></Panel>
    </>
  );
}

/** Staff: one franchisee's conversation. */
export function MessageThread() {
  const { id } = useParams();
  const load = useLoad(() => api<Row>("GET", `/franchisees/${id}/messages`), [id]);
  return (
    <Loaded load={load}>{(d) => (
      <>
        <PageHeader title={String(d.franchisee.display_name ?? d.franchisee.franchise_code)} crumbs={[["Overview"], ["Messages", "/messages"], [String(d.franchisee.franchise_code)]]} />
        <Panel flush><Conversation messages={d.messages as Row[]} me="BRAND" onSend={(b) => api("POST", `/franchisees/${id}/messages`, { body: b }).then(load.reload)} /></Panel>
      </>
    )}</Loaded>
  );
}

/** Staff: the brand library shared with franchisees. */
export function BrandDocuments() {
  const load = useLoad(() => api<Row[]>("GET", "/documents"), []);
  const franchisees = useLoad(() => api<Row[]>("GET", "/franchisees"), []);
  const act = useAction(load.reload);
  const [adding, setAdding] = useState(false);
  const share = can("document.share");
  const name = (id: unknown) => { const f = (franchisees.data ?? []).find((x) => String(x.ROWID) === String(id)); return f ? String(f.display_name ?? f.franchise_code) : "One franchisee"; };
  return (
    <>
      <PageHeader title="Brand documents" crumbs={[["Operations"], ["Brand documents"]]} subtitle="Manuals, guides and forms franchisees see in their portal."
        actions={share && <button className="btn" onClick={() => setAdding(true)}><Icon name="send" size={16} />Share a document</button>} />
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <Panel flush><Loaded load={load}>{(rows) => (
        <DataTable rows={[...rows].sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)))} searchKeys={["title", "notes"]} empty="Nothing shared yet." columns={[
          { key: "title", label: "Document", render: (r) => <>{r.title}<span className="cell-sub">{r.notes ?? ""}</span></> },
          { key: "category", label: "Kind", render: (r) => CATEGORY_TEXT[String(r.category)] ?? r.category },
          { key: "franchisee_id", label: "Shared with", render: (r) => r.franchisee_id ? name(r.franchisee_id) : "Every franchisee" },
          { key: "uploaded_at", label: "Added", render: (r) => date(r.uploaded_at) },
          { key: "actions", label: "", align: "right", render: (r) => <span className="panel-actions">
            <button className="btn ghost sm" onClick={() => act.run(`o${r.ROWID}`, () => openUrl(`/documents/${r.ROWID}/file`))}>Open</button>
            {share && <button className="btn ghost sm" disabled={act.busy === `a${r.ROWID}`} onClick={() => act.run(`a${r.ROWID}`, () => api("PATCH", `/documents/${r.ROWID}`, { body: { action: "archive" } }), "Removed from the portal.")}>Remove</button>}
          </span> },
        ]} />
      )}</Loaded></Panel>
      {adding && <ShareDialog franchisees={(franchisees.data ?? []) as Row[]} busy={act.busy === "share"} error={act.error} onClose={() => { setAdding(false); act.clear(); }}
        onSave={(b) => act.run("share", () => api<Row>("POST", "/documents", { body: b }), "Shared. Franchisees have been told.").then((r) => r && setAdding(false))} />}
    </>
  );
}

function ShareDialog({ franchisees, busy, error, onSave, onClose }: { franchisees: Row[]; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [v, setV] = useState({ title: "", category: "MANUAL", notes: "", franchisee_id: "" });
  const [file, setFile] = useState<File | null>(null);
  return (
    <Dialog title="Share a document" subtitle="It appears in Documents on the franchisee portal." onClose={onClose}>
      <Form onSubmit={async () => file && onSave({ title: v.title.trim(), category: v.category, ...(v.notes.trim() ? { notes: v.notes.trim() } : {}), ...(v.franchisee_id ? { franchisee_id: v.franchisee_id } : {}), file: await upload(file) })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !file || v.title.trim().length < 2}>{busy ? "Sharing…" : "Share"}</button></>}>
        <Field label="Title" span><input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={160} required autoFocus /></Field>
        <Field label="Kind"><select value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>{Object.entries(CATEGORY_TEXT).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Share with"><select value={v.franchisee_id} onChange={(e) => setV({ ...v, franchisee_id: e.target.value })}><option value="">Every franchisee</option>{franchisees.map((f) => <option key={String(f.ROWID)} value={String(f.ROWID)}>{f.display_name ?? f.franchise_code}</option>)}</select></Field>
        <Field label="Note (optional)" span><input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} maxLength={1000} /></Field>
        <Field label="File" hint="PDF or image, up to 5 MB." span><input type="file" accept={DOCS} onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}
