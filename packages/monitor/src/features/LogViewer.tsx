import { useEffect, useMemo, useState } from "react";
import { styled } from "styled-components";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { TextInput } from "../components/TextInput";
import { Typo } from "ui/src/text/Typo";
import { ITheme } from "ui/src/theme/GlobalTheme";
import { REQ_CHANGE_LOG_LEVEL, REQ_LOG } from "../services/Metrix";
import { can } from "../services/Auth";
import { ILogItem, LOG_LEVELS, TLogLevel } from "../types";
import { usePolling } from "../hooks/usePolling";
import { Modal } from "../components/Modal";
import { Label } from "../components/Label";
import { TimeSeriesChart } from "../components/TimeSeriesChart";
import { TOpenTrace, TraceCell, TraceInfo } from "../components/TraceLink";

const ACTIVITY_BUCKETS = 32;

const POLL_MS = 15_000;
const MAX_ITEMS = 1000;
const VISIBLE_LIMIT = 200;

const LEVEL_VALUES: Record<string, number> = { ALL: 10, API: 19, INFO: 20, DB: 25, WARN: 30, ERROR: 40, CRIT: 50 };

const levelValue = (level: string): number => {
	const numeric = parseInt(level, 10);
	return Number.isNaN(numeric) ? LEVEL_VALUES[level?.toUpperCase()] ?? 20 : numeric;
};

const resolveLevel = (level: string): { label: string; color: string } => {
	const numeric = parseInt(level, 10);
	const value = levelValue(level);
	const named = Object.entries(LEVEL_VALUES).find(([, v]) => v === value)?.[0];
	const label = (Number.isNaN(numeric) ? level : named ?? level)?.toUpperCase() ?? "LOG";

	let color = "#8a8699";
	if (value >= 50) color = "#e0457b";
	else if (value >= 40) color = "#bb5656";
	else if (value >= 30) color = "#e9b61e";
	else if (value >= 25) color = "#56cfe1";
	else if (value >= 20) color = "#5390d9";
	return { label, color };
};

const ERROR_LEVEL = LEVEL_VALUES.ERROR;

// A log message is treated as an error when it carries a JSON payload with a
// non-null error and a null data field (e.g. an API request/response dump).
const isErrorPayload = (text: string): boolean => {
	let t = (text ?? "").trim();
	if (t.startsWith(",")) t = t.substring(1).trim();
	if (!t.startsWith("{") && !t.startsWith("[")) return false;
	try {
		const o = JSON.parse(t);
		return !!o && typeof o === "object" && (o as Record<string, unknown>).error != null && (o as Record<string, unknown>).data == null;
	} catch {
		return false;
	}
};

const prettify = (text: string): { pretty: string; isJson: boolean } => {
	let t = (text ?? "").trim();
	if (t.startsWith(",")) t = t.substring(1).trim();
	if (t.startsWith("{") || t.startsWith("[")) {
		try {
			return { pretty: JSON.stringify(JSON.parse(t), null, 2), isJson: true };
		} catch {
			/* not valid json */
		}
	}
	return { pretty: t, isJson: false };
};

const Row = styled.div<{ theme: ITheme; $error?: boolean }>`
	display: grid;
	grid-template-columns: 64px 56px 150px 76px 1fr;
	align-items: center;
	gap: 12px;
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

const LevelSelect = styled.select<{ theme: ITheme }>`
	padding: 8px 10px;
	border-radius: 6px;
	font-size: 0.8rem;
	color: ${({ theme }) => theme.colors.textPrimary};
	background-color: ${({ theme }) => theme.colors.inputBackgroundPrimary};
	border: 1px solid ${({ theme }) => theme.colors.inputBorderPrimary};
	outline: none;
	cursor: pointer;
`;

const Pre = styled.pre`
	margin: 0;
	white-space: pre-wrap;
	word-break: break-word;
	font-family: monospace;
	font-size: 0.8rem;
	line-height: 1.45;
	color: #9ffe19;
	background-color: rgba(0, 0, 0, 0.35);
	border-radius: 6px;
	padding: 14px;
	max-height: 55vh;
	overflow: auto;
`;

const LevelBadge = ({ level }: { level: string }) => {
	const { label, color } = resolveLevel(level);
	return (
		<Box
			sx={{
				padding: "2px 6px",
				borderRadius: "4px",
				fontSize: ".66rem",
				fontWeight: 600,
				letterSpacing: ".03em",
				textAlign: "center",
				color,
				border: "1px solid " + color + "55",
				backgroundColor: color + "1a",
			}}>
			{label}
		</Box>
	);
};

export const LogViewer = ({ trace, onTrace }: { trace?: string; onTrace: TOpenTrace }) => {
	const [items, setItems] = useState<ILogItem[]>([]);
	const [search, setSearch] = useState(trace ?? "");
	const [selected, setSelected] = useState<ILogItem | null>(null);
	// Opened from a trace link in another journal: start filtered by that trace.
	useEffect(() => {
		if (trace) {
			setSearch(trace);
			setSelected(null);
		}
	}, [trace]);

	const [logLevel, setLogLevel] = useState<TLogLevel | "">("");
	const [expanded, setExpanded] = useState(false);

	const [, getLog] = REQ_LOG.useRequest(response => {
		const incoming = response?.data?.log;
		if (!Array.isArray(incoming) || incoming.length === 0) return;
		setItems(prev => {
			const byId = new Map(prev.map(i => [i.id, i]));
			for (const i of incoming) if (i && typeof i.id === "number") byId.set(i.id, i);
			return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, MAX_ITEMS);
		});
	});

	usePolling(() => {
		const lastID = items.reduce((max, i) => Math.max(max, i.id), 0);
		getLog({ lastID });
	}, POLL_MS);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		const threshold = logLevel ? LEVEL_VALUES[logLevel] : null;
		return items.filter(i => {
			if (threshold !== null && levelValue(String(i.level)) < threshold) return false;
			if (q && !(i.text?.toLowerCase().includes(q) || i.source?.toLowerCase().includes(q) || i.traceId?.toLowerCase().includes(q))) return false;
			return true;
		});
	}, [items, search, logLevel]);

	// Time-series of log volume per level across all loaded entries — a quick
	// "are errors spiking?" overview, independent of the search/level filter.
	const activity = useMemo(() => {
		const empty = { labels: [] as string[], series: [] as { name: string; color: string; values: number[] }[] };
		const timed = items
			.map(i => ({
				t: i.time || new Date(i.date).getTime(),
				v: isErrorPayload(i.text) ? ERROR_LEVEL : levelValue(String(i.level)),
			}))
			.filter(i => !Number.isNaN(i.t));
		if (timed.length === 0) return empty;

		const min = Math.min(...timed.map(i => i.t));
		const max = Math.max(...timed.map(i => i.t));
		const bucketMs = Math.max(1, (max - min) / ACTIVITY_BUCKETS);

		const levels = [...new Set(timed.map(i => i.v))].sort((a, b) => a - b);
		const counts = new Map<number, number[]>(levels.map(l => [l, new Array(ACTIVITY_BUCKETS).fill(0)]));
		for (const { t, v } of timed) {
			const idx = Math.min(ACTIVITY_BUCKETS - 1, Math.floor((t - min) / bucketMs));
			counts.get(v)![idx]++;
		}

		const labels = Array.from({ length: ACTIVITY_BUCKETS }, (_, b) =>
			new Date(min + (b + 0.5) * bucketMs).toLocaleTimeString(),
		);
		const series = levels.map(l => {
			const meta = resolveLevel(String(l));
			return { name: meta.label, color: meta.color, values: counts.get(l)! };
		});
		return { labels, series };
	}, [items]);

	// Everyone can filter the loaded items locally; only admins also switch the
	// server's log level (changeLogLevel is an admin endpoint).
	const isAdmin = can("admin");
	const changeLevel = (level: TLogLevel) => {
		setLogLevel(level);
		if (isAdmin) REQ_CHANGE_LOG_LEVEL.request(level);
	};

	const detail = selected ? prettify(selected.text) : null;

	return (
		<>
			<VBox sx={{ gap: "16px" }}>
				{activity.series.length > 0 && (
					<VBox sx={{ gap: "6px" }}>
						<Label>Activity by level</Label>
						<TimeSeriesChart height={140} labels={activity.labels} series={activity.series} />
					</VBox>
				)}
				<HBox sx={{ gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
					<Box sx={{ flexGrow: 1, minWidth: "200px" }}>
						<TextInput
							type="search"
							value={search}
							placeholder="Search by message, source or trace…"
							onChange={e => setSearch(e.target.value)}
						/>
					</Box>
					<HBox sx={{ gap: "8px", alignItems: "center" }}>
						<Label>{isAdmin ? "Level" : "Show from"}</Label>
						<LevelSelect value={logLevel} onChange={e => changeLevel(e.target.value as TLogLevel)}>
							<option value="" disabled>
								set…
							</option>
							{LOG_LEVELS.map(l => (
								<option key={l} value={l}>
									{l}
								</option>
							))}
						</LevelSelect>
					</HBox>
					<Label>
						{filtered.length} / {items.length}
					</Label>
				</HBox>

				<VBox sx={{ border: "1px solid rgba(255,255,255,.06)", borderRadius: "8px", overflow: "hidden" }}>
					<Row as="div" style={{ cursor: "default", opacity: 0.55, fontWeight: 600 }}>
						<Cell>LEVEL</Cell>
						<Cell>ID</Cell>
						<Cell>TIME</Cell>
						<Cell>TRACE</Cell>
						<Cell>MESSAGE</Cell>
					</Row>
					{(expanded ? filtered : filtered.slice(0, VISIBLE_LIMIT)).map(item => (
						<Row key={item.id} $error={isErrorPayload(item.text)} onClick={() => setSelected(item)}>
							<LevelBadge level={String(item.level)} />
							<Cell style={{ opacity: 0.6 }}>{item.id}</Cell>
							<Cell style={{ opacity: 0.8 }}>
								{new Date(item.time || item.date).toLocaleTimeString()}
							</Cell>
							<TraceCell traceId={item.traceId} onClick={setSearch} />
							<Cell style={{ fontFamily: "monospace", opacity: 0.92 }}>{(item.text ?? "").trim()}</Cell>
						</Row>
					))}
					{filtered.length === 0 && (
						<Box sx={{ padding: "16px" }}>
							<Label>No log entries</Label>
						</Box>
					)}
					{filtered.length > VISIBLE_LIMIT && (
						<Box
							onClick={() => setExpanded(v => !v)}
							sx={{
								padding: "12px",
								textAlign: "center",
								cursor: "pointer",
								fontSize: ".76rem",
								fontWeight: 600,
								letterSpacing: ".04em",
								textTransform: "uppercase",
								color: "#5390d9",
								borderTop: "1px solid rgba(255,255,255,.06)",
								"&:hover": { backgroundColor: "rgba(255,255,255,.04)" },
							}}>
							{expanded ? "Свернуть" : `Развернуть (ещё ${filtered.length - VISIBLE_LIMIT})`}
						</Box>
					)}
				</VBox>
			</VBox>

			{selected && (
				<Modal title={`Log #${selected.id}`} onClose={() => setSelected(null)}>
					<VBox sx={{ gap: "16px" }}>
						<HBox sx={{ gap: "24px", flexWrap: "wrap", alignItems: "center" }}>
							<LevelBadge level={String(selected.level)} />
							<VBox sx={{ gap: "2px" }}>
								<Label>Time</Label>
								<Typo variant="medium">{new Date(selected.time || selected.date).toLocaleString()}</Typo>
							</VBox>
							{selected.source && (
								<VBox sx={{ gap: "2px" }}>
									<Label>Source</Label>
									<Typo variant="medium">{selected.source}</Typo>
								</VBox>
							)}
							{selected.repeat ? (
								<VBox sx={{ gap: "2px" }}>
									<Label>Repeat</Label>
									<Typo variant="medium">×{selected.repeat}</Typo>
								</VBox>
							) : null}
						</HBox>
						<TraceInfo
							traceId={selected.traceId}
							onOpen={(id, tab) => {
								// Same journal: the effect on `trace` may not fire again, so filter here too.
								setSelected(null);
								setSearch(id);
								onTrace(id, tab);
							}}
						/>
						<VBox sx={{ gap: "6px" }}>
							<Label>{detail?.isJson ? "Payload (JSON)" : "Message"}</Label>
							<Pre>{detail?.pretty}</Pre>
						</VBox>
					</VBox>
				</Modal>
			)}
		</>
	);
};
