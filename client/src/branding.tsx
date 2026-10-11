import { createContext, useContext, useEffect } from "react";

// The company name, logo and colour shown in place of FranchiseOS (Admin → Settings → Branding).

export interface Brand { name: string; tagline: string | null; color: string | null; logo_url: string | null }
export const DEFAULT_BRAND: Brand = { name: "FranchiseOS", tagline: null, color: null, logo_url: null };

export const BrandContext = createContext<{ brand: Brand; reload: () => void }>({ brand: DEFAULT_BRAND, reload: () => {} });
export const useBrand = () => useContext(BrandContext);

/** Browser tab title and icon, and the accent colour every button and link uses. */
export function useApplyBrand(brand: Brand) {
  useEffect(() => {
    document.title = brand.name;
    let icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (brand.logo_url) {
      if (!icon) { icon = document.createElement("link"); icon.rel = "icon"; document.head.appendChild(icon); }
      icon.href = brand.logo_url;
    } else icon?.remove();
    const root = document.documentElement.style;
    const vars: Record<string, string> = brand.color ? {
      "--accent": brand.color,
      "--accent-hover": `color-mix(in srgb, ${brand.color} 82%, #000)`,
      "--accent-weak": `color-mix(in srgb, ${brand.color} 12%, var(--surface))`,
      "--accent-text": `color-mix(in srgb, ${brand.color} 80%, var(--text))`,
    } : {};
    for (const k of ["--accent", "--accent-hover", "--accent-weak", "--accent-text"]) {
      if (vars[k]) root.setProperty(k, vars[k]); else root.removeProperty(k);
    }
  }, [brand.name, brand.color, brand.logo_url]);
}

/** The logo, or the name's first letter on the brand colour. */
export function BrandMark({ brand, className = "" }: { brand: Brand; className?: string }) {
  return brand.logo_url
    ? <img className={`brand-mark logo ${className}`} src={brand.logo_url} alt="" />
    : <span className={`brand-mark ${className}`}>{(brand.name.trim()[0] ?? "F").toUpperCase()}</span>;
}
