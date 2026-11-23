import { useState } from "react";
import { Box, HBox, VBox } from "ui/src/box/Box";
import Panel from "ui/src/panel/Panel";
import { Typo } from "ui/src/text/Typo";
import { IStat } from "../types";
import { buildSqlStats } from "../lib/metrics";
import { Label } from "../components/Label";

const SUCCESS = "#56bb56";
const FAIL = "#bb5656";
const VISIBLE_LIMIT = 10;

// Trim a SQL template for the single-line row, keeping the head unless the
// user expanded the row.
const short = (q: string): string => (q.length > 96 ? q.slice(0, 96) + "…" : q);

export const SqlStats = ({ stats }: { stats: IStat[] }) => {
	const [expanded, setExpanded] = useState(false);
	const [open, setOpen] = useState<string | null>(null);

	const rows = buildSqlStats(stats);
	const maxTotal = rows.reduce((m, r) => Math.max(m, r.total), 0) || 1;
	const totalSuccess = rows.reduce((s, r) => s + r.success, 0);
	const totalFail = rows.reduce((s, r) => s + r.fail, 0);

	const visible = expanded ? rows : rows.slice(0, VISIBLE_LIMIT);
	const hidden = Math.max(0, rows.length - VISIBLE_LIMIT);

	return (
		<Panel label="SQL queries">
			<VBox sx={{ gap: "16px" }}>
				<HBox sx={{ gap: "40px", flexWrap: "wrap" }}>
					<VBox sx={{ gap: "2px" }}>
						<Label>Distinct queries</Label>
						<Typo variant="headMedium">{rows.length}</Typo>
					</VBox>
					<VBox sx={{ gap: "2px" }}>
						<Label>Success</Label>
						<Typo variant="headMedium" sx={{ color: SUCCESS }}>
							{totalSuccess}
						</Typo>
					</VBox>
					<VBox sx={{ gap: "2px" }}>
						<Label>Failed</Label>
						<Typo variant="headMedium" sx={{ color: FAIL }}>
							{totalFail}
						</Typo>
					</VBox>
				</HBox>

				{rows.length === 0 && (
					<Label>No SQL activity for the selected range (backend may not surface SQL counters).</Label>
				)}

				<VBox sx={{ gap: "12px" }}>
					{visible.map(r => {
						const successPct = (r.success / maxTotal) * 100;
						const failPct = (r.fail / maxTotal) * 100;
						const isOpen = open === r.query;
						return (
							<VBox key={r.query} sx={{ gap: "6px" }}>
								<HBox
									onClick={() => setOpen(isOpen ? null : r.query)}
									sx={{
										justifyContent: "space-between",
										gap: "16px",
										cursor: "pointer",
										alignItems: "baseline",
									}}>
									<Typo
										variant="medium"
										sx={{
											fontFamily: "monospace",
											fontSize: ".78rem",
											opacity: 0.92,
											wordBreak: "break-all",
											whiteSpace: isOpen ? "pre-wrap" : "nowrap",
											overflow: isOpen ? undefined : "hidden",
											textOverflow: isOpen ? undefined : "ellipsis",
											maxWidth: isOpen ? "100%" : "70%",
										}}>
										{isOpen ? r.query : short(r.query)}
									</Typo>
									<HBox sx={{ gap: "12px", flexShrink: 0 }}>
										<Label>{r.total} q</Label>
										{r.fail > 0 && (
											<Typo variant="caption" sx={{ color: FAIL, opacity: 1 }}>
												{r.fail} failed
											</Typo>
										)}
									</HBox>
								</HBox>
								<HBox
									sx={{
										height: "6px",
										width: "100%",
										backgroundColor: "rgba(255,255,255,.05)",
										borderRadius: "3px",
										overflow: "hidden",
									}}>
									<Box sx={{ width: successPct + "%", backgroundColor: SUCCESS }} />
									<Box sx={{ width: failPct + "%", backgroundColor: FAIL }} />
								</HBox>
							</VBox>
						);
					})}
				</VBox>

				{hidden > 0 && (
					<Box
						onClick={() => setExpanded(v => !v)}
						sx={{
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
