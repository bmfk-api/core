import { useMemo, useState } from "react";
import { Box, HBox, VBox } from "ui/src/box/Box";
import Panel from "ui/src/panel/Panel";
import { Typo } from "ui/src/text/Typo";
import { REQ_FDREPORT } from "../services/Metrix";
import { IFdHistoryEntry, IFdReport } from "../types";
import { usePolling } from "../hooks/usePolling";
import { Label } from "../components/Label";
import { TimeSeriesChart, IChartSeries } from "../components/TimeSeriesChart";
import { formatBytes } from "../lib/metrics";

// The backend snapshots FD/socket state every 10 minutes into a bounded ring
// buffer. Polling `now` more often than that is fine — the history block just
// won't move between server-side samples.
const POLL_MS = 30_000;

const ACCENT = "#48BFE3";
const WARN = "#e9b61e";
const FAIL = "#bb5656";
const MUTED = "#9a96ad";

// Line colours for socket-state series and the fd chart.
const COLORS = {
	fdOpen: "#48BFE3",
	softLimit: "#bb5656",
	ESTABLISHED: "#80FFDB",
	CLOSE_WAIT: "#bb5656",
	TIME_WAIT: "#e9b61e",
	FIN_WAIT1: "#c48af0",
	FIN_WAIT2: "#c48af0",
	LISTEN: "#5390d9",
	total: "#c9c4dc",
	rss: "#9a96ad",
} as const;

const HHMM = (ts: number) => {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const usageColor = (ratio: number) => (ratio >= 0.9 ? FAIL : ratio >= 0.7 ? WARN : ACCENT);

const ProgressBar = ({ pct, color }: { pct: number; color: string }) => (
	<Box
		sx={{
			height: "8px",
			width: "100%",
			backgroundColor: "rgba(255,255,255,.06)",
			borderRadius: "4px",
			overflow: "hidden",
		}}>
		<Box
			sx={{
				height: "100%",
				width: Math.min(100, Math.max(0, pct)) + "%",
				backgroundColor: color,
				transition: "width .25s, background-color .25s",
			}}
		/>
	</Box>
);

const Section = ({ title, children }: { title: string; children?: React.ReactNode }) => (
	<VBox
		sx={{
			gap: "12px",
			padding: "14px",
			border: "1px solid rgba(255,255,255,.08)",
			borderRadius: "8px",
			backgroundColor: "rgba(0,0,0,.12)",
		}}>
		<Typo variant="headMedium">{title}</Typo>
		{children}
	</VBox>
);

const Metric = ({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) => (
	<VBox sx={{ gap: "2px", minWidth: "90px" }}>
		<Label>{label}</Label>
		<Typo variant="headMedium" sx={color ? { color, fontVariantNumeric: "tabular-nums" } : { fontVariantNumeric: "tabular-nums" }}>
			{value}
		</Typo>
	</VBox>
);

const Hint = ({ tone, text }: { tone: "warn" | "fail" | "info"; text: string }) => (
	<HBox
		sx={{
			gap: "8px",
			alignItems: "flex-start",
			padding: "8px 10px",
			borderRadius: "6px",
			backgroundColor:
				tone === "fail" ? "rgba(187,86,86,.12)" : tone === "warn" ? "rgba(233,182,30,.10)" : "rgba(72,191,227,.10)",
			border: "1px solid " + (tone === "fail" ? "rgba(187,86,86,.35)" : tone === "warn" ? "rgba(233,182,30,.35)" : "rgba(72,191,227,.35)"),
		}}>
		<Box
			sx={{
				width: "6px",
				height: "6px",
				borderRadius: "50%",
				marginTop: "6px",
				backgroundColor: tone === "fail" ? FAIL : tone === "warn" ? WARN : ACCENT,
				flexShrink: 0,
			}}
		/>
		<Typo variant="medium" sx={{ opacity: 0.92, fontSize: ".8rem" }}>
			{text}
		</Typo>
	</HBox>
);

const StateChip = ({
	state,
	count,
	total,
	highlight,
}: {
	state: string;
	count: number;
	total: number;
	highlight?: boolean;
}) => {
	const pct = total > 0 ? (count / total) * 100 : 0;
	const color = (COLORS as Record<string, string>)[state] ?? MUTED;
	return (
		<VBox sx={{ gap: "4px", minWidth: "0" }}>
			<HBox sx={{ justifyContent: "space-between", gap: "8px", alignItems: "baseline" }}>
				<HBox sx={{ gap: "6px", alignItems: "center", minWidth: 0 }}>
					<Box sx={{ width: "8px", height: "8px", borderRadius: "2px", backgroundColor: color, flexShrink: 0 }} />
					<Typo
						variant="medium"
						sx={{
							fontFamily: "monospace",
							fontSize: ".78rem",
							opacity: highlight ? 1 : 0.92,
							color: highlight ? FAIL : undefined,
							fontWeight: highlight ? 600 : undefined,
						}}>
						{state}
					</Typo>
				</HBox>
				<HBox sx={{ gap: "6px", alignItems: "baseline" }}>
					<Typo variant="medium" sx={{ fontVariantNumeric: "tabular-nums" }}>
						{count}
					</Typo>
					<Label sx={{ fontSize: ".65rem" }}>{pct.toFixed(0)}%</Label>
				</HBox>
			</HBox>
			<Box
				sx={{
					height: "4px",
					width: "100%",
					backgroundColor: "rgba(255,255,255,.05)",
					borderRadius: "2px",
					overflow: "hidden",
				}}>
				<Box sx={{ height: "100%", width: pct + "%", backgroundColor: color }} />
			</Box>
		</VBox>
	);
};

// Detect monotonic (or near-monotonic) growth of a series over its recent
// window. Used to flag CLOSE_WAIT accumulation.
const isGrowing = (values: number[], minSamples = 4): { grew: boolean; delta: number } => {
	if (values.length < minSamples) return { grew: false, delta: 0 };
	const tail = values.slice(-Math.max(minSamples, Math.min(values.length, 12)));
	const first = tail[0];
	const last = tail[tail.length - 1];
	if (last <= first) return { grew: false, delta: 0 };
	// require at least +5 and >20% increase to avoid noise
	const delta = last - first;
	const grew = delta >= 5 && last >= first * 1.2;
	return { grew, delta };
};

interface IProps {
	// Optional: allow external range control later; for now the panel always
	// shows the full server-side history buffer.
	limit?: number;
}

export const FdReport = ({ limit }: IProps) => {
	const [data, setData] = useState<IFdReport | null>(null);

	const [, getFdReport] = REQ_FDREPORT.useRequest(response => {
		if (response?.error) return;
		if (response?.data) setData(response.data);
	});

	usePolling(() => getFdReport(), POLL_MS);

	const history = useMemo<IFdHistoryEntry[]>(() => {
		if (!data?.history?.length) return [];
		const h = data.history;
		return typeof limit === "number" && limit > 0 && h.length > limit ? h.slice(-limit) : h;
	}, [data, limit]);

	if (!data) return <Panel label="File descriptors & sockets"><Label>Loading…</Label></Panel>;

	const now = data.now;
	const sockets = now.sockets;

	// FD gauge ---------------------------------------------------------------
	const softLimit = now.limitSoft;
	const unlimited = softLimit === -1;
	const showPct = !unlimited && softLimit != null && softLimit > 0;
	const fdRatio = showPct ? now.fdOpen / (softLimit as number) : 0;
	const fdPct = fdRatio * 100;
	const fdColor = showPct ? usageColor(fdRatio) : ACCENT;

	// State chips ------------------------------------------------------------
	const byState = sockets?.byState ?? {};
	const stateEntries = Object.entries(byState)
		.filter(([, v]) => typeof v === "number" && v > 0)
		.sort((a, b) => (b[1] as number) - (a[1] as number));

	// History-driven series --------------------------------------------------
	const labels = history.map(h => HHMM(h.ts));

	const fdSeries: IChartSeries[] = [];
	if (history.length) {
		fdSeries.push({ name: "fdOpen", color: COLORS.fdOpen, values: history.map(h => h.fdOpen) });
		// Reference line for the soft limit — the chart doesn't render dashed
		// horizontals, so we stamp the last known non-unlimited value across
		// every sample. Skip if the limit is unknown/unlimited everywhere.
		let refLimit = 0;
		for (const h of history) {
			if (typeof h.fdSoftLimit === "number" && h.fdSoftLimit > 0) refLimit = h.fdSoftLimit;
		}
		if (refLimit > 0) {
			fdSeries.push({
				name: "soft limit",
				color: COLORS.softLimit,
				values: history.map(() => refLimit),
			});
		}
	}

	// Build socket-state line series only when we actually have socket data
	// somewhere in the window (non-Linux histories carry byState = {}).
	const seenStates = new Set<string>();
	for (const h of history) {
		for (const k of Object.keys(h.byState ?? {})) if ((h.byState[k] ?? 0) > 0) seenStates.add(k);
	}
	// Preferred order — the ones the leak diagnosis cares about first.
	const preferred = ["ESTABLISHED", "CLOSE_WAIT", "TIME_WAIT", "FIN_WAIT1", "FIN_WAIT2", "LISTEN"];
	const orderedStates = preferred.filter(s => seenStates.has(s)).concat([...seenStates].filter(s => !preferred.includes(s)).sort());

	const socketSeries: IChartSeries[] = orderedStates.map(state => ({
		name: state,
		color: (COLORS as Record<string, string>)[state] ?? MUTED,
		values: history.map(h => h.byState?.[state] ?? 0),
	}));

	// Diagnostic hints -------------------------------------------------------
	const hints: { tone: "warn" | "fail" | "info"; text: string }[] = [];
	if (showPct && fdRatio > 0.9) {
		hints.push({ tone: "fail", text: `fdOpen has reached ${fdPct.toFixed(0)}% of the soft limit — descriptor exhaustion is imminent.` });
	} else if (showPct && fdRatio > 0.7) {
		hints.push({ tone: "warn", text: `fdOpen is at ${fdPct.toFixed(0)}% of the soft limit — investigate what is holding open descriptors.` });
	}

	const closeWaitSeries = history.map(h => h.byState?.CLOSE_WAIT ?? 0);
	const cwGrowth = isGrowing(closeWaitSeries);
	if (cwGrowth.grew) {
		hints.push({
			tone: "warn",
			text: `CLOSE_WAIT sockets keep piling up (+${cwGrowth.delta} over the recent window) — the peer (e.g. nginx) closed the connections but the app never released them.`,
		});
	}

	const topRemotes = sockets?.topRemotes ?? [];
	const establishedTotal = byState.ESTABLISHED ?? 0;
	if (topRemotes.length > 0 && establishedTotal > 0) {
		const top = topRemotes[0];
		if (top.established >= 10 && top.established / establishedTotal >= 0.6) {
			hints.push({
				tone: "info",
				text: `Host ${top.host} holds ${top.established} of ${establishedTotal} ESTABLISHED sockets — check for stuck outgoing keep-alives.`,
			});
		}
	}

	const sampleMinutes = Math.round(data.sampleEveryMs / 60000);
	const historyEmpty = history.length === 0;
	const nonLinux = sockets === null;

	return (
		<Panel label="File descriptors & sockets">
			<VBox sx={{ gap: "16px" }}>
				{/* Now snapshot: fd gauge + summary */}
				<Section title="Current">
					<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
						<Metric label="fd open" value={now.fdOpen} color={fdColor} />
						<Metric label="Soft limit" value={unlimited ? "∞" : softLimit ?? "—"} />
						<Metric label="Hard limit" value={now.limitHard === -1 ? "∞" : now.limitHard ?? "—"} />
						{sockets && <Metric label="Sockets" value={sockets.total} />}
						<Metric label="Sampled" value={HHMM(now.ts)} />
					</HBox>
					{showPct && (
						<VBox sx={{ gap: "4px" }}>
							<HBox sx={{ justifyContent: "space-between" }}>
								<Label>fd open / soft limit</Label>
								<Typo variant="medium" sx={{ color: fdColor, fontVariantNumeric: "tabular-nums" }}>
									{fdPct.toFixed(1)}%
								</Typo>
							</HBox>
							<ProgressBar pct={fdPct} color={fdColor} />
						</VBox>
					)}
					{unlimited && (
						<Label sx={{ fontSize: ".72rem" }}>
							Soft limit is unlimited — only the absolute fd count is shown.
						</Label>
					)}
				</Section>

				{/* Diagnostic hints */}
				{hints.length > 0 && (
					<VBox sx={{ gap: "8px" }}>
						{hints.map((h, i) => (
							<Hint key={i} tone={h.tone} text={h.text} />
						))}
					</VBox>
				)}

				{/* Non-Linux notice */}
				{nonLinux && (
					<Section title="Sockets">
						<Label>Socket state breakdown is only available on Linux (collected from /proc).</Label>
					</Section>
				)}

				{/* Socket state chips */}
				{sockets && stateEntries.length > 0 && (
					<Section title="Sockets by state">
						<VBox sx={{ gap: "10px" }}>
							{stateEntries.map(([state, count]) => (
								<StateChip
									key={state}
									state={state}
									count={count as number}
									total={sockets.total}
									highlight={state === "CLOSE_WAIT"}
								/>
							))}
						</VBox>
					</Section>
				)}

				{/* Top remote hosts */}
				{sockets && topRemotes.length > 0 && (
					<Section title="Top remote hosts (ESTABLISHED)">
						<VBox sx={{ gap: "6px" }}>
							{topRemotes.map(r => {
								const w = establishedTotal > 0 ? (r.established / establishedTotal) * 100 : 0;
								return (
									<VBox key={r.host} sx={{ gap: "4px" }}>
										<HBox sx={{ justifyContent: "space-between", gap: "12px" }}>
											<Typo
												variant="medium"
												sx={{
													fontFamily: "monospace",
													opacity: 0.9,
													wordBreak: "break-all",
													fontSize: ".78rem",
												}}>
												{r.host}
											</Typo>
											<Typo variant="medium" sx={{ fontVariantNumeric: "tabular-nums" }}>
												{r.established}
											</Typo>
										</HBox>
										<Box
											sx={{
												height: "4px",
												width: w + "%",
												minWidth: "4px",
												borderRadius: "2px",
												backgroundColor: ACCENT,
											}}
										/>
									</VBox>
								);
							})}
						</VBox>
					</Section>
				)}

				{/* History charts */}
				<Section title={`History (every ${sampleMinutes} min, up to ${data.historyMax} samples)`}>
					{historyEmpty ? (
						<Label>No history yet — the first sample is taken at startup, then every {sampleMinutes} minutes.</Label>
					) : (
						<VBox sx={{ gap: "18px" }}>
							<VBox sx={{ gap: "4px" }}>
								<Label>Open file descriptors</Label>
								<TimeSeriesChart
									series={fdSeries}
									labels={labels}
									height={180}
									formatValue={n => Math.round(n).toString()}
								/>
							</VBox>

							{socketSeries.length > 0 && (
								<VBox sx={{ gap: "4px" }}>
									<Label>Sockets by state</Label>
									<TimeSeriesChart
										series={socketSeries}
										labels={labels}
										height={180}
										formatValue={n => Math.round(n).toString()}
									/>
								</VBox>
							)}

							<VBox sx={{ gap: "4px" }}>
								<Label>Resident memory (RSS)</Label>
								<TimeSeriesChart
									series={[{ name: "RSS", color: COLORS.rss, values: history.map(h => h.rss) }]}
									labels={labels}
									height={140}
									formatValue={formatBytes}
								/>
							</VBox>
						</VBox>
					)}
				</Section>
			</VBox>
		</Panel>
	);
};
