import { IEndpointStat, IStat, TRange } from "../types";

// Compact x-axis label: time of day for short ranges, day+time for longer ones.
export const formatTimeLabel = (timestamp: number, range: TRange): string => {
	const d = new Date(timestamp);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	if (range === "hour") return `${hh}:${mm}`;
	const day = String(d.getDate()).padStart(2, "0");
	const mon = String(d.getMonth() + 1).padStart(2, "0");
	return `${day}.${mon} ${hh}:${mm}`;
};

// Convert a yyyymmddhhmm minute-slot key (used by DB stats) into an epoch timestamp.
export const slotToTimestamp = (slot: number): number => {
	const s = String(slot);
	return new Date(
		+s.slice(0, 4),
		+s.slice(4, 6) - 1,
		+s.slice(6, 8),
		+s.slice(8, 10),
		+s.slice(10, 12),
	).getTime();
};

export const formatBytes = (b: number): string => {
	if (!Number.isFinite(b)) return "—";
	const abs = Math.abs(b);
	if (abs < 1024) return `${b} B`;
	if (abs < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
	if (abs < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
	return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

export const formatDuration = (sec: number): string => {
	if (!Number.isFinite(sec) || sec < 0) return "—";
	const s = Math.floor(sec);
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	if (d) return `${d}d ${h}h`;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m ${r}s`;
	return `${r}s`;
};

export const formatMB = (mb: number): string => {
	if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
	return `${Math.round(mb)} MB`;
};

// Aggregate per-endpoint success/fail counters across the whole series.
export const buildEndpointStats = (stats: IStat[]): IEndpointStat[] => {
	const map = new Map<string, IEndpointStat>();
	const ensure = (ep: string) => {
		let item = map.get(ep);
		if (!item) {
			item = { endpoint: ep, success: 0, fail: 0, total: 0 };
			map.set(ep, item);
		}
		return item;
	};

	for (const { slot } of stats) {
		for (const [ep, count] of Object.entries(slot.successEp)) ensure(ep).success += count;
		for (const [ep, count] of Object.entries(slot.failEp)) ensure(ep).fail += count;
	}

	const result = [...map.values()];
	result.forEach(r => (r.total = r.success + r.fail));
	result.sort((a, b) => b.total - a.total);
	return result;
};

// Aggregate external HTTP calls (slot.http) keyed by URL across the series.
export const buildHttpStats = (stats: IStat[]): { url: string; count: number }[] => {
	const map = new Map<string, number>();
	for (const { slot } of stats) {
		for (const [url, count] of Object.entries(slot.http ?? {})) {
			map.set(url, (map.get(url) ?? 0) + count);
		}
	}
	return [...map.entries()].map(([url, count]) => ({ url, count })).sort((a, b) => b.count - a.count);
};

// Aggregate per-query SQL counters (slot.success_sql / slot.fail_sql). The
// backend keys these by query template — long strings that we truncate for
// display, sorted so the busiest queries surface first.
export interface ISqlStat {
	query: string;
	success: number;
	fail: number;
	total: number;
}

export const buildSqlStats = (stats: IStat[]): ISqlStat[] => {
	const map = new Map<string, ISqlStat>();
	const ensure = (q: string) => {
		let item = map.get(q);
		if (!item) {
			item = { query: q, success: 0, fail: 0, total: 0 };
			map.set(q, item);
		}
		return item;
	};
	for (const { slot } of stats) {
		for (const [q, c] of Object.entries(slot.success_sql ?? {})) ensure(q).success += c;
		for (const [q, c] of Object.entries(slot.fail_sql ?? {})) ensure(q).fail += c;
	}
	const result = [...map.values()];
	result.forEach(r => (r.total = r.success + r.fail));
	result.sort((a, b) => b.total - a.total);
	return result;
};
