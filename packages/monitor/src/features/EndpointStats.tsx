import { Box, HBox, VBox } from "ui/src/box/Box";
import Panel from "ui/src/panel/Panel";
import { Typo } from "ui/src/text/Typo";
import { IStat } from "../types";
import { buildEndpointStats } from "../lib/metrics";
import { Label } from "../components/Label";

const SUCCESS = "#56bb56";
const FAIL = "#bb5656";

export const EndpointStats = ({ stats }: { stats: IStat[] }) => {
	const rows = buildEndpointStats(stats);
	const maxTotal = rows.reduce((m, r) => Math.max(m, r.total), 0) || 1;

	const totalSuccess = rows.reduce((s, r) => s + r.success, 0);
	const totalFail = rows.reduce((s, r) => s + r.fail, 0);

	return (
		<Panel label="Endpoint statistics">
			<VBox sx={{ gap: "20px" }}>
				<HBox sx={{ gap: "40px", flexWrap: "wrap" }}>
					<VBox sx={{ gap: "2px" }}>
						<Label>Endpoints</Label>
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

				{rows.length === 0 && <Label>No endpoint activity for the selected range</Label>}

				<VBox sx={{ gap: "14px" }}>
					{rows.map(r => {
						const successPct = (r.success / maxTotal) * 100;
						const failPct = (r.fail / maxTotal) * 100;
						return (
							<VBox key={r.endpoint} sx={{ gap: "6px" }}>
								<HBox sx={{ justifyContent: "space-between", gap: "16px" }}>
									<Typo variant="medium" sx={{ fontFamily: "monospace" }}>
										{r.endpoint}
									</Typo>
									<HBox sx={{ gap: "12px" }}>
										<Label>{r.total} req</Label>
										{r.fail > 0 && (
											<Typo variant="caption" sx={{ color: FAIL, opacity: 1 }}>
												{r.fail} failed
											</Typo>
										)}
									</HBox>
								</HBox>
								<HBox
									sx={{
										height: "8px",
										width: "100%",
										backgroundColor: "rgba(255,255,255,.05)",
										borderRadius: "4px",
										overflow: "hidden",
									}}>
									<Box sx={{ width: successPct + "%", backgroundColor: SUCCESS }} />
									<Box sx={{ width: failPct + "%", backgroundColor: FAIL }} />
								</HBox>
							</VBox>
						);
					})}
				</VBox>
			</VBox>
		</Panel>
	);
};
