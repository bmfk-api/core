import { useState } from "react";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";
import { REQ_SYSINFO } from "../services/Metrix";
import { ISysInfo } from "../types";
import { usePolling } from "../hooks/usePolling";
import { formatBytes, formatDuration } from "../lib/metrics";
import { Label } from "../components/Label";

const POLL_MS = 30_000;
const ACCENT = "#48BFE3";
const SUCCESS = "#56bb56";
const FAIL = "#bb5656";

const usageColor = (pct: number) => (pct >= 90 ? FAIL : pct >= 75 ? "#e9b61e" : ACCENT);

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

export const SysInfo = () => {
	const [data, setData] = useState<ISysInfo | null>(null);

	const [, getSysInfo] = REQ_SYSINFO.useRequest(response => {
		if (response?.error) return;
		if (response?.data) setData(response.data);
	});

	usePolling(() => getSysInfo(), POLL_MS);

	if (!data) return <Label>Loading…</Label>;

	const cpu = data.cpu;
	const mem = data.memory;
	const disks = data.disk ?? [];
	const conn = data.connections;
	const nginx = data.nginx;
	const pm2 = data.pm2;

	return (
		<VBox sx={{ gap: "16px" }}>
			<Section title="CPU">
				<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
					<Metric label="Cores" value={cpu.count} />
					<Metric label="Platform" value={`${cpu.platform} / ${cpu.arch}`} />
					<Metric label="Uptime" value={formatDuration(cpu.uptimeSec)} />
					<Metric label="Load avg" value={cpu.loadAvg.map(n => n.toFixed(2)).join("  ")} />
				</HBox>
				{cpu.usage && (
					<VBox sx={{ gap: "10px" }}>
						{[
							{ label: "User", pct: cpu.usage.userPct },
							{ label: "System", pct: cpu.usage.systemPct },
							{ label: "I/O wait", pct: cpu.usage.iowaitPct },
							{ label: "Idle", pct: cpu.usage.idlePct },
						].map(row => (
							<VBox key={row.label} sx={{ gap: "4px" }}>
								<HBox sx={{ justifyContent: "space-between", gap: "12px" }}>
									<Label>{row.label}</Label>
									<Typo variant="medium">{row.pct}%</Typo>
								</HBox>
								<ProgressBar
									pct={row.pct}
									color={row.label === "Idle" ? "#80FFDB" : undefined}
								/>
							</VBox>
						))}
					</VBox>
				)}
				{Object.keys(cpu.models).length > 0 && (
					<VBox sx={{ gap: "4px" }}>
						<Label>Models</Label>
						{Object.entries(cpu.models).map(([m, n]) => (
							<HBox key={m} sx={{ justifyContent: "space-between", gap: "16px" }}>
								<Typo variant="medium" sx={{ opacity: 0.9 }}>
									{m}
								</Typo>
								<Label>×{n}</Label>
							</HBox>
						))}
					</VBox>
				)}
			</Section>

			<Section title="Memory">
				<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
					<Metric label="Total" value={formatBytes(mem.total)} />
					<Metric label="Used" value={formatBytes(mem.used)} color={usageColor(mem.usedPct)} />
					<Metric label="Free" value={formatBytes(mem.free)} />
					<Metric label="Used %" value={`${mem.usedPct}%`} color={usageColor(mem.usedPct)} />
				</HBox>
				<ProgressBar pct={mem.usedPct} />
			</Section>

			{disks.length > 0 && (
				<Section title="Disk">
					{disks.map(d => {
						const pct = parseInt(d.usePct, 10) || (d.size ? (d.used / d.size) * 100 : 0);
						return (
							<VBox key={d.mount + d.filesystem} sx={{ gap: "6px" }}>
								<HBox sx={{ justifyContent: "space-between", gap: "12px", alignItems: "baseline" }}>
									<VBox sx={{ gap: "2px" }}>
										<Typo variant="medium" sx={{ fontFamily: "monospace" }}>
											{d.mount}
										</Typo>
										<Label sx={{ fontSize: ".66rem" }}>{d.filesystem}</Label>
									</VBox>
									<Typo variant="medium">
										{formatBytes(d.used)} / {formatBytes(d.size)}
										<span style={{ marginLeft: 8, color: usageColor(pct) }}>{d.usePct}</span>
									</Typo>
								</HBox>
								<ProgressBar pct={pct} />
							</VBox>
						);
					})}
				</Section>
			)}

			{conn && (
				<Section title={`HTTP connections (${conn.ports.join(", ")})`}>
					<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
						<Metric label="Total established" value={conn.total} color={ACCENT} />
					</HBox>
					{conn.topRemote.length > 0 && (
						<VBox sx={{ gap: "4px" }}>
							<Label>Top remote IPs</Label>
							{conn.topRemote.map(r => (
								<HBox key={r.ip} sx={{ justifyContent: "space-between", gap: "12px" }}>
									<Typo variant="medium" sx={{ fontFamily: "monospace" }}>
										{r.ip}
									</Typo>
									<Label>{r.count}</Label>
								</HBox>
							))}
						</VBox>
					)}
				</Section>
			)}

			<Section title="Nginx">
				{!nginx.installed && <Label>Not installed</Label>}
				{nginx.installed && (
					<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
						<Metric
							label="Status"
							value={nginx.status ?? "—"}
							color={nginx.status === "active" ? SUCCESS : FAIL}
						/>
						<Metric label="Workers" value={nginx.workerCount ?? 0} />
						<Metric label="Version" value={nginx.version ?? "—"} />
					</HBox>
				)}
				{nginx.installed && nginx.listening && nginx.listening.length > 0 && (
					<VBox sx={{ gap: "4px" }}>
						<Label>Listening</Label>
						{nginx.listening.map(l => (
							<Typo key={l} variant="medium" sx={{ fontFamily: "monospace", opacity: 0.9 }}>
								{l}
							</Typo>
						))}
					</VBox>
				)}
				{nginx.error && <Label sx={{ color: FAIL }}>{nginx.error}</Label>}
			</Section>

			<Section title="PM2">
				{!pm2.installed && <Label>Not installed</Label>}
				{pm2.installed && pm2.processes && pm2.processes.length > 0 && (
					<VBox sx={{ gap: "10px" }}>
						{pm2.processes.map(p => (
							<HBox
								key={p.pm_id}
								sx={{ justifyContent: "space-between", gap: "12px", alignItems: "baseline" }}>
								<VBox sx={{ gap: "2px" }}>
									<Typo variant="medium" sx={{ fontFamily: "monospace" }}>
										{p.name}
									</Typo>
									<Label sx={{ fontSize: ".66rem" }}>
										pid {p.pid} · {p.exec_mode ?? "—"} · {p.instances ?? 1} inst
									</Label>
								</VBox>
								<HBox sx={{ gap: "16px", alignItems: "baseline" }}>
									<Label sx={{ color: p.status === "online" ? SUCCESS : FAIL }}>
										{p.status ?? "—"}
									</Label>
									<Label>{p.cpu ?? 0}%</Label>
									<Label>{formatBytes(p.memory ?? 0)}</Label>
									<Label>↻ {p.restarts ?? 0}</Label>
								</HBox>
							</HBox>
						))}
					</VBox>
				)}
				{pm2.error && <Label sx={{ color: FAIL }}>{pm2.error}</Label>}
			</Section>
		</VBox>
	);
};
