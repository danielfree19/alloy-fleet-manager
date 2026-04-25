import { useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { PageHeader } from "@/components/PageHeader";
import { PipelineForm, type PipelineFormValue } from "@/components/PipelineForm";
import { Pill } from "@/components/Pill";
import { Code } from "@/components/Code";
import { AuditEventList } from "@/components/AuditEventList";
import { listAuditEvents } from "@/api/audit";
import {
  deletePipeline,
  getPipeline,
  updatePipeline,
} from "@/api/pipelines";
import { ApiError } from "@/api/client";
import { relativeTime, shortHash } from "@/lib/format";
import type { PipelineDetail } from "@/api/types";

export function PipelineEdit() {
  const { id = "" } = useParams();
  const state = useAsync(() => getPipeline(id), [id]);

  return (
    <>
      <AsyncBoundary state={state}>
        {(data) => <PipelineEditBody detail={data} onSaved={state.reload} />}
      </AsyncBoundary>
    </>
  );
}

function PipelineEditBody({
  detail,
  onSaved,
}: {
  detail: PipelineDetail;
  onSaved: () => void;
}) {
  const { pipeline, versions } = detail;
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  async function onSubmit(v: PipelineFormValue) {
    setSubmitting(true);
    setApiError(null);
    try {
      await updatePipeline(pipeline.id, {
        selector: v.selector,
        enabled: v.enabled,
        content: v.content,
      });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) setApiError(`${err.message} (HTTP ${err.status})`);
      else if (err instanceof Error) setApiError(err.message);
      else setApiError("Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete() {
    const confirmed = window.confirm(
      `Delete pipeline "${pipeline.name}"? This cannot be undone, but its versions remain in pipeline_versions until garbage-collected.`,
    );
    if (!confirmed) return;
    try {
      await deletePipeline(pipeline.id);
      navigate("/pipelines");
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  return (
    <>
      <PageHeader
        title={pipeline.name}
        subtitle={`Version ${pipeline.current_version} · ${shortHash(pipeline.current_hash)} · updated ${relativeTime(pipeline.updated_at)}`}
        actions={
          <>
            <Link to="/pipelines" className="btn">
              ← Back
            </Link>
            <button className="btn btn-danger" onClick={onDelete}>
              Delete
            </button>
          </>
        }
      />
      {apiError && (
        <div className="card border-danger/40 p-4 text-sm text-danger mb-6">
          {apiError}
        </div>
      )}
      <PipelineForm
        initial={{
          name: pipeline.name,
          selector: pipeline.selector,
          enabled: pipeline.enabled,
          content: pipeline.current_content,
        }}
        submitting={submitting}
        submitLabel="Save new version"
        disableName
        onSubmit={onSubmit}
        onCancel={() => navigate("/pipelines")}
      />

      <section className="card p-5 mt-8">
        <h2 className="text-sm font-semibold mb-1">Version history</h2>
        <p className="text-xs text-muted mb-4">
          Every save writes a new immutable row. The currently-active version
          is marked below.
        </p>
        {versions.length === 0 ? (
          <div className="text-sm text-muted italic">No versions recorded.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted uppercase tracking-wider">
              <tr>
                <th className="text-left py-2 font-medium">Version</th>
                <th className="text-left py-2 font-medium">Hash</th>
                <th className="text-left py-2 font-medium">Created</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {versions.map((v) => (
                <tr key={v.id}>
                  <td className="py-2">
                    v{v.version}{" "}
                    {v.version === pipeline.current_version && (
                      <Pill tone="accent">current</Pill>
                    )}
                  </td>
                  <td className="py-2 mono text-xs text-muted">
                    {shortHash(v.hash)}
                  </td>
                  <td className="py-2 text-xs text-muted">
                    {relativeTime(v.created_at)}
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card p-5 mt-6">
        <h2 className="text-sm font-semibold mb-3">Current rendered fragment</h2>
        <Code>{pipeline.current_content}</Code>
      </section>

      <PipelineAuditSection pipelineId={pipeline.id} />
    </>
  );
}

function PipelineAuditSection({ pipelineId }: { pipelineId: string }) {
  const state = useAsync(
    () => listAuditEvents({ target_kind: "pipeline", target_id: pipelineId, limit: 50 }),
    [pipelineId],
  );
  return (
    <section className="card p-5 mt-6">
      <h2 className="text-sm font-semibold mb-1">Audit history</h2>
      <p className="text-xs text-muted mb-4">
        Every mutation of this pipeline, most recent first. Writes happen
        inside the same transaction as the change itself.
      </p>
      <AsyncBoundary state={state}>
        {(events) => <AuditEventList events={events} linkTarget={false} />}
      </AsyncBoundary>
    </section>
  );
}
