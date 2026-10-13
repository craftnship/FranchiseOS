import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, Row } from "../api";
import { useLoad } from "../hooks";
import { INDIA_STATES, INDIA_VIEWBOX } from "./indiaMap";
import { label, Loaded, Panel } from "./ui";

// The network on a map of India: open stores, openings in progress and territories not yet taken.
// The state shapes are a Mercator projection fitted to India's extremes (68.18°E to 97.42°E, 37.08°N
// to 8.08°N), so a point lands within a few kilometres of where it is.

const W = 612, H = 696;
const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const TOP = merc(37.08), BOTTOM = merc(8.08);
export const project = (lat: number, lng: number): [number, number] => [((lng - 68.18) / 29.24) * 611.9, ((TOP - merc(lat)) / (TOP - BOTTOM)) * 667.8];

type Kind = "store" | "opening" | "territory";
const KINDS: [Kind, string][] = [["store", "Open stores"], ["opening", "Openings in progress"], ["territory", "Open territories"]];
const toneOf = (p: Row) => (p.kind === "store" ? "store" : p.kind === "opening" ? `opening ${String(p.status).toLowerCase()}` : `territory ${String(p.status).toLowerCase()}`);

export default function NetworkMap() {
  const load = useLoad(() => api<Row>("GET", "/dashboard/map"), []);
  const nav = useNavigate();
  const [shown, setShown] = useState<Record<Kind, boolean>>({ store: true, opening: true, territory: true });
  const [hover, setHover] = useState<Row | null>(null);
  const [all, setAll] = useState(false);
  const pts: Row[] = useMemo(() => (load.data?.points ?? []).map((p: Row) => ({ ...p, xy: project(p.lat, p.lng) })), [load.data]);
  const visible = pts.filter((p) => shown[p.kind as Kind]);

  // Zoom to the network with some margin, keeping the map's shape; "All India" shows the whole country.
  const view = useMemo(() => {
    if (all || !pts.length) return INDIA_VIEWBOX;
    const xs = pts.map((p) => p.xy[0]), ys = pts.map((p) => p.xy[1]);
    let [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 40;
    let w = Math.max(x1 - x0 + pad * 2, 220), h = Math.max(y1 - y0 + pad * 2, 220);
    if (w / h > W / H) h = w * (H / W); else w = h * (W / H);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    x0 = Math.max(0, Math.min(W - w, cx - w / 2)); y0 = Math.max(0, Math.min(H - h, cy - h / 2));
    return `${x0.toFixed(1)} ${y0.toFixed(1)} ${Math.min(w, W).toFixed(1)} ${Math.min(h, H).toFixed(1)}`;
  }, [pts, all]);
  const scale = Number(view.split(" ")[2]) / W;
  const r = Math.max(2.2, 7 * scale);
  const withStores = new Set(pts.filter((p) => p.kind === "store").map((p) => String(p.state ?? "").toLowerCase()));
  const totals = load.data?.totals;

  return (
    <div className="row c21">
      <Panel title="Network map" action={<span className="map-actions">
        {KINDS.map(([k, l]) => (
          <label key={k} className={`map-toggle ${k}`}><input type="checkbox" checked={shown[k]} onChange={(e) => setShown({ ...shown, [k]: e.target.checked })} /><i />{l}{totals ? ` ${totals[k === "store" ? "stores" : k === "opening" ? "openings" : "territories"]}` : ""}</label>
        ))}
        <button type="button" className="btn ghost sm" onClick={() => setAll(!all)}>{all ? "Zoom to network" : "All India"}</button>
      </span>}>
        <Loaded load={load} empty={(d) => !d.points.length} emptyText="No store, opening or territory has a location yet.">{(d) => (
          <div className="network-map" onMouseLeave={() => setHover(null)}>
            <svg viewBox={view} role="img" aria-label={`Map of India with ${d.totals.stores} open stores, ${d.totals.openings} openings and ${d.totals.territories} open territories`}>
              {INDIA_STATES.map((s) => <path key={s.id} d={s.d} className={withStores.has(s.name.toLowerCase()) ? "state has" : "state"} strokeWidth={0.8 * scale}><title>{s.name}</title></path>)}
              {visible.filter((p) => p.kind === "territory").concat(visible.filter((p) => p.kind === "opening"), visible.filter((p) => p.kind === "store")).map((p) => (
                <circle key={`${p.kind}${p.id}`} cx={p.xy[0]} cy={p.xy[1]} r={p.kind === "territory" ? r * 0.8 : r} className={`pt ${toneOf(p)} ${hover === p ? "on" : ""}`} strokeWidth={1.4 * scale}
                  tabIndex={0} onMouseEnter={() => setHover(p)} onFocus={() => setHover(p)} onClick={() => nav(p.href)} onKeyDown={(e) => e.key === "Enter" && nav(p.href)} />
              ))}
            </svg>
            {hover && (() => {
              const [vx, vy, vw, vh] = view.split(" ").map(Number);
              const left = ((hover.xy[0] - vx) / vw) * 100, top = ((hover.xy[1] - vy) / vh) * 100;
              return (
                <div className="map-tip" style={{ left: `${left}%`, top: `${top}%` }}>
                  <strong>{hover.name}</strong>
                  <span>{hover.kind === "store" ? "Open store" : hover.kind === "opening" ? `Opening · readiness ${label(hover.status)}` : `Territory · ${label(hover.status)}`}</span>
                  {hover.detail && <span className="muted">{hover.detail}</span>}
                  {hover.located === "city" && <span className="muted">Placed at the city centre</span>}
                </div>
              );
            })()}
            <div className="map-key" aria-hidden="true">
              <span><i className="pt store" />Open store</span>
              <span><i className="pt opening green" />Opening on pace</span>
              <span><i className="pt opening amber" />Opening behind</span>
              <span><i className="pt opening red" />Opening at risk</span>
              <span><i className="pt territory available" />Territory available</span>
              <span><i className="pt territory reserved" />Reserved</span>
              <span><i className="pt territory allocated" />Allocated</span>
            </div>
            <p className="muted small map-credit">Map: <a href="https://github.com/VictorCazanave/svg-maps" target="_blank" rel="noreferrer">MapSVG / Victor Cazanave</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></p>
            {d.unplaced.length > 0 && <p className="muted small map-note">{d.unplaced.length} without a location: {d.unplaced.slice(0, 4).map((u: Row) => u.name).join(", ")}{d.unplaced.length > 4 ? "…" : ""}</p>}
          </div>
        )}</Loaded>
      </Panel>

      <Panel title="By state" flush>
        <Loaded load={load} empty={(d) => !d.by_state.length} emptyText="Nothing on the map yet.">{(d) => (
          <table className="grid state-table">
            <thead><tr><th>State</th><th className="num">Stores</th><th className="num">Openings</th><th className="num">Territories</th></tr></thead>
            <tbody>
              {d.by_state.map((s: Row) => (
                <tr key={s.state}><td>{s.state}</td><td className="num">{s.stores || "—"}</td><td className="num">{s.openings || "—"}</td><td className="num"><Link to="/territories">{s.territories || "—"}</Link></td></tr>
              ))}
            </tbody>
          </table>
        )}</Loaded>
      </Panel>
    </div>
  );
}
