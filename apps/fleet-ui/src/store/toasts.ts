/**
 * Toast / notification store.
 *
 * Goal: a single global notifications stream so any handler — page,
 * modal, deeply-nested form — can surface success / error / info
 * messages without each page re-implementing its own banner. The
 * existing inline `<div className="card border-danger/40">` patterns
 * keep working; toasts are *additive*, not a replacement.
 *
 * Auto-dismiss: every toast carries an optional TTL. We register a
 * single `setTimeout` per toast and clean up on either timeout or
 * explicit dismiss. Errors default to `null` (sticky — the user must
 * acknowledge them); success/info default to 4 seconds.
 */
import { create } from "zustand";

export type ToastTone = "success" | "info" | "warn" | "error";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  /** ms until auto-dismiss; null means sticky (user must dismiss). */
  ttlMs: number | null;
}

interface ToastState {
  toasts: Toast[];
  /** Add a toast. Returns the toast id so callers can dismiss it later. */
  push: (t: Omit<Toast, "id" | "ttlMs"> & { ttlMs?: number | null }) => string;
  /** Convenience helpers — same as push() with a fixed tone. */
  success: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  warn: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  /** Manually dismiss a toast by id. No-op if already gone. */
  dismiss: (id: string) => void;
  /** Drop every active toast (useful around route changes if desired). */
  clear: () => void;
}

const DEFAULT_TTL: Record<ToastTone, number | null> = {
  success: 4000,
  info: 4000,
  warn: 6000,
  // Errors stay until the user acks them. Auto-hiding error toasts
  // hides bugs.
  error: null,
};

// Track auto-dismiss timers outside of the store so we don't bloat the
// state object with non-serializable handles. We never read these
// from React code.
const timers = new Map<string, ReturnType<typeof setTimeout>>();

let counter = 0;
function makeId(): string {
  counter += 1;
  // monotonically increasing + a coarse timestamp = collision-free
  // even under fast bursts; no crypto needed for UI ids.
  return `t${Date.now().toString(36)}-${counter}`;
}

export const useToastStore = create<ToastState>((set, get) => {
  function scheduleDismiss(id: string, ttlMs: number | null) {
    if (ttlMs === null) return;
    const handle = setTimeout(() => get().dismiss(id), ttlMs);
    timers.set(id, handle);
  }

  function clearTimer(id: string) {
    const h = timers.get(id);
    if (h !== undefined) {
      clearTimeout(h);
      timers.delete(id);
    }
  }

  function push(input: Omit<Toast, "id" | "ttlMs"> & { ttlMs?: number | null }): string {
    const id = makeId();
    const ttlMs = input.ttlMs === undefined ? DEFAULT_TTL[input.tone] : input.ttlMs;
    const toast: Toast = {
      id,
      tone: input.tone,
      title: input.title,
      description: input.description,
      ttlMs,
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    scheduleDismiss(id, ttlMs);
    return id;
  }

  return {
    toasts: [],
    push,
    success: (title, description) => push({ tone: "success", title, description }),
    info: (title, description) => push({ tone: "info", title, description }),
    warn: (title, description) => push({ tone: "warn", title, description }),
    error: (title, description) => push({ tone: "error", title, description }),
    dismiss: (id) => {
      clearTimer(id);
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
    clear: () => {
      for (const id of timers.keys()) clearTimer(id);
      set({ toasts: [] });
    },
  };
});

/**
 * Imperative accessors for code that runs outside React (e.g.
 * `apiFetch` retry logic). Components should use the hook directly.
 */
export const toast = {
  success: (title: string, description?: string) =>
    useToastStore.getState().success(title, description),
  info: (title: string, description?: string) =>
    useToastStore.getState().info(title, description),
  warn: (title: string, description?: string) =>
    useToastStore.getState().warn(title, description),
  error: (title: string, description?: string) =>
    useToastStore.getState().error(title, description),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};
