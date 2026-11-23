import { useState } from "react";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";
import { SystemMetrics } from "./SystemMetrics";
import { HttpStats } from "./HttpStats";
import { Connections } from "./Connections";
import { EndpointStats } from "./EndpointStats";
import { HttpCalls } from "./HttpCalls";
import { SqlStats } from "./SqlStats";
import { Database } from "./Database";
import { SysInfo } from "./SysInfo";
import { ProcInfo } from "./ProcInfo";
import { FdReport } from "./FdReport";
import { Inventory } from "./Inventory";
import { IStat, TRange } from "../types";

interface IProps {
	stats: IStat[];
	range: TRange;
}

// Filter categories. Each panel declares which categories it belongs to;
// the filter bar renders panels matching ANY selected category (OR).
type TFilter = "CPU" | "NET" | "DB" | "MEM" | "PM2" | "APP" | "SYS";

const FILTERS: TFilter[] = ["CPU", "NET", "DB", "MEM", "PM2", "APP", "SYS"];

interface IPanelEntry {
	node: React.ReactNode;
	tags: TFilter[];
}

// Match the Metrix `TabBar` styling so the filter bar looks like the log tabs.
const FilterBar = ({
	active,
	onChange,
	counts,
}: {
	active: Set<TFilter>;
	onChange: (next: Set<TFilter>) => void;
	counts: Record<TFilter, number>;
}) => {
	const allSelected = active.size === 0;
	const toggle = (t: TFilter) => {
		const next = new Set(active);
		if (next.has(t)) next.delete(t);
		else next.add(t);
		onChange(next);
	};
	const chip = (label: string, isActive: boolean, onClick: () => void, count?: number) => (
		<Box
			key={label}
			onClick={onClick}
			sx={{
				padding: "0 2px 12px",
				marginBottom: "-1px",
				cursor: "pointer",
				fontSize: ".74rem",
				fontWeight: 600,
				letterSpacing: ".08em",
				textTransform: "uppercase",
				transition: "color .2s, border-color .2s",
				borderBottom: "2px solid " + (isActive ? "#5390d9" : "transparent"),
				color: isActive ? "textPrimary" : "rgba(255,255,255,.4)",
				display: "flex",
				alignItems: "center",
				gap: "6px",
				"&:hover": { color: isActive ? "textPrimary" : "rgba(255,255,255,.7)" },
			}}>
			<span>{label}</span>
			{count !== undefined && count > 0 && (
				<Typo
					variant="caption"
					sx={{
						fontSize: ".62rem",
						opacity: isActive ? 0.9 : 0.5,
						fontVariantNumeric: "tabular-nums",
					}}>
					{count}
				</Typo>
			)}
		</Box>
	);

	return (
		<HBox
			sx={{
				gap: "26px",
				borderBottom: "1px solid rgba(255,255,255,.08)",
				marginBottom: "20px",
				flexWrap: "wrap",
			}}>
			{chip("ALL", allSelected, () => onChange(new Set()))}
			{FILTERS.map(f => chip(f, active.has(f), () => toggle(f), counts[f]))}
		</HBox>
	);
};

// Mosaic of all monitoring panels rendered via CSS multi-column layout —
// browsers balance the columns automatically, giving a natural masonry look
// regardless of individual panel height.
export const Overview = ({ stats, range }: IProps) => {
	const [active, setActive] = useState<Set<TFilter>>(new Set());

	const entries: IPanelEntry[] = [
		{ node: <SystemMetrics stats={stats} range={range} />, tags: ["CPU", "MEM", "APP"] },
		{ node: <HttpStats />, tags: ["NET"] },
		{ node: <EndpointStats stats={stats} />, tags: ["APP"] },
		{ node: <SqlStats stats={stats} />, tags: ["DB"] },
		{ node: <Connections />, tags: ["NET"] },
		{ node: <HttpCalls stats={stats} />, tags: ["NET", "APP"] },
		{ node: <Database range={range} />, tags: ["DB"] },
		{ node: <FdReport />, tags: ["NET", "SYS"] },
		{ node: <SysInfo />, tags: ["SYS", "CPU", "MEM"] },
		{ node: <ProcInfo />, tags: ["PM2", "MEM", "APP"] },
		{ node: <Inventory />, tags: ["APP"] },
	];

	// Precompute how many panels each filter would show — useful hint next to
	// the tab label so the operator sees at a glance where the interesting
	// content lives.
	const counts: Record<TFilter, number> = FILTERS.reduce(
		(acc, f) => ({ ...acc, [f]: entries.filter(e => e.tags.includes(f)).length }),
		{} as Record<TFilter, number>,
	);

	const visible = active.size === 0 ? entries : entries.filter(e => e.tags.some(t => active.has(t)));

	return (
		<VBox sx={{ gap: "0" }}>
			<FilterBar active={active} onChange={setActive} counts={counts} />

			{visible.length === 0 ? (
				<Box sx={{ padding: "40px", textAlign: "center", opacity: 0.6 }}>
					No panels match the selected filters.
				</Box>
			) : (
				<Box
					sx={{
						columnWidth: "440px",
						columnGap: "20px",
					}}>
					{visible.map((e, i) => (
						<Box key={i} sx={{ breakInside: "avoid", marginBottom: "20px", display: "block" }}>
							{e.node}
						</Box>
					))}
				</Box>
			)}
		</VBox>
	);
};
