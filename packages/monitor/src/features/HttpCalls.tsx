import { useState } from "react";
import { Box, HBox, VBox } from "ui/src/box/Box";
import Panel from "ui/src/panel/Panel";
import { Typo } from "ui/src/text/Typo";
import { IStat } from "../types";
import { buildHttpStats } from "../lib/metrics";
import { Label } from "../components/Label";

const VISIBLE_LIMIT = 10;

export const HttpCalls = ({ stats }: { stats: IStat[] }) => {
	const http = buildHttpStats(stats);
	const [expanded, setExpanded] = useState(false);

	const visible = expanded ? http : http.slice(0, VISIBLE_LIMIT);
	const hidden = Math.max(0, http.length - VISIBLE_LIMIT);

	return (
		<Panel label="Outgoing HTTP calls">
			<VBox sx={{ gap: "12px" }}>
				{http.length === 0 && <Label>No outgoing calls for the selected range</Label>}
				{visible.map(h => (
					<HBox key={h.url} sx={{ justifyContent: "space-between", gap: "16px", alignItems: "baseline" }}>
						<Typo variant="medium" sx={{ fontFamily: "monospace", opacity: 0.92, wordBreak: "break-all" }}>
							{h.url}
						</Typo>
						<Label sx={{ whiteSpace: "nowrap" }}>{h.count}</Label>
					</HBox>
				))}
				{hidden > 0 && (
					<Box
						onClick={() => setExpanded(v => !v)}
						sx={{
							marginTop: "4px",
							padding: "8px",
							textAlign: "center",
							cursor: "pointer",
							fontSize: ".72rem",
							fontWeight: 600,
							letterSpacing: ".06em",
							textTransform: "uppercase",
							color: "#5390d9",
							borderTop: "1px solid rgba(255,255,255,.06)",
							"&:hover": { backgroundColor: "rgba(255,255,255,.04)" },
						}}>
						{expanded ? "Less" : `More (${hidden})`}
					</Box>
				)}
			</VBox>
		</Panel>
	);
};
