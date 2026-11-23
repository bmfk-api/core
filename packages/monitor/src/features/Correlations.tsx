import { useEffect, useMemo, useState } from "react";
import { styled } from "styled-components";
import { Box, HBox, VBox } from "ui/src/box/Box";
import Panel from "ui/src/panel/Panel";
import { Typo, TypoCaption } from "ui/src/text/Typo";
import { REQ_METRICS, REQ_METRICS_WEEK, REQ_METRICS_WEEKS } from "../services/Metrix";
import { IStat, TRange, TWeekKey } from "../types";
import { Label } from "../components/Label";
import { IChartSeries, TimeSeriesChart } from "../components/TimeSeriesChart";
import { formatBytes, formatTimeLabel } from "../lib/metrics";
import { Spinner } from "ui/src/spinner/Spinner";
import { IError } from "../api/Request";
import { ITheme } from "ui/src/theme/GlobalTheme";

const POLL_MS = 45_000;

const OK = "#56bb56";
const FAIL = "#bb5656";
const WARN = "#e9b61e";
const RSS_COLOR = "#5390d9";
const EXT_COLOR = "#c48af0";

// Common horizontal padding for the four charts so the plot region — and
// therefore every X sample — aligns pixel-perfect across the stack.
const CHART_PAD = { left: 56, right: 16, top: 12, bottom: 26 };
const CHART_HEIGHT = 170;

const ALL = "__all__";

type TSource = "live" | "week";

const HHMM = (ts: number) => {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// Format the archive week label the same way the Archive page does.
const weekLabel = (key: TWeekKey): string => {
	const m = /^(\d{4})-W(\d{1,2})$/.exec(key);
	if (!m) return key;
	const year = +m[1];
	const week = +m[2];
	const jan4 = new Date(year, 0, 4);
	const day = jan4.getDay() || 7;
	const monday = new Date(year, 0, 4 - day + 1 + (week - 1) * 7);
	if (Number.isNaN(monday.getTime())) return key;
	const dd = String(monday.getDate()).padStart(2, "0");
	const mm = String(monday.getMonth() + 1).padStart(2, "0");
	return `${key} · ${dd}.${mm}`;
};

// The backend normalises missing slot fields to {} / 0, so "absent" and
// "empty" both mean "no data for this minute" → a gap, never a zero.
const isEmpty = (obj: Record<string, number> | undefined) => !obj || Object.keys(obj).length === 0;

// Sum a numeric record. When `pick` is set, keep only that key.
const sumVals = (obj: Record<string, number> | undefined, pick?: string): number => {
	if (!obj) return 0;
	if (pick !== undefined) return obj[pick] ?? 0;
	let s = 0;
	for (const k in obj) s += obj[k];
	return s;
};

// Styled native select — keyboard interactions come for free, and we can
// theme it to match SegmentedControl. `Box as="select"` isn't supported by
// the UI kit so we drop straight to styled-components.
const SelectEl = styled.select<{ theme: ITheme }>`
	padding: 6px 10px;
	border-radius: 6px;
	font-size: 0.78rem;
	background-color: rgba(0, 0, 0, 0.25);
	border: 1px solid rgba(255, 255, 255, 0.1);
	color: ${({ theme }) => theme.colors.textPrimary};
	outline: none;
	max-width: 320px;
	&:focus {
		border-color: #5390d9;
	}
`;

const Select = <T extends string>({
	value,
	onChange,
	options,
	width,
}: {
	value: T;
	onChange: (v: T) => void;
	options: { value: T; label: string }[];
	width?: string;
}) => (
	<SelectEl
		value={value}
		onChange={e => onChange(e.target.value as T)}
		style={{ minWidth: width ?? "160px" }}>
		{options.map(o => (
			<option key={o.value} value={o.value}>
				{o.label}
			</option>
		))}
	</SelectEl>
);

// Stack wrapper: a plain div so we can hook onMouseLeave (the kit Box doesn't
// forward DOM events). Used to clear the shared crosshair when the pointer
// leaves the whole 4-chart group.
const Stack = styled.div`
	display: flex;
	flex-direction: column;
	gap: 20px;
`;

const RANGES: { value: TRange; label: string }[] = [
	{ value: "hour", label: "Hour" },
	{ value: "day", label: "Day" },
	{ value: "week", label: "Week" },
];

const ChartRow = ({
	title,
	subtitle,
	children,
}: {
	title: string;
	subtitle?: React.ReactNode;
	children: React.ReactNode;
}) => (
	<VBox sx={{ gap: "8px" }}>
		<HBox sx={{ justifyContent: "space-between", alignItems: "baseline", gap: "12px", flexWrap: "wrap" }}>
			<Typo variant="headMedium">{title}</Typo>
			{subtitle && <TypoCaption>{subtitle}</TypoCaption>}
		</HBox>
		{children}
	</VBox>
);

export const Correlations = () => {
	// Source: live metrics (hour/day/week from RAM ring) or an archived week
	// pulled from disk. Shared so both branches feed the same downstream code.
	const [source, setSource] = useState<TSource>("live");
	const [range, setRange] = useState<TRange>("day");
	const [weekKey, setWeekKey] = useState<TWeekKey | "">("");
	const [weeks, setWeeks] = useState<TWeekKey[]>([]);

	const [stats, setStats] = useState<IStat[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<IError | null>(null);
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);

	// Selectors — populated from the union of keys across the current stats.
	const [endpoint, setEndpoint] = useState<string>(ALL);
	const [host, setHost] = useState<string>(ALL);

	// Shared crosshair. Cleared only when the pointer leaves the whole stack —
	// each individual chart is in controlled-hover mode and doesn't clear on
	// its own MouseLeave.
	const [hover, setHover] = useState<number | null>(null);

	// -------- data loading --------

	const [, getMetrics] = REQ_METRICS.useRequest(response => {
		setBusy(false);
		if (response?.error) {
			setError(response.error);
			return;
		}
		setError(null);
		setStats(response?.data ?? []);
		setUpdatedAt(Date.now());
	});
	const [, getWeeks] = REQ_METRICS_WEEKS.useRequest(response => {
		if (response?.error) return;
		const list = [...(response?.data ?? [])].sort().reverse();
		setWeeks(list);
	});
	const [, getWeek] = REQ_METRICS_WEEK.useRequest(response => {
		setBusy(false);
		// Ignore the mount-fire sentinel (see REQ_METRICS_WEEK definition).
		if (!response || (response.httpStatus === 0 && !response.data && !response.error)) return;
		if (response.error) {
			setError(response.error);
			return;
		}
		setError(null);
		setStats(response.data ?? []);
		setUpdatedAt(Date.now());
	});

	// Prefetch the archive list up front — needed to enable the archive mode.
	useEffect(() => {
		getWeeks();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Refetch whenever the source or its parameter changes.
	useEffect(() => {
		setBusy(true);
		if (source === "live") {
			getMetrics({ range });
		} else if (weekKey) {
			getWeek({ weekKey });
		} else {
			setBusy(false);
			setStats([]);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source, range, weekKey]);

	// Auto-refresh live metrics only. Archive slices are frozen — no point
	// hammering the same disk read.
	useEffect(() => {
		if (source !== "live") return;
		const id = window.setInterval(() => getMetrics({ range }), POLL_MS);
		return () => window.clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source, range]);

	// -------- derived selectors --------

	const endpointKeys = useMemo(() => {
		const set = new Set<string>();
		for (const s of stats) {
			for (const k in s.slot.successEp) set.add(k);
			for (const k in s.slot.failEp) set.add(k);
		}
		return [...set].sort();
	}, [stats]);

	const hostKeys = useMemo(() => {
		const set = new Set<string>();
		for (const s of stats) {
			for (const k in s.slot.http_ok ?? {}) set.add(k);
			for (const k in s.slot.http_fail ?? {}) set.add(k);
			for (const k in s.slot.httpP95 ?? {}) set.add(k);
		}
		return [...set].sort();
	}, [stats]);

	// Reset a selector if its previous value no longer exists in the new data.
	useEffect(() => {
		if (endpoint !== ALL && !endpointKeys.includes(endpoint)) setEndpoint(ALL);
	}, [endpointKeys, endpoint]);
	useEffect(() => {
		if (host !== ALL && !hostKeys.includes(host)) setHost(ALL);
	}, [hostKeys, host]);

	// -------- series --------

	const labels = useMemo(
		() => stats.map(s => formatTimeLabel(s.timestamp, source === "live" ? range : "day")),
		[stats, source, range],
	);

	const incomingSeries = useMemo<IChartSeries[]>(() => {
		const pick = endpoint === ALL ? undefined : endpoint;
		return [
			{ name: "OK", color: OK, values: stats.map(s => sumVals(s.slot.successEp, pick)) },
			{ name: "FAIL", color: FAIL, values: stats.map(s => sumVals(s.slot.failEp, pick)) },
		];
	}, [stats, endpoint]);

	const outgoingSeries = useMemo<IChartSeries[]>(() => {
		const pick = host === ALL ? undefined : host;
		return [
			{
				name: "OK",
				color: OK,
				values: stats.map(s => {
					// Pre-upgrade slots (or minutes with no outgoing calls) — gap.
					if (isEmpty(s.slot.http_ok) && isEmpty(s.slot.http_fail)) return NaN;
					return sumVals(s.slot.http_ok, pick);
				}),
			},
			{
				name: "FAIL",
				color: FAIL,
				values: stats.map(s => {
					if (isEmpty(s.slot.http_ok) && isEmpty(s.slot.http_fail)) return NaN;
					return sumVals(s.slot.http_fail, pick);
				}),
			},
		];
	}, [stats, host]);

	const memorySeries = useMemo<IChartSeries[]>(
		() => [
			{
				name: "rss",
				color: RSS_COLOR,
				values: stats.map(s => s.slot.memory.rss * 1024 * 1024),
			},
			{
				name: "external",
				color: EXT_COLOR,
				values: stats.map(s => {
					// external was added later than rss/heap. If the slot's memory
					// object doesn't carry it, render a gap.
					const v = s.slot.memory.external;
					if (typeof v !== "number" || v <= 0) return NaN;
					return v * 1024 * 1024;
				}),
			},
		],
		[stats],
	);

	const p95Series = useMemo<IChartSeries[]>(() => {
		const values = stats.map(s => {
			const rec = s.slot.httpP95;
			if (isEmpty(rec)) return NaN;
			// 0 / missing key = no requests to that host this minute → gap.
			if (host === ALL) {
				// Percentiles aren't summable — MAX across hosts shows the
				// worst-performing partner per slot.
				let m = 0;
				for (const k in rec) if (rec![k] > m) m = rec![k];
				return m > 0 ? m : NaN;
			}
			const v = rec![host];
			return typeof v === "number" && v > 0 ? v : NaN;
		});
		return [{ name: host === ALL ? "max p95 (all hosts)" : "p95", color: WARN, values }];
	}, [stats, host]);

	// -------- rendering --------

	const empty = stats.length === 0;
	const anyOutgoing = stats.some(s => !isEmpty(s.slot.http_ok) || !isEmpty(s.slot.http_fail));
	const anyP95 = stats.some(s => !isEmpty(s.slot.httpP95));

	const endpointOptions = [{ value: ALL, label: "All endpoints" }, ...endpointKeys.map(k => ({ value: k, label: k }))];
	const hostOptions = [{ value: ALL, label: "All hosts" }, ...hostKeys.map(k => ({ value: k, label: k }))];
	const weekOptions = [
		{ value: "", label: weeks.length ? "Pick a week…" : "No archived weeks" },
		...weeks.map(w => ({ value: w, label: weekLabel(w) })),
	];

	return (
		<VBox sx={{ gap: "20px" }}>
			<Panel label="Correlations">
				<VBox sx={{ gap: "16px" }}>
					<HBox sx={{ gap: "16px", flexWrap: "wrap", alignItems: "center" }}>
						<HBox sx={{ gap: "6px", alignItems: "center" }}>
							<Label>Source</Label>
							<Select
								value={source}
								onChange={v => setSource(v)}
								width="120px"
								options={[
									{ value: "live", label: "Live" },
									{ value: "week", label: "Archive" },
								]}
							/>
						</HBox>

						{source === "live" ? (
							<HBox sx={{ gap: "6px", alignItems: "center" }}>
								<Label>Range</Label>
								<Select
									value={range}
									onChange={v => setRange(v)}
									width="120px"
									options={RANGES}
								/>
							</HBox>
						) : (
							<HBox sx={{ gap: "6px", alignItems: "center" }}>
								<Label>Week</Label>
								<Select
									value={weekKey}
									onChange={v => setWeekKey(v as TWeekKey)}
									width="200px"
									options={weekOptions}
								/>
							</HBox>
						)}

						<HBox sx={{ gap: "6px", alignItems: "center" }}>
							<Label>Endpoint</Label>
							<Select value={endpoint} onChange={v => setEndpoint(v)} options={endpointOptions} />
						</HBox>

						<HBox sx={{ gap: "6px", alignItems: "center" }}>
							<Label>Host</Label>
							<Select value={host} onChange={v => setHost(v)} options={hostOptions} />
						</HBox>

						<HBox sx={{ gap: "10px", alignItems: "center", marginLeft: "auto" }}>
							{busy && <Spinner size={14} />}
							{updatedAt && (
								<TypoCaption>Updated {new Date(updatedAt).toLocaleTimeString()}</TypoCaption>
							)}
							<Box
								onClick={() => {
									setBusy(true);
									if (source === "live") getMetrics({ range });
									else if (weekKey) getWeek({ weekKey });
								}}
								sx={{
									padding: "6px 12px",
									borderRadius: "6px",
									cursor: "pointer",
									fontSize: ".72rem",
									fontWeight: 600,
									letterSpacing: ".06em",
									textTransform: "uppercase",
									color: "#fff",
									backgroundColor: "#5390d9",
									"&:hover": { backgroundColor: "#4b83c7" },
								}}>
								Refresh
							</Box>
						</HBox>
					</HBox>

					{error && (
						<Box
							sx={{
								padding: "10px 12px",
								borderRadius: "6px",
								backgroundColor: "rgba(187,86,86,.12)",
								border: "1px solid rgba(187,86,86,.35)",
							}}>
							<Typo variant="medium" sx={{ color: FAIL, fontSize: ".85rem" }}>
								{error.code === 401
									? "No access — check monitor credentials."
									: error.details || error.message}
							</Typo>
						</Box>
					)}

					{!error && empty && !busy && (
						<Label>No metrics data for the current selection.</Label>
					)}
				</VBox>
			</Panel>

			{!empty && !error && (
				<Stack onMouseLeave={() => setHover(null)}>
					<Panel>
						<ChartRow
							title="Incoming requests"
							subtitle={endpoint === ALL ? "all endpoints, per slot" : endpoint}>
							<TimeSeriesChart
								series={incomingSeries}
								labels={labels}
								height={CHART_HEIGHT}
								padding={CHART_PAD}
								hover={hover}
								onHoverChange={setHover}
								formatValue={n => Math.round(n).toString()}
							/>
						</ChartRow>
					</Panel>

					<Panel>
						<ChartRow
							title="Outgoing requests"
							subtitle={
								anyOutgoing
									? host === ALL
										? "all hosts, per slot"
										: host
									: "Slots don't carry outgoing counters yet (backend older than the http_ok/http_fail upgrade)."
							}>
							<TimeSeriesChart
								series={outgoingSeries}
								labels={labels}
								height={CHART_HEIGHT}
								padding={CHART_PAD}
								hover={hover}
								onHoverChange={setHover}
								formatValue={n => Math.round(n).toString()}
							/>
						</ChartRow>
					</Panel>

					<Panel>
						<ChartRow title="Memory" subtitle="rss and external, MB">
							<TimeSeriesChart
								series={memorySeries}
								labels={labels}
								height={CHART_HEIGHT}
								padding={CHART_PAD}
								hover={hover}
								onHoverChange={setHover}
								formatValue={formatBytes}
							/>
						</ChartRow>
					</Panel>

					<Panel>
						<ChartRow
							title="Outgoing p95 (ms)"
							subtitle={
								anyP95
									? host === ALL
										? "worst host per slot"
										: host
									: "Slots don't carry per-slot p95 yet (backend older than the httpP95 upgrade)."
							}>
							<TimeSeriesChart
								series={p95Series}
								labels={labels}
								height={CHART_HEIGHT}
								padding={CHART_PAD}
								hover={hover}
								onHoverChange={setHover}
								formatValue={n => `${Math.round(n)} ms`}
							/>
						</ChartRow>
					</Panel>

					{hover !== null && stats[hover] && (
						<Label sx={{ fontSize: ".72rem" }}>
							Focused slot: <b>{new Date(stats[hover].timestamp).toLocaleString()}</b> ·
							{" "}
							{HHMM(stats[hover].timestamp)}
						</Label>
					)}
				</Stack>
			)}
		</VBox>
	);
};
