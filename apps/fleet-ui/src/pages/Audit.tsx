import { useState } from "react";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { PageHeader } from "@/components/PageHeader";
import { AuditEventList } from "@/components/AuditEventList";
import { listAuditEvents } from "@/api/audit";
import type { AuditAction } from "@/api/types";

type FilterAction = AuditAction | "";

export function Audit() {
  const [action, setAction] = useState<FilterAction>("");
  const [actor, setActor] = useState("");
  const state = useAsync(
    () =>
      listAuditEvents({
        action: action || undefined,
        actor: actor.trim() || undefined,
        limit: 200,
      }),
    [action, actor],
  );

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every admin mutation leaves a row here. Writes are append-only and happen inside the same transaction as the change they describe."
        actions={
          <button className="btn" onClick={state.reload}>
            Refresh
          </button>
        }
      />
      <div className="card p-4 mb-6 flex flex-wrap items-end gap-3">
        <div className="grow min-w-[160px]">
          <label className="text-xs text-muted block mb-1">Action</label>
          <select
            className="input"
            value={action}
            onChange={(e) => setAction(e.target.value as FilterAction)}
          >
            <option value="">All actions</option>
            <option value="pipeline.create">pipeline.create</option>
            <option value="pipeline.update">pipeline.update</option>
            <option value="pipeline.delete">pipeline.delete</option>
          </select>
        </div>
        <div className="grow min-w-[220px]">
          <label className="text-xs text-muted block mb-1">Actor (substring match)</label>
          <input
            className="input"
            placeholder="admin-token:..."
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          />
        </div>
      </div>
      <div className="card p-5">
        <AsyncBoundary state={state}>
          {(events) => <AuditEventList events={events} />}
        </AsyncBoundary>
      </div>
    </>
  );
}
