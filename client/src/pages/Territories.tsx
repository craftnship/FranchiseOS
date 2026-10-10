import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { ConfirmDialog, Dialog, Field, Form, FormError } from "../components/forms";
import { DataTable, Icon, label, Loaded, PageHeader, Pill, Progress } from "../components/ui";

const fmt = (n: unknown, digits = 0) => (n === null || n === undefined || n === "" ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: digits }));
const INDICES: [string, string][] = [["population_index", "Population score"], ["market_index", "Market score"], ["income_index", "Income score"], ["competition_index", "Competition score"]];

type Open = null | { edit: Row | "new" } | { block: Row };

export function Territories() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const load = useLoad(() => api<Row[]>("GET", "/territories", { query: { status, limit: "200" } }), [status]);
  const [open, setOpen] = useState<Open>(null);
  const act = useAction(useCallback(() => load.reload(), [load]));
  const writer = can("territory.write");
  const close = () => setOpen(null);
  const save = (t: Row | "new", body: Row) => act.run("save", () => (t === "new" ? api<Row>("POST", "/territories", { body }) : api<Row>("PATCH", `/territories/${t.ROWID}`, { body })),
    (r) => (t === "new" ? `${r.territory_code} added.` : `${r.territory_code} saved.`)).then((r) => r && close());
  const setStatus = (t: Row, to: string) => act.run(`s${t.ROWID}`, () => api<Row>("PATCH", `/territories/${t.ROWID}`, { body: { status: to } }),
    `${t.territory_code} ${to === "BLOCKED" ? "blocked" : "is available again"}.`).then((r) => r && close());

  return (
    <>
      <PageHeader title="Territories" crumbs={[["Expansion"], ["Territories"]]} subtitle="Market areas, their opportunity score and who holds them."
        actions={writer && <button className="btn" onClick={() => setOpen({ edit: "new" })}>Add territory</button>} />
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      {act.error && !open && <div className="notice warn"><Icon name="alert" />{act.error.message}</div>}
      <Loaded load={load}>{(rows) => (
        <DataTable rows={rows} searchKeys={["territory_code", "name", "city", "state", "region"]}
          toolbar={<div className="chips">{["", "AVAILABLE", "RESERVED", "ALLOCATED", "BLOCKED"].map((s) => <button key={s} className={`chip ${status === s ? "on" : ""}`} onClick={() => setParams(s ? { status: s } : {})}>{s ? label(s) : "All"}</button>)}</div>}
          columns={[
            { key: "territory_code", label: "Code", render: (t) => <span className="code">{t.territory_code}</span> },
            { key: "name", label: "Territory", render: (t) => <>{t.name}<span className="cell-sub">{[t.city, t.state].filter(Boolean).join(", ")}</span></> },
            { key: "region", label: "Region" },
            { key: "franchise_type", label: "Format" },
            { key: "population", label: "Population", align: "right", sort: (t) => Number(t.population ?? 0), render: (t) => fmt(t.population) },
            { key: "opportunity_score", label: "Opportunity", sort: (t) => Number(t.opportunity_score ?? -1), render: (t) => <Progress value={t.opportunity_score} rag={Number(t.opportunity_score) >= 75 ? "GREEN" : Number(t.opportunity_score) >= 60 ? "AMBER" : "RED"} /> },
            { key: "status", label: "Status", render: (t) => <Pill value={t.status} /> },
            ...(writer ? [{ key: "actions", label: "", align: "right" as const, render: (t: Row) => (
              <div className="panel-actions">
                <button className="btn ghost sm" onClick={() => setOpen({ edit: t })}>Edit</button>
                {t.status === "AVAILABLE" && <button className="btn danger-ghost sm" onClick={() => setOpen({ block: t })}>Block</button>}
                {t.status === "BLOCKED" && <button className="btn ghost sm" disabled={!!act.busy} onClick={() => setStatus(t, "AVAILABLE")}>Unblock</button>}
              </div>
            ) }] : []),
          ]} />
      )}</Loaded>
      {open && "edit" in open && <TerritoryDialog territory={open.edit} busy={act.busy === "save"} error={act.error} onSave={(b) => save(open.edit, b)} onClose={close} />}
      {open && "block" in open && (
        <ConfirmDialog title={`Block ${open.block.territory_code}?`} confirm="Block territory" danger busy={!!act.busy} error={act.error} onClose={close}
          body={<p className="muted" style={{ margin: 0 }}>{open.block.name} stops appearing in territory searches until you unblock it.</p>}
          onConfirm={() => setStatus(open.block, "BLOCKED")} />
      )}
    </>
  );
}

function TerritoryDialog({ territory, busy, error, onSave, onClose }: { territory: Row | "new"; busy: boolean; error: ApiError | null; onSave: (body: Row) => void; onClose: () => void }) {
  const t: Row = territory === "new" ? {} : territory;
  const text = ["name", "city", "state", "region", "franchise_type"];
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries([...text, "population", "latitude", "longitude", ...INDICES.map(([k]) => k)].map((k) => [k, t[k] == null ? "" : String(t[k])])));
  const set = (k: string) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const scored = INDICES.every(([k]) => v[k] !== "");
  const submit = () => {
    const body: Row = {};
    for (const k of text) if (v[k].trim() !== String(t[k] ?? "")) body[k] = v[k].trim();
    for (const k of ["population", "latitude", "longitude"]) if (v[k] !== "" && v[k] !== String(t[k] ?? "")) body[k] = Number(v[k]);
    if (scored) for (const [k] of INDICES) body[k] = Number(v[k]);
    if (Object.keys(body).length) onSave(body); else onClose();
  };
  const num = (k: string, props: Record<string, unknown> = {}) => <input type="number" value={v[k]} onChange={set(k)} {...props} />;
  return (
    <Dialog title={territory === "new" ? "Add territory" : `Edit ${t.territory_code}`} subtitle={territory === "new" ? "It starts as available for reservation." : String(t.name)} onClose={onClose}>
      <Form onSubmit={submit} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving…" : territory === "new" ? "Add territory" : "Save"}</button></>}>
        <Field label="Name" span><input value={v.name} onChange={set("name")} required maxLength={200} placeholder="e.g. Delhi South (Saket)" /></Field>
        <Field label="City"><input value={v.city} onChange={set("city")} required maxLength={60} /></Field>
        <Field label="State"><input value={v.state} onChange={set("state")} maxLength={60} /></Field>
        <Field label="Region"><input value={v.region} onChange={set("region")} maxLength={60} placeholder="e.g. North" /></Field>
        <Field label="Format"><input value={v.franchise_type} onChange={set("franchise_type")} maxLength={50} placeholder="e.g. QSR" /></Field>
        <Field label="Population">{num("population", { min: 0, step: 1 })}</Field>
        <Field label="Latitude">{num("latitude", { min: -90, max: 90, step: "any" })}</Field>
        <Field label="Longitude">{num("longitude", { min: -180, max: 180, step: "any" })}</Field>
        <div className="span muted" style={{ fontSize: 13 }}>Scores run 0 to 100. Fill all four to {territory === "new" ? "work out" : "recalculate"} the opportunity score; higher competition lowers it.</div>
        {INDICES.map(([k, name]) => <Field key={k} label={name}>{num(k, { min: 0, max: 100, step: 1 })}</Field>)}
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}
