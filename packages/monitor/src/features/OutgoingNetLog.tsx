import { useEffect, useMemo, useState } from "react";
import { styled } from "styled-components";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";
import { ITheme } from "ui/src/theme/GlobalTheme";
import { REQ_OUTGOING_NETLOG } from "../services/Metrix";
import { IOutgoingNetLogItem } from "../types";
import { usePolling } from "../hooks/usePolling";
import { Modal } from "../components/Modal";
import { Label } from "../components/Label";
import { TimeSeriesChart } from "../components/TimeSeriesChart";
import { TOpenTrace, TraceCell, TraceInfo } from "../components/TraceLink";
import { TextInput } from "../components/TextInput";

const POLL_MS = 15_000;
const ACTIVITY_BUCKETS = 32;
const TOP_HOSTS = 8;
const SLOW_MS = 1000;
const FAIL = "#bb5656";
const PALETTE = ["#5390D9", "#48BFE3", "#56CFE1", "#64DFDF", "#72EFDD", "#80FFDB", "#5E60CE", "#7400B8"];
const OTHER_COLOR = "#8a8699";

const METHOD_COLORS: Record<string, string> = {
	GET: "#56cfe1",
	POST: "#5390d9",
	PUT: "#e9b61e",
	PATCH: "#e9b61e",
	DELETE: "#bb5656",
};
const methodColor = (m?: string) => METHOD_COLORS[(m ?? "").toUpperCase()] ?? "#8a8699";

const statusColor = (s?: number): string | undefined => {
	if (s === undefined) return undefined;
	if (s >= 500) return "#e0457b";
	if (s >= 400) return FAIL;
	if (s >= 300) return "#e9b61e";
	if (s >= 200) return "#56bb56";
	return undefined;
};

const hostOf = (url: string): string => {
	try {
		return new URL(url).host || url;
	} catch {
		// relative or malformed — fall back to a stable prefix
		return url.split("/").slice(0, 3).join("/") || url;
	}
};

const pretty = (value: unknown): string => {
	if (value === undefined || value === null) return "—";
	if (typeof value === "string") {
		const t = value.trim();
		if (t.startsWith("{") || t.startsWith("[")) {
			try {
				return JSON.stringify(JSON.parse(t), null, 2);
			} catch {
				/* truncated / not valid json */
			}
		}
		return value;
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
};

const isFailed = (item: IOutgoingNetLogItem): boolean =>
	!!item.error || item.ok === false || (typeof item.status === "number" && item.status >= 400);

const Row = styled.div<{ theme: ITheme; $error?: boolean }>`
	display: grid;
	grid-template-columns: 56px 1fr 76px 52px 76px 68px 48px;
	gap: 12px;
	align-items: center;
	padding: 7px 12px;
	font-size: 0.76rem;
	border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	cursor: pointer;
	transition: background-color 0.15s;
	background-color: ${({ $error }) => ($error ? "rgba(187,86,86,.12)" : "transparent")};
	box-shadow: ${({ $error }) => ($error ? "inset 3px 0 0 #bb5656" : "none")};
	&:hover {
		background-color: ${({ $error }) => ($error ? "rgba(187,86,86,.2)" : "rgba(255,255,255,.05)")};
	}
`;

const Cell = styled.div`
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
`;

const Pre = styled.pre`
	margin: 0;
	white-space: pre-wrap;
	word-break: break-word;
	font-family: monospace;
	font-size: 0.78rem;
	line-height: 1.45;
	color: #9ffe19;
	background-color: rgba(0, 0, 0, 0.35);
	border-radius: 6px;
	padding: 12px;
	max-height: 40vh;
	overflow: auto;
`;

const Badge = ({ color, children }: { color: string; children: React.ReactNode }) => (
	<Box
		sx={{
			padding: "2px 6px",
			borderRadius: "4px",
			fontSize: ".66rem",
			fontWeight: 600,
			textAlign: "center",
			color,
			border: "1px solid " + color + "55",
			backgroundColor: color + "1a",
		}}>
		{children}
	</Box>
);

const Section = ({ label, children }: { label: string; children?: React.ReactNode }) => (
	<VBox sx={{ gap: "6px" }}>
		<Label>{label}</Label>
		{children}
	</VBox>
);

export const OutgoingNetLog = ({ trace, onTrace }: { trace?: string; onTrace: TOpenTrace }) => {
	const [items, setItems] = useState<IOutgoingNetLogItem[]>([]);
	const [search, setSearch] = useState(trace ?? "");
	const [selected, setSelected] = useState<IOutgoingNetLogItem | null>(null);
	// Opened from a trace link in another journal: start filtered by that trace.
	useEffect(() => {
		if (trace) {
			setSearch(trace);
			setSelected(null);
		}
	}, [trace]);


	const [, getLog] = REQ_OUTGOING_NETLOG.useRequest(response => {
		if (response?.error) return;
		const data = response?.data;
		setItems(Array.isArray(data) ? [...data].reverse() : []);
	});

	usePolling(() => getLog(), POLL_MS);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return items;
		return items.filter(
			i =>
				(i.traceId ?? "").toLowerCase().includes(q) ||
				i.url.toLowerCase().includes(q) ||
				(i.method ?? "").toLowerCase().includes(q) ||
				String(i.status ?? "").includes(q) ||
				pretty(i.request).toLowerCase().includes(q) ||
				pretty(i.response).toLowerCase().includes(q),
		);
	}, [items, search]);

	const activity = useMemo(() => {
		const empty = { labels: [] as string[], series: [] as { name: string; color: string; values: number[] }[] };
		const timed = items
			.map(i => ({ t: i.created, host: hostOf(i.url) }))
			.filter(i => typeof i.t === "number" && !Number.isNaN(i.t));
		if (timed.length === 0) return empty;

		const totals = new Map<string, number>();
		for (const { host } of timed) totals.set(host, (totals.get(host) ?? 0) + 1);
		const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_HOSTS).map(([h]) => h);
		const topSet = new Set(top);
		const hasOther = totals.size > top.length;
		const keys = hasOther ? [...top, "other"] : top;

		const min = Math.min(...timed.map(i => i.t));
		const max = Math.max(...timed.map(i => i.t));
		const bucketMs = Math.max(1, (max - min) / ACTIVITY_BUCKETS);

		const counts = new Map<string, number[]>(keys.map(k => [k, new Array(ACTIVITY_BUCKETS).fill(0)]));
		for (const { t, host } of timed) {
			const key = topSet.has(host) ? host : "other";
			const idx = Math.min(ACTIVITY_BUCKETS - 1, Math.floor((t - min) / bucketMs));
			counts.get(key)![idx]++;
		}

		const labels = Array.from({ length: ACTIVITY_BUCKETS }, (_, b) =>
			new Date(min + (b + 0.5) * bucketMs).toLocaleTimeString(),
		);
		const series = keys.map((k, i) => ({
			name: k,
			color: k === "other" ? OTHER_COLOR : PALETTE[i % PALETTE.length],
			values: counts.get(k)!,
		}));
		return { labels, series };
	}, [items]);

	const sel = selected;

	return (
		<>
			<VBox sx={{ gap: "16px" }}>
				{activity.series.length > 0 && (
					<VBox sx={{ gap: "6px" }}>
						<Label>Calls by host</Label>
						<TimeSeriesChart height={140} labels={activity.labels} series={activity.series} />
					</VBox>
				)}

				<HBox sx={{ gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
					<Box sx={{ flexGrow: 1, minWidth: "200px" }}>
						<TextInput
							type="search"
							value={search}
							placeholder="Search by URL, method, status, payload or trace…"
							onChange={e => setSearch(e.target.value)}
						/>
					</Box>
					<Label>
						{filtered.length} / {items.length}
					</Label>
				</HBox>

				<VBox sx={{ border: "1px solid rgba(255,255,255,.06)", borderRadius: "8px", overflow: "hidden" }}>
					<Row as="div" style={{ cursor: "default", opacity: 0.55, fontWeight: 600 }}>
						<Cell>METHOD</Cell>
						<Cell>URL</Cell>
						<Cell>TRACE</Cell>
						<Cell>STAT</Cell>
						<Cell>TIME</Cell>
						<Cell>RESP</Cell>
						<Cell style={{ textAlign: "right" }}>ID</Cell>
					</Row>
					{filtered.map(item => {
						const slow = item.time > SLOW_MS;
						const sColor = statusColor(item.status);
						return (
							<Row key={item.id} $error={isFailed(item)} onClick={() => setSelected(item)}>
								<Badge color={methodColor(item.method)}>{(item.method ?? "—").toUpperCase()}</Badge>
								<Cell style={{ fontFamily: "monospace", opacity: 0.92 }}>
									{item.url}
									{item.skipLogging && <span style={{ opacity: 0.55 }} title="Made with skipLogging: only the origin is kept"> · not logged</span>}
								</Cell>
								<TraceCell traceId={item.traceId} onClick={setSearch} />
								<Cell style={{ color: sColor, fontWeight: sColor ? 600 : undefined }}>
									{item.status ?? "—"}
								</Cell>
								<Cell style={{ opacity: 0.7 }}>{new Date(item.created).toLocaleTimeString()}</Cell>
								<Cell style={{ color: slow ? FAIL : undefined, opacity: slow ? 1 : 0.7 }}>
									{item.time} ms
								</Cell>
								<Cell style={{ opacity: 0.5, textAlign: "right" }}>{item.id}</Cell>
							</Row>
						);
					})}
					{filtered.length === 0 && (
						<Box sx={{ padding: "16px" }}>
							<Label>No outgoing requests recorded</Label>
						</Box>
					)}
				</VBox>
			</VBox>

			{sel && (
				<Modal title={`Outgoing #${sel.id}`} onClose={() => setSelected(null)}>
					<VBox sx={{ gap: "20px" }}>
						<HBox sx={{ gap: "24px", flexWrap: "wrap", alignItems: "center" }}>
							<Badge color={methodColor(sel.method)}>{(sel.method ?? "—").toUpperCase()}</Badge>
							<Typo variant="medium" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
								{sel.url}
								{sel.skipLogging && " · not logged (skipLogging: path, query and bodies are not kept)"}
							</Typo>
						</HBox>
						<HBox sx={{ gap: "24px", flexWrap: "wrap" }}>
							<VBox sx={{ gap: "2px" }}>
								<Label>Status</Label>
								<Typo variant="medium" sx={{ color: statusColor(sel.status) }}>
									{sel.status ?? "—"}
								</Typo>
							</VBox>
							<VBox sx={{ gap: "2px" }}>
								<Label>Created</Label>
								<Typo variant="medium">{new Date(sel.created).toLocaleString()}</Typo>
							</VBox>
							<VBox sx={{ gap: "2px" }}>
								<Label>Response time</Label>
								<Typo variant="medium" sx={{ color: sel.time > SLOW_MS ? FAIL : undefined }}>
									{sel.time} ms
								</Typo>
							</VBox>
							<VBox sx={{ gap: "2px" }}>
								<Label>Attempts</Label>
								<Typo variant="medium">{sel.attempts}</Typo>
							</VBox>
						</HBox>

						<TraceInfo
							traceId={sel.traceId}
							onOpen={(id, tab) => {
								// Same journal: the effect on `trace` may not fire again, so filter here too.
								setSelected(null);
								setSearch(id);
								onTrace(id, tab);
							}}
						/>

						{sel.error && (
							<Typo variant="medium" sx={{ color: FAIL }}>
								{sel.error}
							</Typo>
						)}

						<VBox sx={{ gap: "12px", paddingTop: "4px", borderTop: "1px solid rgba(255,255,255,.08)" }}>
							<Typo variant="headMedium">Request</Typo>
							<Section label="Body">
								<Pre>{pretty(sel.request)}</Pre>
							</Section>
						</VBox>

						<VBox sx={{ gap: "12px", paddingTop: "4px", borderTop: "1px solid rgba(255,255,255,.08)" }}>
							<Typo variant="headMedium">Response</Typo>
							<Pre>{pretty(sel.response)}</Pre>
						</VBox>
					</VBox>
				</Modal>
			)}
		</>
	);
};
