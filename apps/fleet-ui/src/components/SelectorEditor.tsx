import { useEffect, useState } from "react";
import type { Labels } from "@/api/types";

/**
 * Tiny key/value editor for `Labels` (Record<string, string>). Used both on
 * the pipeline form (to edit the selector) and on the collector detail page
 * (to simulate a collector's local_attributes when previewing assembled
 * configs).
 *
 * Controlled component: parent owns the value; we only call `onChange` with
 * fully-valid `{string: string}` maps. Duplicate keys collapse — last one
 * wins.
 */
interface Row {
  k: string;
  v: string;
}

export function SelectorEditor({
  value,
  onChange,
  placeholderKey = "role",
  placeholderValue = "edge",
}: {
  value: Labels;
  onChange: (next: Labels) => void;
  placeholderKey?: string;
  placeholderValue?: string;
}) {
  const [rows, setRows] = useState<Row[]>(() => fromLabels(value));

  useEffect(() => {
    // If parent hands us a different `value` (e.g. after a load), sync down
    // but only when the normalized maps actually differ. This avoids
    // clobbering what the user is typing.
    const normalized = toLabels(rows);
    if (!shallowEq(normalized, value)) setRows(fromLabels(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function update(next: Row[]) {
    setRows(next);
    onChange(toLabels(next));
  }

  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="text-xs text-muted italic">
          No labels — this selector matches every collector (fleet-wide).
        </p>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <input
            className="input flex-1"
            placeholder={placeholderKey}
            value={r.k}
            onChange={(e) => {
              const next = rows.slice();
              next[i] = { k: e.target.value, v: r.v };
              update(next);
            }}
          />
          <span className="self-center text-muted">=</span>
          <input
            className="input flex-1"
            placeholder={placeholderValue}
            value={r.v}
            onChange={(e) => {
              const next = rows.slice();
              next[i] = { k: r.k, v: e.target.value };
              update(next);
            }}
          />
          <button
            type="button"
            className="btn btn-danger px-2"
            onClick={() => update(rows.filter((_, j) => j !== i))}
            aria-label="Remove label"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn"
        onClick={() => update([...rows, { k: "", v: "" }])}
      >
        + Add label
      </button>
    </div>
  );
}

function fromLabels(l: Labels): Row[] {
  return Object.entries(l).map(([k, v]) => ({ k, v }));
}

function toLabels(rs: Row[]): Labels {
  const out: Labels = {};
  for (const r of rs) {
    const k = r.k.trim();
    if (!k) continue;
    out[k] = r.v;
  }
  return out;
}

function shallowEq(a: Labels, b: Labels): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) if (a[k] !== b[k]) return false;
  return true;
}
