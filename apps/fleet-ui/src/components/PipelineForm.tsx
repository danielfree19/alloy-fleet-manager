import { useState } from "react";
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
  const [name, setName] = useState(initial.name);
  const [selector, setSelector] = useState<Labels>(initial.selector);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [content, setContent] = useState(initial.content);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [validating, setValidating] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Name is required.");
    if (!content.trim()) return setError("Content is required.");
    onSubmit({ name: name.trim(), selector, enabled, content });
  }

  async function handleValidate() {
    setError(null);
    setValidation(null);
    if (!content.trim()) {
      setError("Content is required.");
      return;
    }
    setValidating(true);
    try {
      const r = await validatePipelineContent(content);
      setValidation(r);
    } catch (err) {
      if (err instanceof ApiError) setError(`${err.message} (HTTP ${err.status})`);
      else if (err instanceof Error) setError(err.message);
      else setError("Unknown validation error");
    } finally {
      setValidating(false);
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
                onChange={(e) => setName(e.target.value)}
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
                  onChange={(e) => setEnabled(e.target.checked)}
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
          <SelectorEditor value={selector} onChange={setSelector} />
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
          onChange={(e) => setContent(e.target.value)}
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
              {validation.errors.map((e, i) => (
                <li key={i}>{e}</li>
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
