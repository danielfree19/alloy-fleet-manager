/**
 * Monospaced code display block. Used for Alloy config previews and assembled
 * outputs. We intentionally don't wrap text — Alloy configs look right on one
 * line each, and overflow-x lets wide comments scroll.
 */
export function Code({ children }: { children: string }) {
  return (
    <pre className="mono text-xs leading-relaxed whitespace-pre overflow-x-auto rounded-md border border-border bg-bg p-4 text-text/90">
      {children}
    </pre>
  );
}
