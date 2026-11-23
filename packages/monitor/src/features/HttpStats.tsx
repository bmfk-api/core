import { useRef, useState } from "react";
import { styled } from "styled-components";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";
import { REQ_HTTPSTATS } from "../services/Metrix";
import { IHttpHostStats, IHttpStats, IHttpStatusDistribution, IOutgoingNetLogItem } from "../types";
import { usePolling } from "../hooks/usePolling";
import { Label } from "../components/Label";
import { Modal } from "../components/Modal";
import { IChartSeries, TimeSeriesChart } from "../components/TimeSeriesChart";

const POLL_MS = 30_000;
const ACCENT = "#48BFE3";
const SUCCESS = "#56bb56";
const WARN = "#e9b61e";
const FAIL = "#bb5656";
const CRIT = "#e0457b";

// The server exposes fresh p50/p95/p99 for the last ~1024 requests per host,
// but only as an instantaneous snapshot. We build the time series on the
// client — one sample per successful poll, capped so old points fall off.
const HISTORY_MAX = 240; // 240 * 30s = 2h of trend
const TREND_HOSTS = 5;   // number of hosts shown on the shared p95 chart
const LINE_PALETTE = ["#48BFE3", "#80FFDB", "#e9b61e", "#c48af0", "#e0457b", "#5390d9", "#80cbc4"];

const hmss = (ts: number) => {
	const d = new Date(ts);
	return (
		String(d.getHours()).padStart(2, "0") +
		":" +
		String(d.getMinutes()).padStart(2, "0")
	);
};

const STATUS_META: Array<{ key: keyof IHttpStatusDistribution; label: string; color: string }> = [
	{ key: "s2xx", label: "2xx", color: SUCCESS },
	{ key: "s3xx", label: "3xx", color: "#5390d9" },
	{ key: "s4xx", label: "4xx", color: WARN },
	{ key: "s5xx", label: "5xx", color: FAIL },
	{ key: "networkErrors", label: "net err", color: CRIT },
	{ key: "timeouts", label: "timeout", color: "#7400B8" },
	{ key: "other", label: "other", color: "#8a8699" },
];

const METHOD_COLORS: Record<string, string> = {
	GET: "#56cfe1",
	POST: "#5390d9",
	PUT: "#e9b61e",
	PATCH: "#e9b61e",
	DELETE: "#bb5656",
};
const methodColor = (m?: string) => METHOD_COLORS[(m ?? "").toUpperCase()] ?? "#8a8699";

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

const statusColor = (s?: number): string | undefined => {
	if (s === undefined) return undefined;
	if (s >= 500) return CRIT;
	if (s >= 400) return FAIL;
	if (s >= 300) return WARN;
	if (s >= 200) return SUCCESS;
	return undefined;
};

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

const Metric = ({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) => (
	<VBox sx={{ gap: "2px", minWidth: "90px" }}>
		<Label>{label}</Label>
		<Typo variant="headMedium" sx={color ? { color } : undefined}>
			{value}
		</Typo>
	</VBox>
);

const Section = ({ title, children }: { title: string; children?: React.ReactNode }) => (
	<VBox
		sx={{
			gap: "14px",
			padding: "16px",
			border: "1px solid rgba(255,255,255,.08)",
			borderRadius: "8px",
			backgroundColor: "rgba(0,0,0,.12)",
		}}>
		<Typo variant="headMedium">{title}</Typo>
		{children}
	</VBox>
);

const StatusBar = ({
	dist,
	compact,
}: {
	dist: Pick<IHttpHostStats["byStatus"], "s2xx" | "s3xx" | "s4xx" | "s5xx" | "other" | "networkErrors">;
	compact?: boolean;
}) => {
	const segments = STATUS_META.filter(m => m.key !== "timeouts").map(m => ({
		...m,
		value: (dist as unknown as Record<string, number>)[m.key] ?? 0,
	}));
	const total = segments.reduce((s, x) => s + x.value, 0);
	if (total === 0) return <Label sx={{ fontSize: ".68rem" }}>—</Label>;
	return (
		<HBox
			sx={{
				height: compact ? "6px" : "8px",
				width: "100%",
				borderRadius: "3px",
				overflow: "hidden",
				backgroundColor: "rgba(255,255,255,.05)",
			}}>
			{segments.map(s =>
				s.value > 0 ? (
					<Box
						key={s.key as string}
						title={`${s.label}: ${s.value}`}
						sx={{ width: (s.value / total) * 100 + "%", backgroundColor: s.color }}
					/>
				) : null,
			)}
		</HBox>
	);
};

const HostCard = styled.div`
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 10px 4px;
	font-size: 0.76rem;
	border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	min-width: 0;
	&:last-child {
		border-bottom: none;
	}
`;

const HostMetric = ({
	label,
	value,
	sub,
	color,
}: {
	label: string;
	value: React.ReactNode;
	sub?: React.ReactNode;
	color?: string;
}) => (
	<VBox sx={{ gap: "1px", minWidth: "auto" }}>
		<Label sx={{ fontSize: ".6rem", letterSpacing: ".04em", textTransform: "uppercase" }}>{label}</Label>
		<HBox sx={{ gap: "4px", alignItems: "baseline" }}>
			<Typo variant="medium" sx={color ? { color, fontVariantNumeric: "tabular-nums" } : { fontVariantNumeric: "tabular-nums" }}>
				{value}
			</Typo>
			{sub && <Label sx={{ fontSize: ".62rem" }}>{sub}</Label>}
		</HBox>
	</VBox>
);

const Cell = styled.div`
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
`;

const SlowRow = styled.div`
	display: grid;
	grid-template-columns: 56px 1fr 52px 76px;
	gap: 10px;
	align-items: center;
	padding: 7px 12px;
	font-size: 0.76rem;
	border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	cursor: pointer;
	transition: background-color 0.15s;
	&:hover {
		background-color: rgba(255, 255, 255, 0.05);
	}
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

// Per-host history samples we accumulate across polls. Kept in a ref (not
// state) so we don't force renders just for buffer growth — the containing
// component already re-renders on every new snapshot arriving from the poll.
interface IHostSample {
	ts: number;
	p50: number;
	p95: number;
	p99: number;
}

export const HttpStats = () => {
	const [data, setData] = useState<IHttpStats | null>(null);
	const [selected, setSelected] = useState<IOutgoingNetLogItem | null>(null);
	const historyRef = useRef<Map<string, IHostSample[]>>(new Map());

	const [, getStats] = REQ_HTTPSTATS.useRequest(response => {
		if (response?.error) return;
		if (response?.data) {
			const now = Date.now();
			const hist = historyRef.current;
			for (const h of response.data.perHost) {
				if (h.count === 0) continue; // don't chart hosts with no samples yet
				let arr = hist.get(h.host);
				if (!arr) {
					arr = [];
					hist.set(h.host, arr);
				}
				arr.push({ ts: now, p50: h.p50Ms ?? 0, p95: h.p95Ms ?? 0, p99: h.p99Ms ?? 0 });
				if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
			}
			// Drop hosts that vanished from the snapshot to keep memory bounded.
			const seen = new Set(response.data.perHost.map(h => h.host));
			for (const key of [...hist.keys()]) if (!seen.has(key)) hist.delete(key);
			setData(response.data);
		}
	});

	usePolling(() => getStats(), POLL_MS);

	if (!data) return <Label>Loading…</Label>;

	const dist = data.statusDistribution;
	const errTotal = dist.s4xx + dist.s5xx + dist.networkErrors + dist.other;
	const errPct = data.totalRequests > 0 ? (errTotal / data.totalRequests) * 100 : 0;

	// Build the shared p95 trend chart: pick top-N hosts by request count,
	// align their samples onto a common timeline (the timeline of the host
	// with the most samples).
	const topHosts = [...data.perHost]
		.filter(h => (historyRef.current.get(h.host)?.length ?? 0) >= 2)
		.sort((a, b) => b.count - a.count)
		.slice(0, TREND_HOSTS);

	let trendLabels: string[] = [];
	const trendSeries: IChartSeries[] = [];
	if (topHosts.length > 0) {
		// Timeline of the host with the most points.
		let baseline: IHostSample[] = [];
		for (const h of topHosts) {
			const arr = historyRef.current.get(h.host) ?? [];
			if (arr.length > baseline.length) baseline = arr;
		}
		trendLabels = baseline.map(s => hmss(s.ts));
		topHosts.forEach((h, i) => {
			const arr = historyRef.current.get(h.host) ?? [];
			// Right-align to the shared timeline: pad the front with the first
			// known value so shorter series don't drift the tooltip.
			const pad = Math.max(0, baseline.length - arr.length);
			const first = arr[0]?.p95 ?? 0;
			const values = [
				...Array.from({ length: pad }, () => first),
				...arr.map(s => s.p95),
			];
			trendSeries.push({
				name: h.host.replace(/^https?:\/\//, "").slice(0, 32),
				color: LINE_PALETTE[i % LINE_PALETTE.length],
				values,
			});
		});
	}

	return (
		<VBox sx={{ gap: "16px" }}>
			<Section title="HTTP outgoing overview">
				<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
					<Metric label="Total requests" value={data.totalRequests} color={ACCENT} />
					<Metric label="In-flight" value={data.inFlight.current} color={data.inFlight.current > 0 ? ACCENT : undefined} />
					<Metric label="Peak in-flight" value={data.inFlight.peak} />
					<Metric label="Error rate" value={`${errPct.toFixed(1)}%`} color={errPct >= 5 ? FAIL : errPct >= 1 ? WARN : SUCCESS} />
					<Metric label="Timeouts" value={dist.timeouts} color={dist.timeouts ? FAIL : undefined} />
				</HBox>

				<VBox sx={{ gap: "8px" }}>
					<Label>Status distribution</Label>
					<StatusBar dist={dist} />
					<HBox sx={{ gap: "12px", flexWrap: "wrap" }}>
						{STATUS_META.map(m => {
							const v = (dist as unknown as Record<string, number>)[m.key] ?? 0;
							return (
								<HBox key={m.key as string} sx={{ gap: "6px", alignItems: "center" }}>
									<Box
										sx={{
											width: "8px",
											height: "8px",
											borderRadius: "2px",
											backgroundColor: m.color,
										}}
									/>
									<Label sx={{ fontSize: ".68rem" }}>
										{m.label} · {v}
									</Label>
								</HBox>
							);
						})}
					</HBox>
				</VBox>
			</Section>

			<Section title={`Per-host (${data.perHost.length})`}>
				{data.perHost.length === 0 && <Label>No requests recorded yet</Label>}
				{data.perHost.length > 0 && (
					<VBox sx={{ gap: "0px" }}>
						{data.perHost.map(h => (
							<HostCard key={h.host}>
								<HBox
									sx={{
										justifyContent: "space-between",
										alignItems: "baseline",
										gap: "10px",
										minWidth: 0,
									}}>
									<Cell style={{ fontFamily: "monospace", opacity: 0.92, minWidth: 0, flex: 1 }}>
										{h.host}
									</Cell>
									<Label sx={{ fontSize: ".62rem", whiteSpace: "nowrap" }}>
										last {new Date(h.lastRequestAt).toLocaleTimeString()}
									</Label>
								</HBox>
								<HBox sx={{ gap: "16px", rowGap: "6px", flexWrap: "wrap", alignItems: "baseline" }}>
									<HostMetric label="Req" value={h.count} />
									<HostMetric
										label="Err"
										value={h.errors}
										color={h.errors > 0 ? FAIL : undefined}
										sub={h.timeouts > 0 ? <span style={{ color: CRIT }}>·{h.timeouts}to</span> : null}
									/>
									<HostMetric
										label="Retry"
										value={h.retries}
										color={h.retries > 0 ? WARN : undefined}
									/>
									<HostMetric
										label="In-flight"
										value={h.inFlight}
										color={h.inFlight > 0 ? ACCENT : undefined}
									/>
									<HostMetric
										label="Avg"
										value={
											<span style={{ color: h.avgMs > 1000 ? FAIL : undefined }}>
												{Math.round(h.avgMs)} ms
											</span>
										}
										sub={`${Math.round(h.minMs)}-${Math.round(h.maxMs)}`}
									/>
									<HostMetric label="p50" value={`${Math.round(h.p50Ms ?? 0)} ms`} />
									<HostMetric
										label="p95"
										value={
											<span
												style={{
													color:
														(h.p95Ms ?? 0) > 1500
															? FAIL
															: (h.p95Ms ?? 0) > 800
																? WARN
																: undefined,
												}}>
												{Math.round(h.p95Ms ?? 0)} ms
											</span>
										}
									/>
									<HostMetric
										label="p99"
										value={
											<span style={{ color: (h.p99Ms ?? 0) > 2000 ? FAIL : undefined }}>
												{Math.round(h.p99Ms ?? 0)} ms
											</span>
										}
									/>
								</HBox>
								<StatusBar dist={h.byStatus} compact />
							</HostCard>
						))}
					</VBox>
				)}
			</Section>

			{trendSeries.length > 0 && (
				<Section title={`p95 trend (top ${topHosts.length} by volume)`}>
					<VBox sx={{ gap: "6px" }}>
						<Label sx={{ fontSize: ".7rem" }}>
							Client-side history — one sample per poll ({Math.round(POLL_MS / 1000)} s), up to
							{" "}
							{Math.round((HISTORY_MAX * POLL_MS) / 60000)} min. Resets on reload.
						</Label>
						<TimeSeriesChart
							series={trendSeries}
							labels={trendLabels}
							height={180}
							formatValue={n => `${Math.round(n)} ms`}
						/>
					</VBox>
				</Section>
			)}

			{data.topSlow.length > 0 && (
				<Section title={`Slowest requests (${data.topSlow.length})`}>
					<VBox sx={{ border: "1px solid rgba(255,255,255,.06)", borderRadius: "8px", overflow: "hidden" }}>
						<SlowRow style={{ cursor: "default", opacity: 0.55, fontWeight: 600 }}>
							<Cell>METHOD</Cell>
							<Cell>URL</Cell>
							<Cell>STAT</Cell>
							<Cell style={{ textAlign: "right" }}>TIME</Cell>
						</SlowRow>
						{data.topSlow.map(item => {
							const sColor = statusColor(item.status);
							return (
								<SlowRow key={item.id} onClick={() => setSelected(item)}>
									<Badge color={methodColor(item.method)}>{(item.method ?? "—").toUpperCase()}</Badge>
									<Cell style={{ fontFamily: "monospace", opacity: 0.92 }}>{item.url}</Cell>
									<Cell style={{ color: sColor, fontWeight: sColor ? 600 : undefined }}>
										{item.status ?? "—"}
									</Cell>
									<Cell
										style={{
											textAlign: "right",
											color: item.time > 1000 ? FAIL : undefined,
											opacity: item.time > 1000 ? 1 : 0.8,
										}}>
										{item.time} ms
									</Cell>
								</SlowRow>
							);
						})}
					</VBox>
				</Section>
			)}

			{selected && (
				<Modal title={`Slow #${selected.id}`} onClose={() => setSelected(null)}>
					<VBox sx={{ gap: "16px" }}>
						<HBox sx={{ gap: "16px", flexWrap: "wrap", alignItems: "center" }}>
							<Badge color={methodColor(selected.method)}>
								{(selected.method ?? "—").toUpperCase()}
							</Badge>
							<Typo variant="medium" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
								{selected.url}
							</Typo>
						</HBox>
						<HBox sx={{ gap: "24px", flexWrap: "wrap" }}>
							<VBox sx={{ gap: "2px" }}>
								<Label>Status</Label>
								<Typo variant="medium" sx={{ color: statusColor(selected.status) }}>
									{selected.status ?? "—"}
								</Typo>
							</VBox>
							<VBox sx={{ gap: "2px" }}>
								<Label>Duration</Label>
								<Typo variant="medium" sx={{ color: selected.time > 1000 ? FAIL : undefined }}>
									{selected.time} ms
								</Typo>
							</VBox>
							<VBox sx={{ gap: "2px" }}>
								<Label>Attempts</Label>
								<Typo variant="medium">{selected.attempts}</Typo>
							</VBox>
							<VBox sx={{ gap: "2px" }}>
								<Label>Created</Label>
								<Typo variant="medium">{new Date(selected.created).toLocaleString()}</Typo>
							</VBox>
						</HBox>
						{selected.error && (
							<Typo variant="medium" sx={{ color: FAIL }}>
								{selected.error}
							</Typo>
						)}
						<VBox sx={{ gap: "6px" }}>
							<Label>Request</Label>
							<Pre>{pretty(selected.request)}</Pre>
						</VBox>
						<VBox sx={{ gap: "6px" }}>
							<Label>Response</Label>
							<Pre>{pretty(selected.response)}</Pre>
						</VBox>
					</VBox>
				</Modal>
			)}
		</VBox>
	);
};
