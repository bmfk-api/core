import { useState } from "react";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";
import { REQ_PROCINFO } from "../services/Metrix";
import { IProcInfo } from "../types";
import { usePolling } from "../hooks/usePolling";
import { formatBytes, formatDuration } from "../lib/metrics";
import { Label } from "../components/Label";
import { PmRestart } from "./PmRestart";

const POLL_MS = 30_000;
const ACCENT = "#48BFE3";
const FAIL = "#bb5656";
const WARN = "#e9b61e";

const usageColor = (pct: number) => (pct >= 90 ? FAIL : pct >= 75 ? WARN : ACCENT);

const ProgressBar = ({ pct, color }: { pct: number; color?: string }) => (
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
				width: Math.min(100, Math.max(0, pct)) + "%",
				backgroundColor: color ?? usageColor(pct),
				transition: "width .25s",
			}}
		/>
	</Box>
);

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

export const ProcInfo = () => {
	const [data, setData] = useState<IProcInfo | null>(null);

	const [, getProcInfo] = REQ_PROCINFO.useRequest(response => {
		if (response?.error) return;
		if (response?.data) setData(response.data);
	});

	usePolling(() => getProcInfo(), POLL_MS);

	if (!data) return <Label>Loading…</Label>;

	const id = data.identity;
	const m = data.memory;
	const cpu = data.cpu;
	const el = data.eventLoop;
	const gc = data.gc;
	const fd = data.fileDescriptors;
	const heapPct = m.heap.sizeLimit ? (m.heapUsed / m.heap.sizeLimit) * 100 : 0;
	const fdPct = fd.open != null && fd.limitSoft ? (fd.open / fd.limitSoft) * 100 : 0;

	return (
		<VBox sx={{ gap: "16px" }}>
			<Section title="pm2">
				<PmRestart data={data} />
			</Section>

			<Section title="Identity">
				<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
					<Metric label="PID" value={id.pid} />
					<Metric label="Host" value={id.hostname} />
					<Metric label="Node" value={id.nodeVersion} />
					<Metric label="V8" value={id.v8Version} />
					<Metric label="Platform" value={`${id.platform} / ${id.arch}`} />
					<Metric label="Cores" value={id.availableParallelism} />
					<Metric label="Uptime" value={formatDuration(id.uptimeSec)} />
				</HBox>
				{id.execPath && (
					<VBox sx={{ gap: "2px" }}>
						<Label>Exec path</Label>
						<Typo variant="medium" sx={{ fontFamily: "monospace", opacity: 0.9, wordBreak: "break-all" }}>
							{id.execPath}
						</Typo>
					</VBox>
				)}
				{id.cwd && (
					<VBox sx={{ gap: "2px" }}>
						<Label>CWD</Label>
						<Typo variant="medium" sx={{ fontFamily: "monospace", opacity: 0.9, wordBreak: "break-all" }}>
							{id.cwd}
						</Typo>
					</VBox>
				)}
			</Section>

			<Section title="Memory">
				<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
					<Metric label="RSS" value={formatBytes(m.rss)} />
					<Metric label="Heap used" value={formatBytes(m.heapUsed)} color={usageColor(heapPct)} />
					<Metric label="Heap total" value={formatBytes(m.heapTotal)} />
					<Metric label="Heap limit" value={formatBytes(m.heap.sizeLimit)} />
					<Metric label="External" value={formatBytes(m.external)} />
					<Metric label="ArrayBuffers" value={formatBytes(m.arrayBuffers)} />
				</HBox>
				<VBox sx={{ gap: "4px" }}>
					<HBox sx={{ justifyContent: "space-between" }}>
						<Label>Heap used / limit</Label>
						<Typo variant="medium">{heapPct.toFixed(1)}%</Typo>
					</HBox>
					<ProgressBar pct={heapPct} />
				</VBox>
				{m.heap.numberOfDetachedContexts > 0 && (
					<Label sx={{ color: FAIL }}>
						Detached contexts: {m.heap.numberOfDetachedContexts} (possible leak)
					</Label>
				)}
				{m.heapSpaces.length > 0 && (
					<VBox sx={{ gap: "6px" }}>
						<Label>Heap spaces</Label>
						{m.heapSpaces.map(s => {
							const pct = s.size ? (s.used / s.size) * 100 : 0;
							return (
								<VBox key={s.name} sx={{ gap: "4px" }}>
									<HBox sx={{ justifyContent: "space-between", gap: "12px" }}>
										<Typo variant="medium" sx={{ fontFamily: "monospace", opacity: 0.9 }}>
											{s.name}
										</Typo>
										<Label>
											{formatBytes(s.used)} / {formatBytes(s.size)}
										</Label>
									</HBox>
									<ProgressBar pct={pct} />
								</VBox>
							);
						})}
					</VBox>
				)}
			</Section>

			<Section title="CPU">
				<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
					<Metric label="User" value={`${cpu.userPct}%`} color={ACCENT} />
					<Metric label="System" value={`${cpu.systemPct}%`} color="#80FFDB" />
					{cpu.resource && (
						<>
							<Metric label="Max RSS" value={formatBytes(cpu.resource.maxRSS * 1024)} />
							<Metric label="Ctx (vol)" value={cpu.resource.voluntaryContextSwitches} />
							<Metric label="Ctx (invol)" value={cpu.resource.involuntaryContextSwitches} />
							<Metric label="FS read/write" value={`${cpu.resource.fsRead} / ${cpu.resource.fsWrite}`} />
						</>
					)}
				</HBox>
			</Section>

			{el && (
				<Section title="Event loop">
					<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
						<Metric
							label="Utilization"
							value={`${el.utilizationPct}%`}
							color={usageColor(el.utilizationPct)}
						/>
						<Metric label="Spot lag" value={`${el.spotLagMs} ms`} />
						<Metric label="Active handles" value={el.activeHandles} />
						<Metric label="Active requests" value={el.activeRequests} />
					</HBox>
					<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
						<Metric label="Mean lag" value={`${el.meanMs.toFixed(2)} ms`} />
						<Metric label="p50" value={`${el.p50Ms.toFixed(2)} ms`} />
						<Metric
							label="p90"
							value={`${el.p90Ms.toFixed(2)} ms`}
							color={el.p90Ms > 50 ? WARN : undefined}
						/>
						<Metric
							label="p99"
							value={`${el.p99Ms.toFixed(2)} ms`}
							color={el.p99Ms > 100 ? FAIL : el.p99Ms > 50 ? WARN : undefined}
						/>
						<Metric label="Max lag" value={`${el.maxMs.toFixed(2)} ms`} />
					</HBox>
				</Section>
			)}

			<Section title="Garbage collection">
				<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
					<Metric label="Total collections" value={gc.totalCount} />
					<Metric label="Total time" value={`${gc.totalTimeMs.toFixed(1)} ms`} />
					<Metric
						label="Max pause"
						value={`${gc.maxPauseMs.toFixed(1)} ms`}
						color={gc.maxPauseMs > 100 ? FAIL : gc.maxPauseMs > 30 ? WARN : undefined}
					/>
				</HBox>
				{Object.keys(gc.byKind).length > 0 && (
					<VBox sx={{ gap: "4px" }}>
						<Label>By kind</Label>
						{Object.entries(gc.byKind).map(([kind, v]) => (
							<HBox key={kind} sx={{ justifyContent: "space-between", gap: "12px" }}>
								<Typo variant="medium" sx={{ fontFamily: "monospace" }}>
									{kind}
								</Typo>
								<Label>
									{v.count} · {v.timeMs.toFixed(1)} ms
								</Label>
							</HBox>
						))}
					</VBox>
				)}
				{gc.lastPauses.length > 0 && (
					<VBox sx={{ gap: "4px" }}>
						<Label>Recent pauses</Label>
						{gc.lastPauses.slice().reverse().slice(0, 10).map((p, i) => (
							<HBox key={i} sx={{ justifyContent: "space-between", gap: "12px" }}>
								<Typo variant="medium" sx={{ fontFamily: "monospace", opacity: 0.9 }}>
									{new Date(p.timestamp).toLocaleTimeString()} · {p.kind}
								</Typo>
								<Label sx={{ color: p.ms > 100 ? FAIL : p.ms > 30 ? WARN : undefined }}>
									{p.ms.toFixed(1)} ms
								</Label>
							</HBox>
						))}
					</VBox>
				)}
			</Section>

			<Section title="File descriptors">
				<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
					<Metric label="Open" value={fd.open ?? "—"} color={fd.open != null ? usageColor(fdPct) : undefined} />
					<Metric label="Soft limit" value={fd.limitSoft ?? "—"} />
					<Metric label="Hard limit" value={fd.limitHard ?? "—"} />
				</HBox>
				{fd.open != null && fd.limitSoft && (
					<VBox sx={{ gap: "4px" }}>
						<HBox sx={{ justifyContent: "space-between" }}>
							<Label>Open / soft limit</Label>
							<Typo variant="medium">{fdPct.toFixed(1)}%</Typo>
						</HBox>
						<ProgressBar pct={fdPct} />
					</VBox>
				)}
			</Section>
		</VBox>
	);
};
