export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—";
  return hash.slice(0, 10);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 0) return "in the future";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

export function formatAttributes(attrs: Record<string, string>): string {
  const keys = Object.keys(attrs).sort();
  if (keys.length === 0) return "∅";
  return keys.map((k) => `${k}=${attrs[k]}`).join(" ");
}
