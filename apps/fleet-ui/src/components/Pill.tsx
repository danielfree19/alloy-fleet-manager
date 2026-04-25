import type { PropsWithChildren } from "react";

type Tone = "ok" | "warn" | "danger" | "muted" | "accent";

const TONES: Record<Tone, string> = {
  ok: "bg-ok/15 text-ok border border-ok/30",
  warn: "bg-warn/15 text-warn border border-warn/30",
  danger: "bg-danger/15 text-danger border border-danger/30",
  muted: "bg-border text-muted border border-border",
  accent: "bg-accent-soft text-accent border border-accent/30",
};

export function Pill({
  tone = "muted",
  children,
}: PropsWithChildren<{ tone?: Tone }>) {
  return <span className={`pill ${TONES[tone]}`}>{children}</span>;
}
