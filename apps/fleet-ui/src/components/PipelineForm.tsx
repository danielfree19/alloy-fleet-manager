import { useReducer } from "react";
import { SelectorEditor } from "@/components/SelectorEditor";
import { validatePipelineContent, type ValidateResult } from "@/api/pipelines";
import { ApiError } from "@/api/client";
import type { Labels } from "@/api/types";

/**
 * Shared form used by both the "new pipeline" and "edit pipeline" pages. We
 * keep a single source of truth for the shape of the form so validation /
 * layout stays in sync across the two screens.
 */
export interface PipelineFormValue {
  name: string;
  selector: Labels;
  enabled: boolean;
  content: string;
}

/**
 * Form state lives in a useReducer rather than seven separate useStates.
 * Reasoning:
 *   - Local to this component (dies on unmount), so a global store
 *     (Zustand etc.) would be the wrong abstraction — it'd cause stale
 *     values to leak across navigations.
 *   - Multiple fields are mutated together (handleValidate clears
 *     `error` AND `validation`, then sets `validating`). A reducer makes
 *     those transitions atomic and explicit instead of a sequence of
 *     unrelated setters that React happens to batch.
 *   - All transitions are described as `Action`s, which is far easier
 *     to reason about than sprinkled `setX(...)` calls.
 */
interface FormState {
  // user-editable fields (the value we POST/PATCH)
  name: string;
  selector: Labels;
  enabled: boolean;
  content: string;
  // ephemeral UI state
  error: string | null;
  validation: ValidateResult | null;
  validating: boolean;
}

type Action =
  | { type: "field"; patch: Partial<Pick<FormState, "name" | "selector" | "enabled" | "content">> }
  | { type: "error"; message: string | null }
  | { type: "validate_start" }
  | { type: "validate_done"; result: ValidateResult }
  | { type: "validate_failed"; message: string };

function reducer(state: FormState, action: Action): FormState {
  switch (action.type) {
    case "field":
      return { ...state, ...action.patch };
    case "error":
      return { ...state, error: action.message };
    case "validate_start":
      // Starting a new validation invalidates the previous result and
      // any error from the previous attempt. Done in one atomic update
      // so the UI never flickers an old result while validating.
      return { ...state, error: null, validation: null, validating: true };
    case "validate_done":
      return { ...state, validating: false, validation: action.result };
    case "validate_failed":
      return { ...state, validating: false, error: action.message };
    default:
      return state;
  }
}

function init(initial: PipelineFormValue): FormState {
  return {
    name: initial.name,
    selector: initial.selector,
    enabled: initial.enabled,
    content: initial.content,
    error: null,
    validation: null,
    validating: false,
  };
}

export function PipelineForm({
  initial,
  submitting,
  submitLabel,
  disableName = false,
  onSubmit,
  onCancel,
}: {
  initial: PipelineFormValue;
  submitting: boolean;
  submitLabel: string;
  disableName?: boolean;
  onSubmit: (v: PipelineFormValue) => void;
  onCancel: () => void;
}) {
  const [state, dispatch] = useReducer(reducer, initial, init);
  const { name, selector, enabled, content, error, validation, validating } = state;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return dispatch({ type: "error", message: "Name is required." });
    if (!content.trim()) return dispatch({ type: "error", message: "Content is required." });
    dispatch({ type: "error", message: null });
    onSubmit({ name: name.trim(), selector, enabled, content });
  }

  async function handleValidate() {
    if (!content.trim()) {
      dispatch({ type: "error", message: "Content is required." });
      return;
    }
    dispatch({ type: "validate_start" });
    try {
      const r = await validatePipelineContent(content);
      dispatch({ type: "validate_done", result: r });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.message} (HTTP ${err.status})`
          : err instanceof Error
            ? err.message
            : "Unknown validation error";
      dispatch({ type: "validate_failed", message: msg });
    }
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <section className="card p-5 md:col-span-1">
          <h2 className="text-sm font-semibold mb-3">Metadata</h2>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-muted block mb-1">Name</label>
              <input
                className="input"
                value={name}
                onChange={(e) => dispatch({ type: "field", patch: { name: e.target.value } })}
                placeholder="edge-metrics"
                disabled={disableName}
              />
              {disableName && (
                <p className="text-[11px] text-muted mt-1">
                  Names are immutable. Create a new pipeline to rename.
                </p>
              )}
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">State</label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) =>
                    dispatch({ type: "field", patch: { enabled: e.target.checked } })
                  }
                />
                <span>Enabled (delivered to matching collectors)</span>
              </label>
            </div>
          </div>
        </section>

        <section className="card p-5 md:col-span-2">
          <h2 className="text-sm font-semibold mb-1">Selector</h2>
          <p className="text-xs text-muted mb-3">
            Match collectors whose <code className="mono">local_attributes</code>{" "}
            contain every label below. Empty selector = applies to everyone.
          </p>
          <SelectorEditor
            value={selector}
            onChange={(next) => dispatch({ type: "field", patch: { selector: next } })}
          />
        </section>
      </div>

      <section className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold">Alloy config fragment</h2>
            <p className="text-xs text-muted mt-1">
              Raw Alloy river content. Do <strong>not</strong> include root-level
              blocks like <code className="mono">logging</code>,{" "}
              <code className="mono">tracing</code>, or{" "}
              <code className="mono">remotecfg</code> — those belong in the
              bootstrap config, not in remote-delivered modules.
            </p>
          </div>
        </div>
        <textarea
          className="input mono text-xs min-h-[360px] resize-y"
          value={content}
          onChange={(e) => dispatch({ type: "field", patch: { content: e.target.value } })}
          placeholder={`prometheus.exporter.unix "default" { }\n\nprometheus.scrape "node" {\n  targets    = prometheus.exporter.unix.default.targets\n  forward_to = [prometheus.remote_write.sink.receiver]\n}`}
          spellCheck={false}
        />
      </section>

      {error && <div className="text-sm text-danger">{error}</div>}

      {validation && (
        <div
          className={`card p-4 text-sm ${
            validation.valid
              ? "border-ok/40 bg-ok/5 text-ok"
              : "border-danger/40 bg-danger/5 text-danger"
          }`}
        >
          <div className="font-medium mb-1">
            {validation.valid ? "Valid" : "Invalid"}{" "}
            <span className="text-xs text-muted">
              (engine: {validation.engine ?? "unknown"})
            </span>
          </div>
          {validation.errors.length > 0 && (
            <ul className="mono text-[11px] leading-relaxed list-disc list-inside space-y-0.5">
              {validation.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleValidate}
          disabled={validating || submitting}
        >
          {validating ? "Validating…" : "Validate"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
