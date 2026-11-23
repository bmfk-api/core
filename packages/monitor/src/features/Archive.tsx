import { useEffect, useMemo, useState } from "react";
import { Box, HBox, VBox } from "ui/src/box/Box";
import Panel from "ui/src/panel/Panel";
import { Typo, TypoCaption } from "ui/src/text/Typo";
import { REQ_METRICS_WEEK, REQ_METRICS_WEEKS } from "../services/Metrix";
import { IStat, TWeekKey } from "../types";
import { Label } from "../components/Label";
import { IChartSeries, TimeSeriesChart } from "../components/TimeSeriesChart";
import { buildEndpointStats, buildSqlStats, formatBytes, formatTimeLabel } from "../lib/metrics";
import { Spinner } from "ui/src/spinner/Spinner";

const FAIL = "#bb5656";
const ACCENT = "#48BFE3";
const MEM_COLOR = "#5390d9";
const CPU_COLOR = "#c48af0";

// Convert an ISO week key ("2026-W36") into the Monday-anchored timestamp for
// display in the tab bar. Not a hard requirement — falls back to the key.
const weekLabel = (key: TWeekKey): string => {
	const m = /^(\d{4})-W(\d{1,2})$/.exec(key);
	if (!m) return key;
	const year = +m[1];
	const week = +m[2];
	// ISO week 1 contains the first Thursday. Simple approximation is enough here.
	const jan4 = new Date(year, 0, 4);
	const day = jan4.getDay() || 7;
	const monday = new Date(year, 0, 4 - day + 1 + (week - 1) * 7);
	if (Number.isNaN(monday.getTime())) return key;
	const dd = String(monday.getDate()).padStart(2, "0");
	const mm = String(monday.getMonth() + 1).padStart(2, "0");
	return `${key} · ${dd}.${mm}`;
};

const short = (q: string): string => (q.length > 96 ? q.slice(0, 96) + "…" : q);

export const Archive = () => {
	const [weeks, setWeeks] = useState<TWeekKey[]>([]);
	const [weeksError, setWeeksError] = useState<string | null>(null);
	const [selected, setSelected] = useState<TWeekKey | null>(null);
	const [weekStats, setWeekStats] = useState<IStat[]>([]);
	const [weekError, setWeekError] = useState<string | null>(null);

	const [, getWeeks, , listBusy] = REQ_METRICS_WEEKS.useRequest(response => {
		if (response?.error) {
			setWeeksError(response.error.details ?? response.error.message);
			return;
		}
		setWeeksError(null);
		const list = [...(response?.data ?? [])].sort().reverse(); // newest first
		setWeeks(list);
		if (list.length > 0 && !selected) setSelected(list[0]);
	});

	const [, getWeek, , weekBusy] = REQ_METRICS_WEEK.useRequest(response => {
		if (response?.error) {
			setWeekError(response.error.details ?? response.error.message);
			setWeekStats([]);
			return;
		}
		if (!response || (!response.data && response.httpStatus === 0)) return; // sentinel
		setWeekError(null);
		setWeekStats(response.data ?? []);
	});

	// Fetch the archive list once on mount.
	useEffect(() => {
		getWeeks();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Fetch a week whenever the operator picks it.
	useEffect(() => {
		if (!selected) {
			setWeekStats([]);
			return;
		}
		getWeek({ weekKey: selected });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected]);

	const cpuSeries = useMemo<IChartSeries[]>(
		() => [{ name: "CPU %", color: CPU_COLOR, values: weekStats.map(s => s.slot.cpu) }],
		[weekStats],
	);
	const memSeries = useMemo<IChartSeries[]>(
		() => [
			{
				name: "RSS",
				color: MEM_COLOR,
				values: weekStats.map(s => s.slot.memory.rss * 1024 * 1024),
			},
			{
				name: "Heap used",
				color: ACCENT,
				values: weekStats.map(s => s.slot.memory.heapUsed * 1024 * 1024),
			},
		],
		[weekStats],
	);
	// Archives store either minute or hour resolution — the "day" label form
	// (day+time) reads well for both.
	const labels = useMemo(() => weekStats.map(s => formatTimeLabel(s.timestamp, "day")), [weekStats]);

	const endpointRows = useMemo(() => buildEndpointStats(weekStats), [weekStats]);
	const sqlRows = useMemo(() => buildSqlStats(weekStats), [weekStats]);
	const topEndpoints = endpointRows.slice(0, 10);
	const topSql = sqlRows.slice(0, 10);
	const totalReq = endpointRows.reduce((s, r) => s + r.total, 0);
	const totalFail = endpointRows.reduce((s, r) => s + r.fail, 0);

	return (
		<VBox sx={{ gap: "20px" }}>
			<Panel label="Metrics archive">
				<VBox sx={{ gap: "16px" }}>
					<HBox sx={{ gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
						<Label>Persisted weeks</Label>
						{listBusy && <Spinner size={14} />}
						{weeksError && (
							<Typo variant="medium" sx={{ color: FAIL, fontSize: ".8rem" }}>
								{weeksError}
							</Typo>
						)}
					</HBox>

					{!listBusy && weeks.length === 0 && !weeksError && (
						<Label>
							No archived weeks yet — the backend either has no <code>metricsDir</code> configured,
							or the current week hasn't been persisted to disk yet.
						</Label>
					)}

					{weeks.length > 0 && (
						<HBox sx={{ gap: "8px", flexWrap: "wrap" }}>
							{weeks.map(w => {
								const active = w === selected;
								return (
									<Box
										key={w}
										onClick={() => setSelected(w)}
										sx={{
											padding: "6px 12px",
											borderRadius: "6px",
											cursor: "pointer",
											fontSize: ".76rem",
											fontFamily: "monospace",
											color: active ? "#fff" : "rgba(255,255,255,.75)",
											backgroundColor: active ? "#5390d9" : "rgba(255,255,255,.05)",
											border: "1px solid " + (active ? "#5390d9" : "rgba(255,255,255,.08)"),
											"&:hover": active
												? undefined
												: { backgroundColor: "rgba(255,255,255,.09)" },
										}}>
										{weekLabel(w)}
									</Box>
								);
							})}
						</HBox>
					)}
				</VBox>
			</Panel>

			{selected && (
				<Panel label={`Week ${weekLabel(selected)}`}>
					<VBox sx={{ gap: "20px" }}>
						<HBox sx={{ gap: "20px", alignItems: "baseline", flexWrap: "wrap" }}>
							<VBox sx={{ gap: "2px" }}>
								<Label>Samples</Label>
								<Typo variant="headMedium">{weekStats.length}</Typo>
							</VBox>
							<VBox sx={{ gap: "2px" }}>
								<Label>Requests</Label>
								<Typo variant="headMedium" sx={{ color: ACCENT }}>
									{totalReq}
								</Typo>
							</VBox>
							<VBox sx={{ gap: "2px" }}>
								<Label>Failed</Label>
								<Typo variant="headMedium" sx={{ color: totalFail > 0 ? FAIL : undefined }}>
									{totalFail}
								</Typo>
							</VBox>
							{weekBusy && <Spinner size={16} />}
						</HBox>

						{weekError && (
							<Typo variant="medium" sx={{ color: FAIL, fontSize: ".85rem" }}>
								{weekError}
							</Typo>
						)}

						{!weekBusy && !weekError && weekStats.length === 0 && (
							<Label>No samples in this week.</Label>
						)}

						{weekStats.length > 0 && (
							<>
								<VBox sx={{ gap: "10px" }}>
									<Label>CPU %</Label>
									<TimeSeriesChart
										series={cpuSeries}
										labels={labels}
										height={180}
										yMax={100}
										formatValue={n => `${Math.round(n * 100) / 100}%`}
									/>
								</VBox>
								<VBox sx={{ gap: "10px" }}>
									<Label>Memory</Label>
									<TimeSeriesChart
										series={memSeries}
										labels={labels}
										height={180}
										formatValue={formatBytes}
									/>
								</VBox>

								{topEndpoints.length > 0 && (
									<VBox sx={{ gap: "8px" }}>
										<Label>Top endpoints</Label>
										{topEndpoints.map(r => (
											<HBox
												key={r.endpoint}
												sx={{ justifyContent: "space-between", gap: "16px" }}>
												<Typo
													variant="medium"
													sx={{
														fontFamily: "monospace",
														fontSize: ".78rem",
														opacity: 0.92,
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
													}}>
													{r.endpoint}
												</Typo>
												<HBox sx={{ gap: "12px", flexShrink: 0 }}>
													<TypoCaption>{r.total}</TypoCaption>
													{r.fail > 0 && (
														<Typo variant="caption" sx={{ color: FAIL, opacity: 1 }}>
															{r.fail} fail
														</Typo>
													)}
												</HBox>
											</HBox>
										))}
									</VBox>
								)}

								{topSql.length > 0 && (
									<VBox sx={{ gap: "8px" }}>
										<Label>Top SQL</Label>
										{topSql.map(r => (
											<HBox
												key={r.query}
												sx={{ justifyContent: "space-between", gap: "16px" }}>
												<Typo
													variant="medium"
													sx={{
														fontFamily: "monospace",
														fontSize: ".76rem",
														opacity: 0.9,
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
													}}>
													{short(r.query)}
												</Typo>
												<HBox sx={{ gap: "12px", flexShrink: 0 }}>
													<TypoCaption>
														{r.success} ok
													</TypoCaption>
													{r.fail > 0 && (
														<Typo variant="caption" sx={{ color: FAIL, opacity: 1 }}>
															{r.fail} fail
														</Typo>
													)}
												</HBox>
											</HBox>
										))}
									</VBox>
								)}
							</>
						)}
					</VBox>
				</Panel>
			)}
		</VBox>
	);
};
