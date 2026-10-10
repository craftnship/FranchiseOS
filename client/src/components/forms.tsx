import { FormEvent, ReactNode, useEffect, useState } from "react";
import { ApiError } from "../api";
import { Icon, label } from "./ui";

/** Modal for a focused action: a form, a confirmation, or a decision with comments. Escape closes it. */
export function Dialog({ title, subtitle, onClose, children, wide }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    // Clicks stay inside the dialog, so a dialog opened from a clickable table row never opens the row.
    <div className="dialog-scrim" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <header><div><h2>{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</div><button className="icon-btn" onClick={onClose} aria-label="Close">×</button></header>
        {children}
      </div>
    </div>
  );
}

/** A form whose submit runs `onSubmit`; the footer holds its buttons. */
export function Form({ onSubmit, children, footer }: { onSubmit: () => void; children: ReactNode; footer: ReactNode }) {
  const submit = (e: FormEvent) => { e.preventDefault(); onSubmit(); };
  return <form onSubmit={submit}><div className="form-body">{children}</div><footer className="form-foot">{footer}</footer></form>;
}

export function Field({ label: text, hint, error, children, span }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; span?: boolean }) {
  return (
    <label className={`field ${span ? "span" : ""} ${error ? "invalid" : ""}`}>
      <span className="field-label">{text}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/** API error with the per-field reasons the server returned. */
export function FormError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const fields = Object.entries(error.fields ?? {});
  return (
    <div className="notice bad"><Icon name="alert" />
      <span>{error.message}{fields.length > 0 && <> ({fields.map(([k, v]) => `${label(k)}: ${v}`).join("; ")})</>}</span>
    </div>
  );
}

/** Form state for string inputs; `num` reads a field as a number, or undefined when blank. */
export function useFields<T extends Record<string, string>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const bind = (k: keyof T) => ({ value: values[k], onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value })) });
  const num = (k: keyof T) => (values[k] === "" ? undefined : Number(values[k]));
  const text = (k: keyof T) => (values[k].trim() === "" ? undefined : values[k].trim());
  return { values, setValues, bind, num, text };
}

/** Confirmation with an optional or required comment, for decisions like reject or withdraw. */
export function ConfirmDialog({ title, body, confirm, danger, comment, busy, error, onConfirm, onClose }: {
  title: string; body?: ReactNode; confirm: string; danger?: boolean; comment?: "optional" | "required"; busy?: boolean; error?: ApiError | null;
  onConfirm: (comment: string) => void; onClose: () => void;
}) {
  const [text, setText] = useState("");
  const missing = comment === "required" && !text.trim();
  return (
    <Dialog title={title} onClose={onClose}>
      <Form onSubmit={() => !missing && onConfirm(text.trim())} footer={<>
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className={`btn ${danger ? "danger" : ""}`} disabled={busy || missing}>{busy ? "Working…" : confirm}</button>
      </>}>
        {body && <div className="span">{body}</div>}
        {comment && <Field label={comment === "required" ? "Comment (required)" : "Comment"} span><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus /></Field>}
        <div className="span"><FormError error={error ?? null} /></div>
      </Form>
    </Dialog>
  );
}
