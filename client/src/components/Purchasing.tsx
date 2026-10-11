import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { upload } from "./Construction";
import { Dialog, Field, Form, FormError } from "./forms";
import { DataTable, date, Icon, inr, Loaded, PageHeader, Panel, Pill } from "./ui";

const PO_TONE: Record<string, string> = { PLACED: "info", CONFIRMED: "warn", DELIVERED: "good", CANCELLED: "neutral" };
const PO_TEXT: Record<string, string> = { PLACED: "Placed", CONFIRMED: "Confirmed", DELIVERED: "Delivered", CANCELLED: "Cancelled" };
const DOCS = "application/pdf,image/jpeg,image/png,image/webp";
const today = () => new Date().toISOString().slice(0, 10);
const open = async (path: string) => { const r = await api<{ url: string }>("GET", path); window.open(r.url, "_blank", "noopener"); };
const qtyText = (n: unknown, unit?: unknown) => `${+Number(n).toFixed(2)}${unit && unit !== "each" ? ` ${unit}` : ""}`;

type Dlg = null | { kind: "order" } | { kind: "confirm"; po: Row } | { kind: "deliver"; po: Row } | { kind: "cancel"; po: Row };

/**
 * The store's standard package (needed, ordered, delivered) and its purchase orders. `editable` is
 * staff with project.write; `portal` is the franchisee.
 */
export function PurchasingPanel({ projectId, editable, portal, closed, onTasks }: { projectId: string; editable: boolean; portal?: boolean; closed?: boolean; onTasks?: () => void }) {
  const load = useLoad(() => Promise.all([api<Row>("GET", `/projects/${projectId}/purchasing`), api<Row>("GET", "/vendors")]).then(([p, c]): Row => ({ ...p, vendors: c.vendors as Row[], categories: c.categories as Row[] })), [projectId]);
  const act = useAction(load.reload);
  const [dialog, setDialog] = useState<Dlg>(null);
  const [showAll, setShowAll] = useState(false);
  const base = `/projects/${projectId}`;
  const canOrder = !closed && (editable || !!portal);
  const close = () => { setDialog(null); act.clear(); };
  const done = (r: unknown) => { if (r) setDialog(null); };
  const tasksNote = (r: Row) => {
    const t = (r.tasks_completed ?? []) as string[];
    if (t.length) onTasks?.();
    const names: Record<string, string> = { EQUIP_ORDER: "Order kitchen equipment", OPENING_STOCK: "Receive opening inventory" };
    return t.length ? ` ${t.map((c) => `“${names[c] ?? c}”`).join(" and ")} ${t.length === 1 ? "is" : "are"} now done.` : "";
  };
  const change = (po: Row, body: Row, msg: string) => act.run(`po${po.ROWID}`, () => api<Row>("PATCH", `${base}/purchase-orders/${po.ROWID}`, { body }), (r) => `${msg}${tasksNote(r)}`);

  return (
    <Loaded load={load}>{(p) => {
      const pkg = p.package as Row[], orders = p.orders as Row[];
      const cats = Object.fromEntries((p.categories as Row[]).map((c) => [c.code, c.name]));
      const vendorOf = Object.fromEntries((p.vendors as Row[]).map((v) => [String(v.ROWID), String(v.name)]));
      const ordered = pkg.filter((x) => x.ordered >= x.needed).length, delivered = pkg.filter((x) => x.delivered >= x.needed).length;
      const late = orders.filter((o) => o.late);
      const shown = showAll ? orders : orders.filter((o) => o.status !== "CANCELLED");
      return (
        <Panel title="Equipment and supplies" flush action={canOrder && <button className="btn sm" disabled={!(p.vendors as Row[]).length} onClick={() => setDialog({ kind: "order" })}>Place order</button>}>
          <dl className="summary flat">
            <div><dt>Package ordered</dt><dd>{pkg.length ? `${ordered} of ${pkg.length}` : "—"}</dd></div>
            <div><dt>Package delivered</dt><dd>{pkg.length ? `${delivered} of ${pkg.length}` : "—"}</dd></div>
            <div><dt>On order</dt><dd>{inr(Number(p.open_value))}</dd></div>
            <div><dt>Delivered</dt><dd>{inr(Number(p.delivered_value))}</dd></div>
          </dl>
          {act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>}
          {act.error && !dialog && <div style={{ margin: ".75rem 1rem 0" }}><FormError error={act.error} /></div>}
          {late.length > 0 && <div className="notice warn" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>{late.map((o) => o.po_number).join(", ")} {late.length === 1 ? "is" : "are"} late or due after {late.length === 1 ? "it's" : "they're"} needed.</span></div>}
          {!(p.vendors as Row[]).length && <div className="notice warn" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>No approved vendors yet. {can("vendor.manage") ? <Link to="/vendors">Set up the vendor catalogue.</Link> : "The franchise team sets up the vendor catalogue."}</span></div>}

          {pkg.length > 0 && <>
            <h3 className="sub-head">Standard store package</h3>
            <DataTable rows={pkg} columns={[
              { key: "name", label: "Item", render: (x) => <span style={{ display: "block", minWidth: "9rem" }}>{x.name}<span className="cell-sub">{vendorOf[String(x.vendor_id)] ?? ""}</span></span> },
              { key: "category", label: "Category", render: (x) => cats[String(x.category)] ?? x.category },
              { key: "needed", label: "Needed", align: "right", render: (x) => qtyText(x.needed, x.unit) },
              { key: "ordered", label: "Ordered", align: "right", render: (x) => <span style={{ color: x.ordered < x.needed ? "var(--warn)" : undefined }}>{qtyText(x.ordered)}</span> },
              { key: "delivered", label: "Delivered", align: "right", render: (x) => qtyText(x.delivered) },
              { key: "state", label: "", render: (x) => x.delivered >= x.needed ? <Pill value="Delivered" tone="good" /> : x.ordered >= x.needed ? <Pill value="On order" tone="info" /> : <Pill value="To order" tone="warn" /> },
            ]} />
          </>}

          <h3 className="sub-head">Purchase orders</h3>
          <DataTable rows={shown} empty={canOrder ? "No orders yet. Order the standard package from approved vendors." : "No orders yet."} columns={[
            { key: "po_number", label: "Order", render: (o) => <span style={{ display: "block", minWidth: "11rem" }}><span className="code">{o.po_number}</span> · {o.vendor_name}
              <span className="cell-sub">{(o.lines as Row[]).map((l) => `${qtyText(l.qty)} × ${l.name}`).join(", ")}</span>
              {o.status === "CANCELLED" && o.cancel_reason && <span className="cell-sub">Cancelled: {o.cancel_reason}</span>}
              {o.status === "DELIVERED" && o.delivery_note && <span className="cell-sub">{o.delivery_note}</span>}</span> },
            { key: "total", label: "Total", align: "right", render: (o) => inr(Number(o.total)) },
            { key: "status", label: "Status", render: (o) => <Pill value={PO_TEXT[String(o.status)]} tone={PO_TONE[String(o.status)]} /> },
            { key: "expected_delivery", label: "Delivery", render: (o) => o.status === "DELIVERED" ? `Arrived ${date(o.delivered_on)}`
              : o.status === "CANCELLED" ? "—"
              : <span style={{ color: o.late ? "var(--warn)" : undefined }}>{o.expected_delivery ? `${o.late ? "⚠ " : ""}${date(o.expected_delivery)}` : "Awaiting date"}<span className="cell-sub">{o.needed_by ? `Needed by ${date(o.needed_by)}` : ""}</span></span> },
            { key: "actions", label: "", align: "right", render: (o) => {
              const live = o.status === "PLACED" || o.status === "CONFIRMED";
              const busy = act.busy === `po${o.ROWID}`;
              return (
                <span className="panel-actions">
                  {o.delivery_ref && <button className="btn ghost sm" onClick={() => act.run("dn", () => open(`${base}/purchase-orders/${o.ROWID}/delivery-note`))}>Delivery note</button>}
                  {editable && !closed && live && <button className={`btn ${o.status === "PLACED" ? "" : "ghost "}sm`} disabled={busy} onClick={() => setDialog({ kind: "confirm", po: o })}>{o.status === "PLACED" ? "Confirm" : "Change date"}</button>}
                  {canOrder && live && <button className={`btn ${o.status === "CONFIRMED" ? "" : "ghost "}sm`} disabled={busy} onClick={() => setDialog({ kind: "deliver", po: o })}>Delivered</button>}
                  {!closed && live && (editable || (portal && o.status === "PLACED")) && <button className="btn danger-ghost sm" disabled={busy} onClick={() => setDialog({ kind: "cancel", po: o })}>Cancel</button>}
                </span>
              );
            } },
          ]} />
          {orders.some((o) => o.status === "CANCELLED") && <button className="btn ghost sm" style={{ margin: ".5rem 1rem .75rem" }} onClick={() => setShowAll(!showAll)}>{showAll ? "Hide cancelled orders" : "Show cancelled orders"}</button>}

          {dialog?.kind === "order" && <OrderDialog vendors={p.vendors as Row[]} pkg={pkg} cats={cats} busy={act.busy === "order"} error={act.error} onClose={close}
            onSave={(body) => act.run("order", () => api<Row>("POST", `${base}/purchase-orders`, { body }), (r) => `${r.po_number} placed for ${inr(Number(r.total))}.${tasksNote(r)}`).then(done)} />}
          {dialog?.kind === "confirm" && <ConfirmDialog po={dialog.po} busy={act.busy === `po${dialog.po.ROWID}`} error={act.error} onClose={close}
            onSave={(body) => change(dialog.po, { action: "confirm", ...body }, `${dialog.po.po_number} confirmed for ${date(body.expected_delivery)}.`).then(done)} />}
          {dialog?.kind === "deliver" && <DeliverDialog po={dialog.po} busy={act.busy === `po${dialog.po.ROWID}`} error={act.error} onClose={close}
            onSave={(body) => change(dialog.po, { action: "deliver", ...body }, `${dialog.po.po_number} delivered and added to capex.`).then(done)} />}
          {dialog?.kind === "cancel" && <CancelDialog po={dialog.po} busy={act.busy === `po${dialog.po.ROWID}`} error={act.error} onClose={close}
            onSave={(reason) => change(dialog.po, { action: "cancel", reason }, `${dialog.po.po_number} cancelled.`).then(done)} />}
        </Panel>
      );
    }}</Loaded>
  );
}

function OrderDialog({ vendors, pkg, cats, busy, error, onSave, onClose }: { vendors: Row[]; pkg: Row[]; cats: Record<string, string>; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  // Start with the vendor that has the most of the package still to order.
  const firstVendor = useMemo(() => {
    const short = pkg.filter((x) => x.ordered < x.needed);
    const best = vendors.map((v) => [v, short.filter((x) => String(x.vendor_id) === String(v.ROWID)).length] as const).sort((a, b) => b[1] - a[1])[0];
    return String((best?.[0] ?? vendors[0]).ROWID);
  }, [vendors, pkg]);
  const [vendorId, setVendorId] = useState(firstVendor);
  const vendor = vendors.find((v) => String(v.ROWID) === vendorId)!;
  const items = (vendor?.items ?? []) as Row[];
  const prefill = (vid: string) => Object.fromEntries(((vendors.find((v) => String(v.ROWID) === vid)?.items ?? []) as Row[]).map((i) => {
    const p = pkg.find((x) => x.item_id === String(i.ROWID));
    return [String(i.ROWID), p && p.needed > p.ordered ? String(+(p.needed - p.ordered).toFixed(2)) : ""];
  }));
  const [qty, setQty] = useState<Record<string, string>>(prefill(firstVendor));
  const [neededBy, setNeededBy] = useState("");
  const [notes, setNotes] = useState("");
  const chosen = items.filter((i) => Number(qty[String(i.ROWID)]) > 0);
  const total = chosen.reduce((t, i) => t + Number(qty[String(i.ROWID)]) * Number(i.unit_price), 0);
  return (
    <Dialog wide title="Place an order" subtitle="From the approved vendor catalogue. Standard package items are filled in with what's still to order." onClose={onClose}>
      <Form onSubmit={() => onSave({ vendor_id: vendorId, lines: chosen.map((i) => ({ item_id: String(i.ROWID), qty: Number(qty[String(i.ROWID)]) })), ...(neededBy ? { needed_by: neededBy } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) })}
        footer={<><span className="muted" style={{ marginRight: "auto" }}>{chosen.length} item{chosen.length === 1 ? "" : "s"} · {inr(total)}</span><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !chosen.length}>{busy ? "Placing…" : "Place order"}</button></>}>
        <Field label="Vendor" span><select value={vendorId} onChange={(e) => { setVendorId(e.target.value); setQty(prefill(e.target.value)); }}>{vendors.map((v) => <option key={String(v.ROWID)} value={String(v.ROWID)}>{v.name} · {cats[String(v.category)] ?? v.category}</option>)}</select></Field>
        <div className="span order-lines">
          {!items.length && <p className="muted" style={{ margin: 0 }}>This vendor has no items in the catalogue.</p>}
          {items.map((i) => {
            const p = pkg.find((x) => x.item_id === String(i.ROWID));
            return (
              <label key={String(i.ROWID)}>
                <span><strong>{i.name}</strong>{i.sku ? <span className="muted"> · {i.sku}</span> : null}
                  <span className="cell-sub">{inr(Number(i.unit_price))}{i.unit && i.unit !== "each" ? ` per ${i.unit}` : " each"}{i.lead_time_days ? ` · ${i.lead_time_days} days lead time` : ""}{p ? ` · package needs ${qtyText(p.needed)}, ${qtyText(p.ordered)} ordered` : ""}</span></span>
                <input type="number" min={0} step="any" inputMode="decimal" aria-label={`Quantity of ${i.name}`} value={qty[String(i.ROWID)] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [String(i.ROWID)]: e.target.value }))} placeholder="0" />
              </label>
            );
          })}
        </div>
        <Field label="Needed by (optional)" hint="Defaults to the install or stock task's due date."><input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} /></Field>
        <Field label="Notes (optional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function ConfirmDialog({ po, busy, error, onSave, onClose }: { po: Row; busy: boolean; error: ApiError | null; onSave: (b: { expected_delivery: string; vendor_ref?: string }) => void; onClose: () => void }) {
  const [day, setDay] = useState(String(po.expected_delivery ?? "").slice(0, 10));
  const [ref, setRef] = useState(String(po.vendor_ref ?? ""));
  return (
    <Dialog title={`Confirm ${po.po_number}`} subtitle={`${po.vendor_name}: the delivery date they've committed to.${po.needed_by ? ` Needed by ${date(po.needed_by)}.` : ""}`} onClose={onClose}>
      <Form onSubmit={() => onSave({ expected_delivery: day, ...(ref.trim() ? { vendor_ref: ref.trim() } : {}) })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !day}>{busy ? "Saving…" : "Confirm"}</button></>}>
        <Field label="Expected delivery" error={day && po.needed_by && day > String(po.needed_by).slice(0, 10) ? "After the date it's needed" : undefined}><input type="date" value={day} min={today()} onChange={(e) => setDay(e.target.value)} required autoFocus /></Field>
        <Field label="Vendor's order number (optional)"><input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function DeliverDialog({ po, busy, error, onSave, onClose }: { po: Row; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [day, setDay] = useState(today());
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  return (
    <Dialog title={`${po.po_number} delivered`} subtitle={`${inr(Number(po.total))} is added to the store's capex.`} onClose={onClose}>
      <Form onSubmit={async () => onSave({ delivered_on: day, ...(note.trim() ? { note: note.trim() } : {}), ...(file ? { delivery_note: await upload(file) } : {}) })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !day}>{busy ? "Saving…" : "Mark delivered"}</button></>}>
        <Field label="Arrived on"><input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} required autoFocus /></Field>
        <Field label="Delivery note (optional)" hint="PDF or a photo, up to 5 MB."><input type="file" accept={DOCS} capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <Field label="Condition or shortages (optional)" span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function CancelDialog({ po, busy, error, onSave, onClose }: { po: Row; busy: boolean; error: ApiError | null; onSave: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog title={`Cancel ${po.po_number}?`} subtitle={`${po.vendor_name}, ${inr(Number(po.total))}. Tell the vendor too.`} onClose={onClose}>
      <Form onSubmit={() => onSave(reason.trim())} footer={<><button type="button" className="btn secondary" onClick={onClose}>Keep order</button><button className="btn danger" disabled={busy || reason.trim().length < 3}>{busy ? "Saving…" : "Cancel order"}</button></>}>
        <Field label="Reason" span><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required autoFocus /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** Portal: the franchisee's orders. */
export function PortalOrders() {
  const home = useLoad(() => api<Row>("GET", "/portal/home"), []);
  return (
    <>
      <PageHeader title="Orders" subtitle="Order the standard store package from approved vendors and record deliveries." />
      <Loaded load={home}>{(h) => h.project ? <PurchasingPanel projectId={String(h.project.ROWID)} editable={false} portal closed={h.project.status === "CLOSED"} />
        : <div className="state">Ordering opens once your agreement is signed.</div>}</Loaded>
    </>
  );
}

// ---- Vendor catalogue (staff) ----

type CatDlg = null | { kind: "vendor"; vendor?: Row } | { kind: "item"; item?: Row } | { kind: "suspend"; vendor: Row };

export function Vendors() {
  const manage = can("vendor.manage");
  const load = useLoad(() => api<Row>("GET", "/vendors", { query: manage ? { all: "true" } : undefined }), [manage]);
  const act = useAction(load.reload);
  const [dialog, setDialog] = useState<CatDlg>(null);
  const close = () => { setDialog(null); act.clear(); };
  const done = (r: unknown) => { if (r) setDialog(null); };
  return (
    <>
      <PageHeader title="Vendors" subtitle="Approved suppliers, their price list, and the standard package every new store orders."
        actions={manage && <><button className="btn secondary" onClick={() => setDialog({ kind: "vendor" })}>Add vendor</button><button className="btn" onClick={() => setDialog({ kind: "item" })}>Add item</button></>} />
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      {act.error && !dialog && <FormError error={act.error} />}
      <Loaded load={load}>{(c) => {
        const vendors = c.vendors as Row[];
        const cats = Object.fromEntries((c.categories as Row[]).map((x) => [x.code, x.name]));
        const items = vendors.flatMap((v) => (v.items as Row[]).map((i): Row => ({ ...i, vendor_name: v.name, vendor_status: v.status })));
        const pkg = items.filter((i) => i.standard && i.status === "ACTIVE" && i.vendor_status === "APPROVED");
        const pkgValue = pkg.reduce((t, i) => t + Number(i.unit_price) * Number(i.standard_qty), 0);
        return (
          <>
            <Panel title="Approved vendors" flush>
              <DataTable rows={vendors} searchKeys={["name", "city", "contact_name"]} empty={manage ? "No vendors yet. Add the suppliers stores may order from." : "No vendors yet."} columns={[
                { key: "name", label: "Vendor", render: (v) => <span style={{ display: "block", minWidth: "10rem" }}>{v.name}<span className="cell-sub">{[v.contact_name, v.phone, v.email].filter(Boolean).join(" · ")}</span></span> },
                { key: "category", label: "Supplies", render: (v) => cats[String(v.category)] ?? v.category },
                { key: "city", label: "City", render: (v) => v.city || "—" },
                { key: "gstin", label: "GSTIN", render: (v) => v.gstin ? <span style={{ fontVariantNumeric: "tabular-nums", letterSpacing: ".02em" }}>{v.gstin}</span> : "—" },
                { key: "items", label: "Items", align: "right", sort: (v) => (v.items as Row[]).length, render: (v) => (v.items as Row[]).filter((i) => i.status === "ACTIVE").length },
                { key: "status", label: "Status", render: (v) => <span><Pill value={v.status === "APPROVED" ? "Approved" : "Suspended"} tone={v.status === "APPROVED" ? "good" : "bad"} />{v.status !== "APPROVED" && v.status_note && <span className="cell-sub">{v.status_note}</span>}</span> },
                ...(manage ? [{ key: "actions", label: "", align: "right" as const, render: (v: Row) => (
                  <span className="panel-actions">
                    <button className="btn ghost sm" onClick={() => setDialog({ kind: "vendor", vendor: v })}>Edit</button>
                    {v.status === "APPROVED"
                      ? <button className="btn danger-ghost sm" onClick={() => setDialog({ kind: "suspend", vendor: v })}>Suspend</button>
                      : <button className="btn ghost sm" disabled={act.busy === `v${v.ROWID}`} onClick={() => act.run(`v${v.ROWID}`, () => api<Row>("PATCH", `/vendors/${v.ROWID}`, { body: { approved: true } }), `${v.name} approved again.`)}>Approve</button>}
                  </span>
                ) }] : []),
              ]} />
            </Panel>
            <Panel title="Catalogue" flush action={<span className="muted">Standard package: {pkg.length} item{pkg.length === 1 ? "" : "s"}, {inr(pkgValue)} per store</span>}>
              <DataTable rows={items} searchKeys={["name", "sku", "vendor_name"]} empty="No items yet." columns={[
                { key: "name", label: "Item", render: (i) => <span style={{ display: "block", minWidth: "10rem", color: i.status !== "ACTIVE" ? "var(--muted)" : undefined }}>{i.name}<span className="cell-sub">{[i.sku, i.vendor_name].filter(Boolean).join(" · ")}</span></span> },
                { key: "category", label: "Category", render: (i) => cats[String(i.category)] ?? i.category },
                { key: "unit_price", label: "Price", align: "right", sort: (i) => Number(i.unit_price), render: (i) => <>{inr(Number(i.unit_price))}{i.unit && i.unit !== "each" ? <span className="muted"> / {i.unit}</span> : null}</> },
                { key: "lead_time_days", label: "Lead time", align: "right", render: (i) => (i.lead_time_days ? `${i.lead_time_days} days` : "—") },
                { key: "standard", label: "Each store", align: "right", sort: (i) => Number(i.standard ? i.standard_qty : 0), render: (i) => (i.standard ? qtyText(i.standard_qty, i.unit) : <span className="muted">Optional</span>) },
                { key: "status", label: "", render: (i) => (i.status !== "ACTIVE" ? <Pill value="Retired" tone="neutral" /> : null) },
                ...(manage ? [{ key: "actions", label: "", align: "right" as const, render: (i: Row) => (
                  <span className="panel-actions">
                    <button className="btn ghost sm" onClick={() => setDialog({ kind: "item", item: i })}>Edit</button>
                    <button className="btn ghost sm" disabled={act.busy === `i${i.ROWID}`} onClick={() => act.run(`i${i.ROWID}`, () => api<Row>("PATCH", `/vendor-items/${i.ROWID}`, { body: { active: i.status !== "ACTIVE" } }), `${i.name} ${i.status === "ACTIVE" ? "retired" : "restored"}.`)}>{i.status === "ACTIVE" ? "Retire" : "Restore"}</button>
                  </span>
                ) }] : []),
              ]} />
            </Panel>
            {dialog?.kind === "vendor" && <VendorDialog vendor={dialog.vendor} cats={c.categories as Row[]} busy={act.busy === "vendor"} error={act.error} onClose={close}
              onSave={(body) => act.run("vendor", () => dialog.vendor ? api<Row>("PATCH", `/vendors/${dialog.vendor.ROWID}`, { body }) : api<Row>("POST", "/vendors", { body }), (r) => `${r.name} saved.`).then(done)} />}
            {dialog?.kind === "item" && <ItemDialog item={dialog.item} vendors={vendors} cats={c.categories as Row[]} busy={act.busy === "item"} error={act.error} onClose={close}
              onSave={(body) => act.run("item", () => dialog.item ? api<Row>("PATCH", `/vendor-items/${dialog.item.ROWID}`, { body }) : api<Row>("POST", "/vendor-items", { body }), (r) => `${r.name} saved.`).then(done)} />}
            {dialog?.kind === "suspend" && <SuspendDialog vendor={dialog.vendor} busy={act.busy === "suspend"} error={act.error} onClose={close}
              onSave={(reason) => act.run("suspend", () => api<Row>("PATCH", `/vendors/${dialog.vendor.ROWID}`, { body: { approved: false, reason } }), `${dialog.vendor.name} suspended. Stores can't order from them.`).then(done)} />}
          </>
        );
      }}</Loaded>
    </>
  );
}

function VendorDialog({ vendor, cats, busy, error, onSave, onClose }: { vendor?: Row; cats: Row[]; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const str = (k: string) => String(vendor?.[k] ?? "");
  const [v, setV] = useState({ name: str("name"), category: str("category") || "KITCHEN", contact_name: str("contact_name"), phone: str("phone"), email: str("email"), gstin: str("gstin"), city: str("city"), notes: str("notes") });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const body = () => ({ name: v.name.trim(), category: v.category, ...Object.fromEntries((["contact_name", "phone", "email", "city", "notes"] as const).map((k) => [k, v[k].trim() || null])), gstin: v.gstin.trim().toUpperCase() || null });
  return (
    <Dialog title={vendor ? `Edit ${vendor.name}` : "Add vendor"} subtitle="Stores can order from approved vendors only." onClose={onClose}>
      <Form onSubmit={() => onSave(body())} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || v.name.trim().length < 2}>{busy ? "Saving…" : "Save vendor"}</button></>}>
        <Field label="Name" span><input value={v.name} onChange={set("name")} maxLength={200} required autoFocus /></Field>
        <Field label="Supplies"><select value={v.category} onChange={set("category")}>{cats.map((c) => <option key={String(c.code)} value={String(c.code)}>{c.name}</option>)}</select></Field>
        <Field label="City"><input value={v.city} onChange={set("city")} maxLength={100} /></Field>
        <Field label="Contact person"><input value={v.contact_name} onChange={set("contact_name")} maxLength={120} /></Field>
        <Field label="Phone"><input type="tel" value={v.phone} onChange={set("phone")} maxLength={20} /></Field>
        <Field label="Email"><input type="email" value={v.email} onChange={set("email")} maxLength={200} /></Field>
        <Field label="GSTIN"><input value={v.gstin} onChange={set("gstin")} maxLength={15} placeholder="33ABCDE1234F1Z5" /></Field>
        <Field label="Notes" span><textarea rows={2} value={v.notes} onChange={set("notes")} maxLength={2000} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function ItemDialog({ item, vendors, cats, busy, error, onSave, onClose }: { item?: Row; vendors: Row[]; cats: Row[]; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const str = (k: string, d = "") => (item?.[k] === null || item?.[k] === undefined ? d : String(item[k]));
  const firstVendor = vendors.find((x) => x.status === "APPROVED") ?? vendors[0];
  const [v, setV] = useState({ vendor_id: str("vendor_id", String(firstVendor?.ROWID ?? "")), name: str("name"), sku: str("sku"), category: str("category", String(firstVendor?.category ?? "KITCHEN")), unit: str("unit", "each"), unit_price: str("unit_price"), lead_time_days: str("lead_time_days"), standard_qty: str("standard_qty") });
  const [standard, setStandard] = useState(!!item?.standard);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const submit = () => onSave({
    vendor_id: v.vendor_id, name: v.name.trim(), sku: v.sku.trim() || null, category: v.category, unit: v.unit.trim() || null, unit_price: Number(v.unit_price),
    lead_time_days: v.lead_time_days === "" ? null : Number(v.lead_time_days), standard, standard_qty: standard ? Number(v.standard_qty) : null,
  });
  return (
    <Dialog title={item ? `Edit ${item.name}` : "Add catalogue item"} onClose={onClose}>
      <Form onSubmit={submit} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !vendors.length || v.name.trim().length < 2 || v.unit_price === "" || (standard && !(Number(v.standard_qty) > 0))}>{busy ? "Saving…" : "Save item"}</button></>}>
        <Field label="Vendor" span><select value={v.vendor_id} onChange={set("vendor_id")} required>{vendors.map((x) => <option key={String(x.ROWID)} value={String(x.ROWID)}>{x.name}</option>)}</select></Field>
        <Field label="Item" span><input value={v.name} onChange={set("name")} maxLength={200} required autoFocus placeholder="Twin-basket fryer" /></Field>
        <Field label="SKU (optional)"><input value={v.sku} onChange={set("sku")} maxLength={60} /></Field>
        <Field label="Capex category"><select value={v.category} onChange={set("category")}>{cats.map((c) => <option key={String(c.code)} value={String(c.code)}>{c.name}</option>)}</select></Field>
        <Field label="Price (₹, before tax)"><input type="number" min={0} step="any" value={v.unit_price} onChange={set("unit_price")} required /></Field>
        <Field label="Unit"><input value={v.unit} onChange={set("unit")} maxLength={20} placeholder="each, kg, box" /></Field>
        <Field label="Lead time in days (optional)"><input type="number" min={0} max={365} value={v.lead_time_days} onChange={set("lead_time_days")} /></Field>
        <label className="check span"><input type="checkbox" checked={standard} onChange={(e) => setStandard(e.target.checked)} /> Part of the standard package every store orders</label>
        {standard && <Field label="How many each store needs"><input type="number" min={0} step="any" value={v.standard_qty} onChange={set("standard_qty")} required /></Field>}
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function SuspendDialog({ vendor, busy, error, onSave, onClose }: { vendor: Row; busy: boolean; error: ApiError | null; onSave: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog title={`Suspend ${vendor.name}?`} subtitle="Stores can't place new orders with them. Orders already placed carry on." onClose={onClose}>
      <Form onSubmit={() => onSave(reason.trim())} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn danger" disabled={busy || reason.trim().length < 3}>{busy ? "Saving…" : "Suspend"}</button></>}>
        <Field label="Reason" span><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required autoFocus /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}
