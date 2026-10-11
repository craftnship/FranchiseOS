import { CSSProperties, useEffect, useState } from "react";
import { api } from "../api";
import { Brand, BrandMark, DEFAULT_BRAND, useBrand } from "../branding";
import { useAction } from "../hooks";
import { Field, Form, FormError } from "../components/forms";
import { Icon, PageHeader, Panel } from "../components/ui";
import { upload } from "../components/Construction";

// Admin → Settings. Branding: the company name, logo and colour shown in place of FranchiseOS
// in the app, the franchisee portal, the sign-in screen, the browser tab and notification emails.

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
    </>
  );
}
