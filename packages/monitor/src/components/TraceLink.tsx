import { useState } from "react";
import { HBox, VBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";
import { Label } from "./Label";

// Every incoming request gets a trace id (X-Request-Id). The log lines written while handling it,
// its net log entry and the outgoing calls it made all carry the same id — so one id finds them all.
// Indexes match the tab order in Metrix.
export const TRACE_TABS = [
	{ tab: 0, label: "Log" },
	{ tab: 1, label: "Net log" },
	{ tab: 2, label: "Outgoing" },
] as const;

export type TOpenTrace = (traceId: string, tab: number) => void;

const LINK = "#5390d9";

// Short form for table rows: the first block of a UUID is enough to tell requests apart by eye.
export const shortTrace = (id?: string) => (id ? id.split("-")[0].slice(0, 8) : "");

// Row cell: click filters the current view by this trace (and does not open the row).
export const TraceCell = ({ traceId, onClick }: { traceId?: string; onClick: (traceId: string) => void }) =>
	traceId ? (
		<div
			title={traceId}
			onClick={e => {
				e.stopPropagation();
				onClick(traceId);
			}}
			style={{ fontFamily: "monospace", color: LINK, opacity: 0.85, cursor: "pointer", overflow: "hidden" }}>
			{shortTrace(traceId)}
		</div>
	) : (
		<div style={{ opacity: 0.3 }}>—</div>
	);

// Detail block for a modal: the full id, copy, and links to the same trace in every journal.
export const TraceInfo = ({ traceId, onOpen }: { traceId?: string; onOpen: TOpenTrace }) => {
	const [copied, setCopied] = useState(false);
	if (!traceId) return null;
	const copy = () => {
		navigator.clipboard?.writeText(traceId).then(
			() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1200);
			},
			() => {},
		);
	};
	return (
		<VBox sx={{ gap: "4px" }}>
			<Label>Trace</Label>
			<HBox sx={{ gap: "14px", alignItems: "center", flexWrap: "wrap" }}>
				<Typo variant="medium" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
					{traceId}
				</Typo>
				<Typo variant="caption" sx={{ color: LINK, cursor: "pointer", opacity: 1 }} onClick={copy}>
					{copied ? "copied" : "copy"}
				</Typo>
				<Label>show in:</Label>
				{TRACE_TABS.map(t => (
					<Typo
						key={t.tab}
						variant="caption"
						sx={{ color: LINK, cursor: "pointer", opacity: 1, textDecoration: "underline" }}
						onClick={() => onOpen(traceId, t.tab)}>
						{t.label}
					</Typo>
				))}
			</HBox>
		</VBox>
	);
};
