import { useEffect, useState } from "react";
import { styled } from "styled-components";
import { Box, HBox, VBox } from "ui/src/box/Box";
import Panel from "ui/src/panel/Panel";
import { Typo } from "ui/src/text/Typo";
import { REQ_DB_HEALTH } from "../services/Metrix";
import { IDbHealth, IDbLongQuery, TRange } from "../types";
import { formatTimeLabel, slotToTimestamp } from "../lib/metrics";
import { usePolling } from "../hooks/usePolling";
import { TimeSeriesChart } from "../components/TimeSeriesChart";
import { Modal } from "../components/Modal";
import { Label } from "../components/Label";

const POLL_MS = 30_000;
const SUCCESS = "#56bb56";
const FAIL = "#bb5656";
const ACCENT = "#48BFE3";

const formatMs = (n: number): string => (n >= 1000 ? (n / 1000).toFixed(2) + " s" : Math.round(n) + " ms");

const Pre = styled.pre`
	margin: 0;
	white-space: pre-wrap;
	word-break: break-word;
	font-family: monospace;
	font-size: 0.8rem;
	line-height: 1.5;
	color: #9ffe19;
	background-color: rgba(0, 0, 0, 0.35);
	border-radius: 6px;
	padding: 14px;
	max-height: 60vh;
	overflow: auto;
`;

const QueryRow = styled.div`
	display: grid;
	grid-template-columns: 1fr auto;
	gap: 12px;
	align-items: baseline;
	padding: 6px 0;
	border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	cursor: pointer;
	font-size: 0.76rem;
	&:hover {
		background-color: rgba(255, 255, 255, 0.04);
	}
`;

const Metric = ({ label, value, color }: { label: string; value: string; color?: string }) => (
	<VBox sx={{ gap: "2px", minWidth: "70px" }}>
		<Label>{label}</Label>
		<Typo variant="headMedium" sx={color ? { color } : undefined}>
			{value}
		</Typo>
	</VBox>
);

const InstanceCard = ({ db, range }: { db: IDbHealth; range: TRange }) => {
	const [query, setQuery] = useState<IDbLongQuery | null>(null);

	const frames = db.stat ?? [];
	const online = db.poolStatus !== null;

	const labels = frames.map(f => formatTimeLabel(slotToTimestamp(f.slot), range));
	const totalQueries = frames.reduce((s, f) => s + f.totalQueries, 0);
	const failedQueries = frames.reduce((s, f) => s + f.failedQueries, 0);
	const transactions = frames.reduce((s, f) => s + f.transactionsCount, 0);
	const weightedAvg = totalQueries
		? frames.reduce((s, f) => s + f.averageQueryTime * f.totalQueries, 0) / totalQueries
		: 0;
	const maxTime = frames.reduce((m, f) => Math.max(m, f.maxQueryTime), 0);

	const longest = frames
		.flatMap(f => f.longestQueries ?? [])
		.sort((a, b) => b.execution - a.execution)
		.slice(0, 10);

	const pool = db.poolStatus;
	const utilization = pool && pool.poolConnections ? (pool.acquiredPoolConnections / pool.poolConnections) * 100 : 0;

	return (
		<VBox
			sx={{
				gap: "18px",
				padding: "18px",
				border: "1px solid rgba(255,255,255,.08)",
				borderRadius: "8px",
				backgroundColor: "rgba(0,0,0,.12)",
			}}>
			{/* Header: availability + host */}
			<HBox sx={{ justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
				<HBox sx={{ gap: "10px", alignItems: "center" }}>
					<Box
						sx={{
							width: "9px",
							height: "9px",
							borderRadius: "50%",
							backgroundColor: online ? SUCCESS : FAIL,
							boxShadow: `0 0 8px ${online ? SUCCESS : FAIL}`,
						}}
					/>
					<VBox sx={{ gap: "1px" }}>
						<Typo variant="medium" sx={{ fontFamily: "monospace" }}>
							{db.host}:{db.port}
						</Typo>
						<Label sx={{ fontSize: ".66rem" }}>{db.id}</Label>
					</VBox>
				</HBox>
				<Box
					sx={{
						padding: "3px 9px",
						borderRadius: "4px",
						fontSize: ".68rem",
						fontWeight: 600,
						letterSpacing: ".04em",
						color: online ? SUCCESS : FAIL,
						border: `1px solid ${(online ? SUCCESS : FAIL) + "55"}`,
						backgroundColor: (online ? SUCCESS : FAIL) + "1a",
					}}>
					{online ? "ONLINE" : "UNAVAILABLE"}
				</Box>
			</HBox>

			{/* Pool status */}
			{pool && (
				<VBox sx={{ gap: "6px" }}>
					<HBox sx={{ justifyContent: "space-between", alignItems: "baseline", gap: "12px" }}>
						<Label>Pool (acquired / total)</Label>
						<Typo variant="medium">
							{pool.acquiredPoolConnections} / {pool.poolConnections}
						</Typo>
					</HBox>
					<Box
						sx={{
							height: "6px",
							width: "100%",
							backgroundColor: "rgba(255,255,255,.06)",
							borderRadius: "3px",
							overflow: "hidden",
						}}>
						<Box
							sx={{
								height: "100%",
								width: Math.min(100, utilization) + "%",
								backgroundColor: utilization > 85 ? FAIL : ACCENT,
							}}
						/>
					</Box>
					<Label sx={{ fontSize: ".68rem" }}>Last success: {pool.lastSuccessQueryTime || "—"}</Label>
				</VBox>
			)}

			{/* Summary metrics */}
			<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
				<Metric label="Queries" value={String(totalQueries)} />
				<Metric label="Failed" value={String(failedQueries)} color={failedQueries ? FAIL : undefined} />
				<Metric label="Transactions" value={String(transactions)} />
				<Metric label="Avg time" value={formatMs(weightedAvg)} color={ACCENT} />
				<Metric label="Max time" value={formatMs(maxTime)} />
			</HBox>

			{/* Charts */}
			{frames.length > 0 && (
				<>
					<VBox sx={{ gap: "6px" }}>
						<Label>Queries / failed</Label>
						<TimeSeriesChart
							height={150}
							labels={labels}
							series={[
								{ name: "Queries", color: ACCENT, values: frames.map(f => f.totalQueries) },
								{ name: "Failed", color: FAIL, values: frames.map(f => f.failedQueries) },
							]}
						/>
					</VBox>
					<VBox sx={{ gap: "6px" }}>
						<Label>Avg query time</Label>
						<TimeSeriesChart
							height={150}
							labels={labels}
							formatValue={formatMs}
							series={[{ name: "Avg", color: "#80FFDB", values: frames.map(f => f.averageQueryTime) }]}
						/>
					</VBox>
				</>
			)}

			{/* Longest queries */}
			<VBox sx={{ gap: "4px" }}>
				<Label>Longest queries</Label>
				{longest.length === 0 && <Label sx={{ fontSize: ".7rem" }}>No slow queries recorded</Label>}
				{longest.map((q, i) => (
					<QueryRow key={i} onClick={() => setQuery(q)}>
						<Box
							sx={{
								fontFamily: "monospace",
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
								opacity: 0.9,
							}}>
							{q.query}
						</Box>
						<Box sx={{ color: q.execution >= 1000 ? FAIL : ACCENT, whiteSpace: "nowrap" }}>
							{formatMs(q.execution)}
						</Box>
					</QueryRow>
				))}
			</VBox>

			{query && (
				<Modal title={`Query · ${formatMs(query.execution)}`} onClose={() => setQuery(null)}>
					<Pre>{query.query}</Pre>
				</Modal>
			)}
		</VBox>
	);
};

export const Database = ({ range }: { range: TRange }) => {
	const [instances, setInstances] = useState<IDbHealth[]>([]);

	const [, getDb] = REQ_DB_HEALTH.useRequest(response => {
		if (response?.error) return;
		setInstances(response?.data ?? []);
	});

	useEffect(() => {
		getDb({ range });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [range]);

	usePolling(() => getDb({ range }), POLL_MS);

	return (
		<Panel label="Database">
			<VBox sx={{ gap: "20px" }}>
				{instances.length === 0 && <Label>No database instances</Label>}
				{instances.map(db => (
					<InstanceCard key={db.id} db={db} range={range} />
				))}
			</VBox>
		</Panel>
	);
};
