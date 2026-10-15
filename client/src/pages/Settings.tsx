import { CSSProperties, useEffect, useState } from "react";
import { api } from "../api";
import { Brand, BrandMark, DEFAULT_BRAND, useBrand } from "../branding";
import { useAction } from "../hooks";
import { Field, Form, FormError } from "../components/forms";
import { Icon, PageHeader, Panel } from "../components/ui";
import { upload } from "../components/Construction";
import { HealthSettings } from "../components/Health";
import { RoyaltySettings } from "../components/Pos";
import { CollectionsSettings } from "../components/Collections";

// Admin → Settings. Branding: the company name, logo and colour shown in place of FranchiseOS
// in the app, the franchisee portal, the sign-in screen, the browser tab and notification emails.
// Store setup: the default format, the roles a store hires and the training each role takes.

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];

export function Settings() {
  const { brand, reload } = useBrand();
  const act = useAction();
  const [name, setName] = useState(brand.name === DEFAULT_BRAND.name ? "" : brand.name);
  const [tagline, setTagline] = useState(brand.tagline ?? "");
  const [color, setColor] = useState(brand.color ?? "");
  // undefined keeps the saved logo, null removes it, a File replaces it.
  const [logo, setLogo] = useState<File | null | undefined>(undefined);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!(logo instanceof File)) { setPreview(null); return; }
    const url = URL.createObjectURL(logo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [logo]);

  const pick = (f: File | undefined) => {
    setFileError(null);
    if (!f) return;
    if (!LOGO_TYPES.includes(f.type)) { setFileError("Use a PNG, JPG or WebP image."); return; }
    if (f.size > 1024 * 1024) { setFileError("The logo can be up to 1 MB."); return; }
    setLogo(f);
  };

  const shown: Brand = {
    name: name.trim() || DEFAULT_BRAND.name,
    tagline: tagline.trim() || null,
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : null,
    logo_url: logo === null ? null : preview ?? brand.logo_url,
  };

  const save = async () => {
    const body: Record<string, unknown> = { name: name.trim() || null, tagline: tagline.trim() || null, color: color.trim() || null };
    if (logo !== undefined) body.logo = logo ? await upload(logo) : null;
    const r = await act.run("save", () => api<Brand>("PUT", "/settings/branding", { body }), "Saved. Everyone sees the new branding the next time a page loads.");
    if (r) { setLogo(undefined); reload(); }
  };

  return (
    <>
      <PageHeader title="Settings" crumbs={[["Admin"], ["Settings"]]} subtitle="How the app looks to your team and your franchisees." />
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <Panel title="Branding">
        <div className="brand-preview" style={{ marginBottom: "1.25rem", ...(shown.color ? { "--accent": shown.color } : {}) } as CSSProperties}>
          <BrandMark brand={shown} />
          <span><strong>{shown.name}</strong><small>{shown.tagline ?? "Expansion & openings"}</small></span>
        </div>
        <Form onSubmit={save} footer={<button className="btn" disabled={!!act.busy || !!fileError}>{act.busy ? "Saving…" : "Save branding"}</button>}>
          <Field label="Company name" hint="Shown in the sidebar, the sign-in screen, the browser tab and emails. Leave empty for FranchiseOS.">
            <input value={name} maxLength={60} placeholder="FranchiseOS" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Tagline" hint="The line under the name for your team. Franchisees see “Franchisee portal”.">
            <input value={tagline} maxLength={60} placeholder="Expansion & openings" onChange={(e) => setTagline(e.target.value)} />
          </Field>
          <Field label="Logo" span error={fileError ?? undefined} hint="A square PNG, JPG or WebP up to 1 MB works best. It's also the browser tab icon.">
            <span className="logo-field">
              <input type="file" accept={LOGO_TYPES.join(",")} onChange={(e) => pick(e.target.files?.[0])} />
              {(logo instanceof File || (logo === undefined && brand.logo_url)) && <button type="button" className="btn ghost sm" onClick={() => setLogo(null)}>Remove logo</button>}
              {logo === null && brand.logo_url && <button type="button" className="btn ghost sm" onClick={() => setLogo(undefined)}>Keep current logo</button>}
            </span>
          </Field>
          <Field label="Brand colour" hint="Buttons, links and highlights. Leave empty for the default blue.">
            <span className="color-field">
              <input type="color" value={shown.color ?? "#2f5bea"} onChange={(e) => setColor(e.target.value)} aria-label="Pick a colour" />
              <input value={color} placeholder="#2f5bea" maxLength={7} onChange={(e) => setColor(e.target.value)} />
            </span>
          </Field>
          <div className="span"><FormError error={act.error} /></div>
        </Form>
      </Panel>
      <p className="muted">“Continue to sign in” opens Zoho Catalyst's own sign-in page. Its logo and title are set in the Catalyst console's Authentication settings.</p>
      <DemoLink />
      <StoreSetup />
      <RoyaltySettings />
      <CollectionsSettings />
      <HealthSettings />
    </>
  );
}

interface DemoState { active: boolean; token: string | null; expires_on: string | null; created_at: string | null }

/** One read-only link that opens the app without a sign-in, for showing the product around. */
function DemoLink() {
  const act = useAction();
  const [d, setD] = useState<DemoState | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api<DemoState>("GET", "/settings/demo-link").then(setD).catch(() => setD(null)); }, []);
  if (!d) return null;
  const url = d.token ? `${window.location.origin}${window.location.pathname}?demo=${encodeURIComponent(d.token)}` : null;
  const create = async () => { const r = await act.run("create", () => api<DemoState>("POST", "/settings/demo-link", { body: { days: 30 } }), d.active ? "New link created. The old one has stopped working." : "Link created. Anyone with it can look around for 30 days."); if (r) setD(r); };
  const revoke = async () => { const r = await act.run("revoke", () => api<DemoState>("DELETE", "/settings/demo-link"), "The demo link is off."); if (r) setD(r); };
  const copy = async () => { if (!url) return; try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the field is selectable */ } };
  return (
    <Panel title="Demo link">
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <p className="field-hint" style={{ margin: "0 0 .75rem" }}>
        Anyone with the link sees the team's screens as a read-only visitor, without a sign-in. Changes are disabled, contact details are masked, Admin is hidden and nothing reaches Zoho. Create a new link or turn it off at any time.
      </p>
      {url ? (
        <>
          <div className="demo-link-box">
            <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Demo link" />
            <button type="button" className="btn sm" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
          </div>
          <p className="field-hint" style={{ margin: ".5rem 0 .75rem" }}>Works until {d.expires_on}.</p>
          <div className="demo-link-box">
            <button type="button" className="btn ghost sm" disabled={!!act.busy} onClick={create}>{act.busy === "create" ? "Creating…" : "Replace with a new link"}</button>
            <button type="button" className="btn ghost sm" disabled={!!act.busy} onClick={revoke}>{act.busy === "revoke" ? "Turning off…" : "Turn off"}</button>
          </div>
        </>
      ) : (
        <button type="button" className="btn sm" disabled={!!act.busy} onClick={create}>{act.busy ? "Creating…" : "Create a 30-day link"}</button>
      )}
      <FormError error={act.error} />
    </Panel>
  );
}

interface RoleRow { code: string; name: string; plural: string; default_count: number }
interface ModuleRow { code: string; name: string; roles: string[]; certificate?: boolean }
interface Setup { default_franchise_type: string; franchise_types: string[]; staff_roles: RoleRow[]; training_modules: ModuleRow[] }

/** A code from a name: "Service advisor" → SERVICE_ADVISOR. */
const codeOf = (name: string, taken: string[]) => {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "R_$1").slice(0, 36) || "ITEM";
  let c = base.length < 2 ? `${base}_X` : base, i = 2;
  while (taken.includes(c)) c = `${base}_${i++}`;
  return c;
};

/** The format new franchisees get, the roles a store hires and the training each role takes. */
function StoreSetup() {
  const act = useAction();
  const [s, setS] = useState<Setup | null>(null);
  useEffect(() => { api<Setup>("GET", "/settings/store-setup").then(setS).catch(() => setS(null)); }, []);
  if (!s) return null;
  const roles = s.staff_roles, mods = s.training_modules;
  const setRole = (i: number, k: keyof RoleRow, v: string) => setS({ ...s, staff_roles: roles.map((r, j) => (j === i ? { ...r, [k]: k === "default_count" ? Number(v) : v } : r)) });
  const setMod = (i: number, patch: Partial<ModuleRow>) => setS({ ...s, training_modules: mods.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const addRole = () => setS({ ...s, staff_roles: [...roles, { code: "", name: "", plural: "", default_count: 1 }] });
  const addMod = () => setS({ ...s, training_modules: [...mods, { code: "", name: "", roles: roles.map((r) => r.code).filter(Boolean), certificate: false }] });
  const save = async () => {
    const taken = roles.map((r) => r.code).filter(Boolean);
    const staff_roles = roles.filter((r) => r.name.trim()).map((r) => { const code = r.code || codeOf(r.name, taken); taken.push(code); return { code, name: r.name.trim(), plural: r.plural.trim() || r.name.trim(), default_count: r.default_count || 0 }; });
    const mtaken = mods.map((m) => m.code).filter(Boolean);
    const training_modules = mods.filter((m) => m.name.trim()).map((m) => { const code = m.code || codeOf(m.name, mtaken); mtaken.push(code); return { code, name: m.name.trim(), roles: m.roles.filter((r) => staff_roles.some((x) => x.code === r)), certificate: !!m.certificate }; });
    const r = await act.run("setup", () => api<Setup>("PUT", "/settings/store-setup", { body: { default_franchise_type: s.default_franchise_type.trim(), staff_roles, training_modules } }), "Saved.");
    if (r) setS(r);
  };
  return (
    <Panel title="Store setup">
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <Form onSubmit={save} footer={<button className="btn" disabled={!!act.busy || !s.default_franchise_type.trim()}>{act.busy ? "Saving…" : "Save store setup"}</button>}>
        <Field label="Default format" hint="New franchisees and CRM leads without a format get this one, so they pick up its templates.">
          <input list="fos-formats" value={s.default_franchise_type} maxLength={50} onChange={(e) => setS({ ...s, default_franchise_type: e.target.value })} />
          <datalist id="fos-formats">{s.franchise_types.map((t) => <option key={t} value={t} />)}</datalist>
        </Field>
        <div className="span">
          <div className="field-label">Store roles</div>
          <p className="field-hint" style={{ margin: "0 0 .5rem" }}>The people a store hires, with how many a new store needs. The first role is the manager the “hire manager” task waits for.</p>
          <div className="setup-rows">
            {roles.map((r, i) => (
              <div key={i} className="setup-row">
                <input aria-label="Role" placeholder="Role, e.g. Service advisor" value={r.name} maxLength={60} onChange={(e) => setRole(i, "name", e.target.value)} />
                <input aria-label="Plural" placeholder="Plural" value={r.plural} maxLength={60} onChange={(e) => setRole(i, "plural", e.target.value)} />
                <input aria-label="People per store" type="number" min={0} max={100} value={r.default_count} onChange={(e) => setRole(i, "default_count", e.target.value)} />
                <button type="button" className="btn ghost sm" disabled={roles.length < 2} onClick={() => setS({ ...s, staff_roles: roles.filter((_, j) => j !== i), training_modules: mods.map((m) => ({ ...m, roles: m.roles.filter((x) => x !== r.code) })) })}>Remove</button>
              </div>
            ))}
          </div>
          <button type="button" className="btn ghost sm" onClick={addRole}>Add role</button>
        </div>
        <div className="span">
          <div className="field-label">Training modules</div>
          <p className="field-hint" style={{ margin: "0 0 .5rem" }}>What each role completes before opening. Tick “Certificate” when the franchisee must attach one.</p>
          <div className="setup-rows">
            {mods.map((m, i) => (
              <div key={i} className="setup-row module">
                <input aria-label="Module" placeholder="Module, e.g. High-voltage safety" value={m.name} maxLength={100} onChange={(e) => setMod(i, { name: e.target.value })} />
                <span className="setup-checks">
                  {roles.filter((r) => r.code).map((r) => (
                    <label key={r.code}><input type="checkbox" checked={m.roles.includes(r.code)} onChange={(e) => setMod(i, { roles: e.target.checked ? [...m.roles, r.code] : m.roles.filter((x) => x !== r.code) })} />{r.name}</label>
                  ))}
                  <label><input type="checkbox" checked={!!m.certificate} onChange={(e) => setMod(i, { certificate: e.target.checked })} />Certificate</label>
                </span>
                <button type="button" className="btn ghost sm" disabled={mods.length < 2} onClick={() => setS({ ...s, training_modules: mods.filter((_, j) => j !== i) })}>Remove</button>
              </div>
            ))}
          </div>
          <button type="button" className="btn ghost sm" onClick={addMod}>Add module</button>
        </div>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Panel>
  );
}
