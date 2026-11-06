export const usd = (cents?: number | null) =>
  cents === undefined || cents === null
    ? "-"
    : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const shortHex = (h?: string | null, n = 6) => (h ? `${h.slice(0, n)}…${h.slice(-4)}` : "");

export const timeAgo = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
