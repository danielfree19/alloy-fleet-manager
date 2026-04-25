import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { PipelineForm, type PipelineFormValue } from "@/components/PipelineForm";
import { createPipeline } from "@/api/pipelines";
import { getCatalogTemplate } from "@/api/catalog";
import { ApiError } from "@/api/client";
import { toast } from "@/store/toasts";
import { invalidateCache } from "@/store/cache";
import { PIPELINES_CACHE_KEY } from "@/pages/Pipelines";
import type { CatalogTemplate } from "@/api/types";

const EMPTY: PipelineFormValue = {
  name: "",
  selector: {},
  enabled: true,
  content: "",
};

export function PipelineNew() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const templateId = params.get("from_template");

  const [initial, setInitial] = useState<PipelineFormValue | null>(null);
  const [template, setTemplate] = useState<CatalogTemplate | null>(null);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    if (!templateId) {
      setInitial(EMPTY);
      return;
    }
    setLoadingTemplate(true);
    setTemplateError(null);
    getCatalogTemplate(templateId)
      .then((t) => {
        setTemplate(t);
        // Suggested name falls back to `id` if the template author
        // didn't override it. Selector and content come straight from
        // the template — the user is free to edit them before saving.
        setInitial({
          name: t.suggested_name ?? t.id,
          selector: { ...t.default_selector },
          enabled: true,
          content: t.content,
        });
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof ApiError
            ? `${err.message} (HTTP ${err.status})`
            : err instanceof Error
              ? err.message
              : "Unknown error";
        setTemplateError(msg);
        // Fall back to an empty form so the user isn't stuck if the
        // template URL is stale.
        setInitial(EMPTY);
      })
      .finally(() => setLoadingTemplate(false));
  }, [templateId]);

  async function onSubmit(v: PipelineFormValue) {
    setSubmitting(true);
    setApiError(null);
    try {
      const p = await createPipeline(v);
      invalidateCache(PIPELINES_CACHE_KEY);
      // Inline error banner stays for hard failures; success is
      // surfaced via a toast since the user has just been navigated
      // away from the form they were standing on.
      toast.success(
        `Pipeline "${p.name}" created`,
        template ? `Installed from template "${template.name}".` : undefined,
      );
      navigate(`/pipelines/${p.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setApiError(`${err.message} (HTTP ${err.status})`);
      } else if (err instanceof Error) {
        setApiError(err.message);
      } else {
        setApiError("Unknown error");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        title={template ? `New pipeline from "${template.name}"` : "New pipeline"}
        subtitle={
          template
            ? "The form is pre-filled from the selected template. Edit any field before saving."
            : "Define a reusable fragment of Alloy config that matching collectors will pull on their next poll."
        }
        actions={
          !template && (
            <Link to="/catalog" className="btn">
              Browse catalog
            </Link>
          )
        }
      />

      {template && (
        <div className="card p-4 mb-6 text-sm flex items-start gap-3">
          <div className="grow">
            <div className="font-medium">Template: {template.name}</div>
            <div className="text-muted mt-1">{template.description}</div>
            {template.requires.length > 0 && (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-muted hover:text-text">
                  Prerequisites ({template.requires.length})
                </summary>
                <ul className="mt-1.5 list-disc ml-4 text-text/70 space-y-1">
                  {template.requires.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          {template.docs_url && (
            <a
              href={template.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
            >
              Docs
            </a>
          )}
        </div>
      )}

      {templateError && (
        <div className="card border-warn/40 p-4 text-sm text-warn mb-6">
          Couldn't load template <span className="font-mono">{templateId}</span>:{" "}
          {templateError}. Starting with an empty form.
        </div>
      )}

      {apiError && (
        <div className="card border-danger/40 p-4 text-sm text-danger mb-6">
          {apiError}
        </div>
      )}

      {loadingTemplate || initial === null ? (
        <div className="card p-10 text-center text-sm text-muted">Loading template…</div>
      ) : (
        <PipelineForm
          initial={initial}
          submitting={submitting}
          submitLabel="Create pipeline"
          onSubmit={onSubmit}
          onCancel={() => navigate("/pipelines")}
        />
      )}
    </>
  );
}
