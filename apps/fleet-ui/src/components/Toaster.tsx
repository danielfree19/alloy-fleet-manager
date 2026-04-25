/**
 * Floating toast viewport. Renders the active toasts from the store
 * stacked in the bottom-right; auto-dismiss is handled inside the
 * store, so this component is purely presentational.
 *
 * Mounted once at the root (in App.tsx) — multiple `<Toaster />`
 * instances would duplicate the rendered toasts, so we treat it as a
 * singleton by convention.
 */
import { useToastStore, type Toast, type ToastTone } from "@/store/toasts";

const TONE_STYLES: Record<ToastTone, string> = {
  success: "border-ok/40 bg-ok/10 text-ok",
  info: "border-accent/40 bg-accent-soft text-accent",
  warn: "border-warn/40 bg-warn/10 text-warn",
  error: "border-danger/40 bg-danger/10 text-danger",
};

const TONE_LABEL: Record<ToastTone, string> = {
  success: "Success",
  info: "Info",
  warn: "Warning",
  error: "Error",
};

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  return (
    <div
      role={toast.tone === "error" || toast.tone === "warn" ? "alert" : "status"}
      className={`pointer-events-auto card border ${TONE_STYLES[toast.tone]} px-4 py-3 shadow-lg flex items-start gap-3 animate-in fade-in slide-in-from-right-2`}
    >
      <div className="grow min-w-0">
        <div className="text-[11px] uppercase tracking-wider opacity-70 font-medium">
          {TONE_LABEL[toast.tone]}
        </div>
        <div className="text-sm font-medium leading-tight mt-0.5">{toast.title}</div>
        {toast.description && (
          <div className="text-xs text-text/70 mt-1 break-words">
            {toast.description}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-xs opacity-60 hover:opacity-100 transition shrink-0"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
