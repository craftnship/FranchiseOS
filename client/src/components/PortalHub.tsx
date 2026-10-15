import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
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

const ABOUT_NOUN: Record<string, string> = { APPLICATION: "Application", AGREEMENT: "Agreement", PROJECT: "Store" };
const aboutKey = (a: Row | null | undefined) => (a ? `${a.type}:${a.id}` : "");
/** Where a record a message is about opens: staff go to the record, the franchisee to their portal page for it. */
const aboutPath = (a: Row, portal: boolean) => portal
  ? ({ APPLICATION: "/portal/application", AGREEMENT: "/portal/agreement", PROJECT: "/portal" } as Record<string, string>)[String(a.type)] ?? "/portal"
  : ({ APPLICATION: `/applications/${a.id}`, AGREEMENT: `/agreements/${a.id}`, PROJECT: `/projects/${a.id}` } as Record<string, string>)[String(a.type)] ?? "/";

/** Delivery of one of our own messages: read in the portal, sent by email to a franchisee without a login, or (when it reached nobody) why. */
const delivery = (m: Row, undelivered?: string) => (m.read_at ? "Read" : m.emailed_to ? `Emailed to ${m.emailed_to}` : undelivered ?? "");

/** A conversation and the box to reply in. `me` is the side reading it; `about` lists the records a message can be about. */
export function Conversation({ messages, me, about, initial, undelivered, onSend }: { messages: Row[]; me: "FRANCHISEE" | "BRAND"; about: Row[]; initial?: string; undelivered?: string; onSend: (b: Row) => Promise<unknown> }) {
  const [textValue, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [context, setContext] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const portal = me === "FRANCHISEE";
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length]);
  useEffect(() => { if (initial) setContext(initial); }, [initial]);
  const send = async () => {
    if (!textValue.trim()) return;
    setBusy(true); setError(null);
    const [type, id] = context.split(":");
    try {
      await onSend({ text: textValue.trim(), ...(type && id ? { context: { type, id } } : {}), ...(file ? { attachment: await upload(file) } : {}) });
      setText(""); setFile(null);
    } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  };
  return (
    <div className="chat">
      <ol className="chat-list">
        {!messages.length && <li className="state">{portal ? "Ask the brand team anything. Your franchise manager is told straight away." : "No messages yet. Write the first one below."}</li>}
        {messages.map((m) => (
          <li key={String(m.ROWID)} className={m.from_side === me ? "mine" : "theirs"}>
            <div className="bubble">
              {m.about && <Link className="chip static" to={aboutPath(m.about, portal)}>{ABOUT_NOUN[String(m.about.type)] ?? "About"} {m.about.code}</Link>}
              <p>{m.message_text}</p>
              {m.attachment_ref && <button className="btn ghost sm" onClick={() => openUrl(`/messages/${m.ROWID}/attachment`)}>Attachment</button>}
            </div>
            <span className="cell-sub">{portal && m.from_side === me ? "You" : m.sender ?? (m.from_side === "BRAND" ? "Brand team" : "Franchisee")} · {time(m.sent_at)}{m.from_side === me && delivery(m, undelivered) ? ` · ${delivery(m, undelivered)}` : ""}</span>
          </li>
        ))}
        <div ref={end} />
      </ol>
      <form className="chat-box" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea rows={2} placeholder="Write a message" aria-label="Message" value={textValue} onChange={(e) => setText(e.target.value)} maxLength={4000}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        <div className="chat-tools">
          {about.length > 0 && <select aria-label="About" value={context} onChange={(e) => setContext(e.target.value)}>
            <option value="">About: general</option>
            {about.map((a) => <option key={aboutKey(a)} value={aboutKey(a)}>{ABOUT_NOUN[String(a.type)]} {a.code}</option>)}
          </select>}
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
  const load = useLoad(() => api<Row>("GET", "/portal/messages"), []);
  return (
    <>
      <PageHeader title="Messages" subtitle="Talk to the brand team. Replies come back here, and you are told when one arrives." />
      <Panel flush><Loaded load={load}>{(d) => <Conversation messages={d.messages as Row[]} me="FRANCHISEE" about={d.about as Row[]} onSend={(b) => api("POST", "/portal/messages", { body: b }).then(load.reload)} />}</Loaded></Panel>
    </>
  );
}

/** Staff: pick a franchisee to write to, applicants included. The conversation starts with the first message. */
function NewMessageDialog({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const load = useLoad(() => api<Row[]>("GET", "/franchisees", { query: { limit: "200" } }), []);
  const term = q.trim().toLowerCase();
  const rows = (load.data ?? []).filter((f) => !term || ["display_name", "legal_name", "franchise_code", "email"].some((k) => String(f[k] ?? "").toLowerCase().includes(term))).slice(0, 12);
  return (
    <Dialog title="New message" subtitle="Who is it for? The conversation opens next, with your message as the first one." onClose={onClose}>
      <div style={{ display: "grid", gap: ".6rem" }}>
        <label className="filter-input"><Icon name="search" size={16} /><input type="search" autoFocus placeholder="Name, code or email" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <Loaded load={load}>{() => (
          <ul className="todo-list">
            {!rows.length && <li className="state">No franchisee matches.</li>}
            {rows.map((f) => (
              <li key={String(f.ROWID)}>
                <Link to={`/messages/${f.ROWID}`} onClick={onClose}>
                  <span className="todo-main"><strong>{f.display_name}</strong><span className="cell-sub">{[f.franchise_code, f.email, f.status ? String(f.status).toLowerCase() : null].filter(Boolean).join(" · ")}</span></span>
                </Link>
              </li>
            ))}
          </ul>
        )}</Loaded>
      </div>
    </Dialog>
  );
}

/** Staff: every franchisee conversation, newest first. */
export function MessagesInbox() {
  const load = useLoad(() => api<Row[]>("GET", "/messages"), []);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [compose, setCompose] = useState(false);
  return (
    <>
      <PageHeader title="Messages" crumbs={[["Overview"], ["Messages"]]} subtitle="Conversations with franchisees. A new message goes to the franchisee's application owner, or franchise managers."
        actions={<button className="btn" onClick={() => setCompose(true)}><Icon name="chat" size={16} />New message</button>} />
      <Panel flush><Loaded load={load}>{(all) => {
        const rows = unreadOnly ? all.filter((r) => Number(r.unread) > 0) : all;
        return (
        <DataTable rows={rows} href={(r) => `/messages/${r.franchisee_id}`} searchKeys={["franchisee", "preview"]} empty={unreadOnly ? "Nothing unread." : "No conversations yet. Start one with New message."}
          toolbar={<div className="chips">{[["All", false], ["Unread", true]].map(([text, on]) => <button key={String(text)} className={`chip ${unreadOnly === on ? "on" : ""}`} onClick={() => setUnreadOnly(on as boolean)}>{text}</button>)}</div>}
          columns={[
          { key: "franchisee", label: "Franchisee", render: (r) => <><Link to={`/messages/${r.franchisee_id}`}>{String(r.franchisee)}</Link><span className="cell-sub">{String(r.franchise_code ?? "")}</span></> },
          { key: "preview", label: "Last message", render: (r) => <span style={{ display: "block", maxWidth: "36rem" }}>{r.last_from === "BRAND" ? <span className="muted">You: </span> : null}{r.preview}</span> },
          { key: "last_at", label: "When", render: (r) => time(r.last_at) },
          { key: "unread", label: "Unread", align: "right", render: (r) => r.unread ? <Pill value={`${r.unread} new`} tone="warn" /> : <span className="muted">—</span> },
        ]} />
        );
      }}</Loaded></Panel>
      {compose && <NewMessageDialog onClose={() => setCompose(false)} />}
    </>
  );
}

/** Staff: one franchisee's conversation. `?about=TYPE:ID` preselects the record a message is about. */
export function MessageThread() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const load = useLoad(() => api<Row>("GET", `/franchisees/${id}/messages`), [id]);
  return (
    <Loaded load={load}>{(d) => {
      const f = d.franchisee as Row;
      const noLogin = Number(f.portal_users ?? 0) === 0;
      // Why a brand message reaches nobody: no login and no email, or no login and no email sender set up.
      const undelivered = !noLogin ? undefined : !f.email ? "Not emailed: no email on file" : !f.email_enabled ? "Not emailed: email is not set up" : undefined;
      return (
        <>
          <PageHeader title={String(f.display_name ?? f.franchise_code)} crumbs={[["Overview"], ["Messages", "/messages"], [String(f.franchise_code)]]}
            subtitle={f.email ? String(f.email) : undefined}
            actions={<Link className="btn secondary" to={`/franchisees/${f.ROWID}`}><Icon name="franchisees" size={16} />Franchisee record</Link>} />
          {noLogin && (!f.email
            ? <div className="notice warn"><Icon name="alert" />{f.display_name} has no portal login and no email on file, so they will not see these messages. Add their email in CRM, or invite them to the portal from Users.</div>
            : !f.email_enabled
              ? <div className="notice warn"><Icon name="alert" />{f.display_name} has no portal login, and email is not set up, so they will not be told about these messages. Invite them to the portal from Users, or have an administrator set up the email sender.</div>
              : <div className="notice info"><Icon name="alert" />{f.display_name} has no portal login yet, so each message goes to {f.email} by email. They reply to you directly, not here.</div>)}
          <Panel flush><Conversation messages={d.messages as Row[]} me="BRAND" about={d.about as Row[]} initial={params.get("about") ?? ""} undelivered={undelivered} onSend={(b) => api("POST", `/franchisees/${id}/messages`, { body: b }).then(load.reload)} /></Panel>
        </>
      );
    }}</Loaded>
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
