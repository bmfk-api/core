import { useState } from "react";
import { Box, HBox, VBox } from "ui/src/box/Box";
import Panel from "ui/src/panel/Panel";
import { Typo } from "ui/src/text/Typo";
import { REQ_CONNECTIONS } from "../services/Metrix";
import { IConnectionsSnapshot } from "../types";
import { usePolling } from "../hooks/usePolling";
import { Label } from "../components/Label";

const POLL_MS = 30_000;

export const Connections = () => {
	const [snapshot, setSnapshot] = useState<IConnectionsSnapshot | null>(null);

	const [, getConnections] = REQ_CONNECTIONS.useRequest(response => {
		if (response?.error) return;
		if (response?.data) setSnapshot(response.data);
	});

	usePolling(() => getConnections(), POLL_MS);

	const hosts = snapshot ? Object.entries(snapshot.byHost).sort((a, b) => b[1] - a[1]) : [];
	const maxCount = hosts.reduce((m, [, c]) => Math.max(m, c), 0) || 1;

	return (
		<Panel label="Active outgoing connections">
			<VBox sx={{ gap: "18px" }}>
				<VBox sx={{ gap: "2px" }}>
					<Label>Total active</Label>
					<Typo variant="head" sx={{ color: "#48BFE3" }}>
						{snapshot?.total ?? 0}
					</Typo>
				</VBox>

				{hosts.length === 0 && <Label>No active connections</Label>}

				<VBox sx={{ gap: "12px" }}>
					{hosts.map(([host, count]) => (
						<VBox key={host} sx={{ gap: "5px" }}>
							<HBox sx={{ justifyContent: "space-between", gap: "16px" }}>
								<Typo variant="medium" sx={{ fontFamily: "monospace", opacity: 0.9 }}>
									{host}
								</Typo>
								<Label>{count}</Label>
							</HBox>
							<Box
								sx={{
									height: "6px",
									width: (count / maxCount) * 100 + "%",
									minWidth: "4px",
									borderRadius: "3px",
									backgroundColor: "#48BFE3",
								}}
							/>
						</VBox>
					))}
				</VBox>
			</VBox>
		</Panel>
	);
};
