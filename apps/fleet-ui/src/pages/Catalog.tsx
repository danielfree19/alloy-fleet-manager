import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { PageHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { listCatalog } from "@/api/catalog";
import type { CatalogCategory, CatalogTemplateSummary } from "@/api/types";

type CategoryFilter = CatalogCategory | "all";

const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  metrics: "Metrics",
  logs: "Logs",
  traces: "Traces",
  sinks: "Sinks",
  infra: "Infrastructure",
};

const CATEGORY_TONES: Record<CatalogCategory, "accent" | "ok" | "warn" | "muted"> = {
  metrics: "accent",
  logs: "ok",
  traces: "warn",
  sinks: "muted",
  infra: "muted",
};

export function Catalog() {
  const state = useAsync(() => listCatalog(), []);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const searchId = useId();

  return (
    <>
      <PageHeader
        title="Template catalog"
        subtitle="Pre-built Alloy fragments for common integrations. Click one to land on the new-pipeline form with name, selector, and content pre-filled."
        actions={
          <button type="button" className="btn" onClick={state.reload}>
            Refresh
          </button>
        }
      />
      <AsyncBoundary state={state}>
        {(data) => {
          const templates = data.templates;
          const filtered = filterTemplates(templates, category, query);
          const counts = countByCategory(templates);
          return (
            <>
              <div className="card p-4 mb-6 flex flex-wrap items-end gap-3">
                <div className="grow min-w-[220px]">
                  <label htmlFor={searchId} className="text-xs text-muted block mb-1">
                    Search
                  </label>
                  <input
                    id={searchId}
                    className="input"
                    placeholder="postgres, nginx, logs, k8s..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <CategoryChip
                    label={`All (${templates.length})`}
                    active={category === "all"}
                    onClick={() => setCategory("all")}
                  />
                  {(Object.keys(CATEGORY_LABELS) as CatalogCategory[]).map((c) => (
                    <CategoryChip
                      key={c}
                      label={`${CATEGORY_LABELS[c]} (${counts[c] ?? 0})`}
                      active={category === c}
                      onClick={() => setCategory(c)}
                    />
                  ))}
                </div>
              </div>

              {data.sources.length > 0 && (
                <div className="text-xs text-muted mb-4">
                  Sources:{" "}
                  {data.sources.map((s, i) => (
                    <span key={s} className="font-mono">
                      {i > 0 && ", "}
                      {s}
                    </span>
                  ))}
                </div>
              )}

              {filtered.length === 0 ? (
                <div className="card p-10 text-center text-sm text-muted">
                  No templates match the current filter.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filtered.map((t) => (
                    <TemplateCard key={t.id} template={t} />
                  ))}
                </div>
              )}
            </>
          );
        }}
      </AsyncBoundary>
    </>
  );
}

function filterTemplates(
  all: CatalogTemplateSummary[],
  category: CategoryFilter,
  query: string,
): CatalogTemplateSummary[] {
  const q = query.trim().toLowerCase();
  return all.filter((t) => {
    if (category !== "all" && t.category !== category) return false;
    if (q.length === 0) return true;
    const haystack = [
      t.id,
      t.name,
      t.description,
      ...t.tags,
      ...Object.entries(t.default_selector).flatMap(([k, v]) => [k, v]),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

function countByCategory(
  all: CatalogTemplateSummary[],
): Partial<Record<CatalogCategory, number>> {
  const out: Partial<Record<CatalogCategory, number>> = {};
  for (const t of all) {
    out[t.category] = (out[t.category] ?? 0) + 1;
  }
  return out;
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-xs font-medium border transition ${
        active
          ? "bg-accent-soft text-accent border-accent/40"
          : "bg-surface text-text/80 border-border hover:bg-border/40"
      }`}
    >
      {label}
    </button>
  );
}

function TemplateCard({ template }: { template: CatalogTemplateSummary }) {
  const selectorEntries = Object.entries(template.default_selector);
  return (
    <div className="card p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold leading-tight">{template.name}</div>
          <div className="text-xs text-muted font-mono mt-0.5">{template.id}</div>
        </div>
        <Pill tone={CATEGORY_TONES[template.category]}>
          {CATEGORY_LABELS[template.category]}
        </Pill>
      </div>

      <p className="text-sm text-text/80 leading-relaxed">{template.description}</p>

      {template.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {template.tags.map((tag) => (
            <span
              key={tag}
              className="text-[11px] px-2 py-0.5 rounded bg-border/50 text-muted"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {selectorEntries.length > 0 && (
        <div className="text-xs text-muted">
          <span className="font-medium">Selector:</span>{" "}
          <span className="font-mono text-text/70">
            {selectorEntries.map(([k, v]) => `${k}=${v}`).join(", ")}
          </span>
        </div>
      )}

      {template.requires.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted hover:text-text">
            Requires ({template.requires.length})
          </summary>
          <ul className="mt-1.5 space-y-1 list-disc ml-4 text-text/70">
            {template.requires.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex gap-2 mt-auto pt-2">
        <Link
          to={`/pipelines/new?from_template=${encodeURIComponent(template.id)}`}
          className="btn btn-primary"
        >
          Install
        </Link>
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
    </div>
  );
}
