import { HBox, VBox } from "ui/src/box/Box";
import Panel from "ui/src/panel/Panel";
import { Typo } from "ui/src/text/Typo";
import { IStat, TRange } from "../types";
import { formatMB, formatTimeLabel } from "../lib/metrics";
import { TimeSeriesChart } from "../components/TimeSeriesChart";
import { Label } from "../components/Label";

interface IProps {
	stats: IStat[];
	range: TRange;
}

const Metric = ({ label, value, color }: { label: string; value: string; color?: string }) => (
	<VBox sx={{ gap: "2px" }}>
		<Label>{label}</Label>
		<Typo variant="headMedium" sx={color ? { color } : undefined}>
			{value}
		</Typo>
	</VBox>
);

export const SystemMetrics = ({ stats, range }: IProps) => {
	const labels = stats.map(s => formatTimeLabel(s.timestamp, range));
	const latest = stats.length ? stats[stats.length - 1].slot : null;

	const cpuSeries = [{ name: "CPU", color: "#48BFE3", values: stats.map(s => s.slot.cpu) }];
	const memSeries = [
		{ name: "RSS", color: "#7400B8", values: stats.map(s => s.slot.memory.rss) },
		{ name: "Heap used", color: "#56CFE1", values: stats.map(s => s.slot.memory.heapUsed) },
		{ name: "Heap total", color: "#80FFDB", values: stats.map(s => s.slot.memory.heapTotal) },
	];

	return (
		<HBox sx={{ gap: "30px", flexWrap: "wrap", alignItems: "stretch" }}>
			<Panel label="CPU" sx={{ flex: "1 1 420px", minWidth: "320px" }}>
				<VBox sx={{ gap: "18px" }}>
					<Metric label="Current load (per core)" value={`${latest ? latest.cpu : 0}%`} color="#48BFE3" />
					<TimeSeriesChart series={cpuSeries} labels={labels} unit="%" yMax={100} />
				</VBox>
			</Panel>

			<Panel label="Memory" sx={{ flex: "1 1 420px", minWidth: "320px" }}>
				<VBox sx={{ gap: "18px" }}>
					<HBox sx={{ gap: "40px", flexWrap: "wrap" }}>
						<Metric label="RSS" value={formatMB(latest?.memory.rss ?? 0)} color="#7400B8" />
						<Metric label="Heap used" value={formatMB(latest?.memory.heapUsed ?? 0)} color="#56CFE1" />
						<Metric label="External" value={formatMB(latest?.memory.external ?? 0)} />
					</HBox>
					<TimeSeriesChart series={memSeries} labels={labels} formatValue={formatMB} />
				</VBox>
			</Panel>
		</HBox>
	);
};
