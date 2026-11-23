import { useEffect, useState } from "react";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Error } from "ui/src/error/Error";
import Panel from "ui/src/panel/Panel";
import { Spinner } from "ui/src/spinner/Spinner";
import { Typo, TypoCaption } from "ui/src/text/Typo";
import { Label } from "./components/Label";
import { REQ_METRICS } from "./services/Metrix";
import { IStat, TRange } from "./types";
import { usePolling } from "./hooks/usePolling";
import { Archive } from "./features/Archive";
import { Correlations } from "./features/Correlations";
import { FileLogs } from "./features/FileLogs";
import { Threats } from "./features/Threats";
import { levelColor } from "./lib/threats";
import { request_threats } from "./api/Request";
import { IThreats } from "./types";
import { LogViewer } from "./features/LogViewer";
import { NetLog } from "./features/NetLog";
import { OutgoingNetLog } from "./features/OutgoingNetLog";
import { Overview } from "./features/Overview";
import { IError } from "./api/Request";
import { S_LOGOUT, can, session } from "./services/Auth";

const APP_VERSION: string | undefined = (window as { __ver?: string }).__ver;

const POLL_MS = 30_000;
const THREATS_POLL_MS = 45_000;
const THREATS_TAB = 4;
const RANGES: { value: TRange; label: string }[] = [
	{ value: "hour", label: "Hour" },
	{ value: "day", label: "Day" },
	{ value: "week", label: "Week" },
];

type TPage = "overview" | "logs" | "correlations" | "archive";
const PAGES: { value: TPage; label: string }[] = [
	{ value: "overview", label: "Overview" },
	{ value: "logs", label: "Logs" },
	{ value: "correlations", label: "Correlations" },
	{ value: "archive", label: "Archive" },
];

const SegmentedControl = <T extends string>({
	items,
	value,
	onChange,
}: {
	items: { value: T; label: string }[];
	value: T;
	onChange: (v: T) => void;
}) => (
	<HBox sx={{ gap: "4px", padding: "4px", backgroundColor: "rgba(0,0,0,.2)", borderRadius: "8px" }}>
		{items.map(i => {
			const active = i.value === value;
			return (
				<Box
					key={i.value}
					onClick={() => onChange(i.value)}
					sx={{
						padding: "8px 18px",
						borderRadius: "6px",
						cursor: "pointer",
						fontSize: ".85rem",
						transition: "background-color .2s",
						backgroundColor: active ? "buttonBackgroundPrimary" : "transparent",
						color: active ? "buttonTextPrimary" : "textPrimary",
						"&:hover": { backgroundColor: active ? "buttonBackgroundPrimary" : "rgba(255,255,255,.06)" },
					}}>
					{i.label}
				</Box>
			);
		})}
	</HBox>
);

const TabBar = ({ tabs, value, onChange }: { tabs: string[]; value: number; onChange: (i: number) => void }) => (
	<HBox sx={{ gap: "26px", borderBottom: "1px solid rgba(255,255,255,.08)", marginBottom: "20px" }}>
		{tabs.map((label, i) => {
			const active = i === value;
			return (
				<Box
					key={label}
					onClick={() => onChange(i)}
					sx={{
						padding: "0 2px 12px",
						marginBottom: "-1px",
						cursor: "pointer",
						fontSize: ".74rem",
						fontWeight: 600,
						letterSpacing: ".08em",
						textTransform: "uppercase",
						transition: "color .2s, border-color .2s",
						borderBottom: "2px solid " + (active ? "#5390d9" : "transparent"),
						color: active ? "textPrimary" : "rgba(255,255,255,.4)",
						"&:hover": { color: active ? "textPrimary" : "rgba(255,255,255,.7)" },
					}}>
					{label}
				</Box>
			);
		})}
	</HBox>
);

export const Metrix = () => {
	const [page, setPage] = useState<TPage>("overview");
	// Role gates (guide §2): hide what the session can't use instead of
	// waiting for a 403.
	const canLogs = can("logs");
	const pages = canLogs ? PAGES : PAGES.filter(p => p.value !== "logs");
	const me = session.current;
	const [range, setRange] = useState<TRange>("hour");
	const [logTab, setLogTab] = useState(0);
	// Set by a trace link: the journal it opens starts filtered by that trace id.
	const [traceFocus, setTraceFocus] = useState("");
	const openTrace = (traceId: string, tab: number) => {
		setTraceFocus(traceId);
		setLogTab(tab);
	};
	const [stats, setStats] = useState<IStat[]>([]);
	const [error, setError] = useState<IError | null>(null);
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);

	const [, getMetrics, , busy] = REQ_METRICS.useRequest(response => {
		if (response?.error) {
			setError(response.error);
			return;
		}
		setError(null);
		setStats(response?.data ?? []);
		setUpdatedAt(Date.now());
	});

	// Refetch immediately when the range changes.
	useEffect(() => {
		getMetrics({ range });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [range]);

	// Keep refreshing on a fixed interval using the current range.
	usePolling(() => getMetrics({ range }), POLL_MS);

	// One threats poll feeds both the header badge and the Threats tab. Called
	// directly (not Req.useRequest) so roles without "logs" never hit the
	// endpoint — useRequest would fire once on mount and earn a 403.
	const [threats, setThreats] = useState<IThreats | null>(null);
	const [threatsError, setThreatsError] = useState<string | null>(null);
	const [threatsAt, setThreatsAt] = useState<number | null>(null);
	const loadThreats = async () => {
		const r = await request_threats({ limit: 100 });
		if (r.error) {
			setThreatsError(r.error.details || r.error.message);
			return;
		}
		setThreatsError(null);
		setThreats(r.data ?? null);
		setThreatsAt(Date.now());
	};
	usePolling(loadThreats, THREATS_POLL_MS, canLogs);
	const threatLevel = threats?.totals.high ? "high" : threats?.totals.suspicious ? "suspicious" : "none";

	return (
		<VBox sx={{ padding: "30px", gap: "24px", maxWidth: "1800px", margin: "0 auto", width: "100%" }}>
			<HBox sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px" }}>
				<HBox sx={{ alignItems: "baseline", gap: "12px", flexWrap: "wrap" }}>
					<Typo variant="head">Server Monitor</Typo>
					{APP_VERSION && <Label sx={{ fontSize: ".72rem" }}>v.{APP_VERSION}</Label>}
					{busy && <Spinner size={18} />}
				</HBox>
				<SegmentedControl items={pages} value={page} onChange={setPage} />
				<HBox sx={{ alignItems: "center", gap: "16px" }}>
					{updatedAt && <TypoCaption>Updated {new Date(updatedAt).toLocaleTimeString()}</TypoCaption>}
					{page === "overview" && (
						<SegmentedControl items={RANGES} value={range} onChange={setRange} />
					)}
					{canLogs && threats && (
						<Box
							title="Probing attempts — open the Threats tab"
							onClick={() => {
								setPage("logs");
								setLogTab(THREATS_TAB);
							}}
							sx={{
								display: "flex",
								alignItems: "center",
								gap: "6px",
								padding: "5px 10px",
								borderRadius: "999px",
								cursor: "pointer",
								fontSize: ".68rem",
								fontWeight: 600,
								letterSpacing: ".06em",
								textTransform: "uppercase",
								color: threatLevel === "none" ? "rgba(255,255,255,.55)" : levelColor(threatLevel),
								border: "1px solid " + (threatLevel === "none" ? "rgba(255,255,255,.12)" : levelColor(threatLevel) + "66"),
								backgroundColor: threatLevel === "none" ? "transparent" : levelColor(threatLevel) + "1a",
							}}>
							<Box
								sx={{
									width: "7px",
									height: "7px",
									borderRadius: "50%",
									backgroundColor: threatLevel === "none" ? "#56bb56" : levelColor(threatLevel),
								}}
							/>
							{threatLevel === "none"
								? "Threats 0"
								: `Threats ${threats.totals.high} high · ${threats.totals.suspicious} susp`}
						</Box>
					)}
					{me && (
						<Label sx={{ fontSize: ".72rem" }}>
							{me.login}
							{me.role ? ` · ${me.role}` : ""}
						</Label>
					)}
					<Box
						onClick={() => S_LOGOUT.invoke()}
						sx={{
							padding: "6px 12px",
							borderRadius: "6px",
							cursor: "pointer",
							fontSize: ".7rem",
							fontWeight: 600,
							letterSpacing: ".06em",
							textTransform: "uppercase",
							color: "rgba(255,255,255,.75)",
							border: "1px solid rgba(255,255,255,.12)",
							"&:hover": { backgroundColor: "rgba(255,255,255,.06)" },
						}}>
						Sign out
					</Box>
				</HBox>
			</HBox>

			{error && <Error error={error} />}

			{page === "overview" && <Overview stats={stats} range={range} />}
			{page === "logs" && canLogs && (
				<Panel>
					<TabBar
						tabs={["Log", "Net log", "Outgoing", "Files", "Threats"]}
						value={logTab}
						onChange={i => {
							setTraceFocus("");
							setLogTab(i);
						}}
					/>
					{logTab === 0 && <LogViewer trace={traceFocus} onTrace={openTrace} />}
					{logTab === 1 && <NetLog trace={traceFocus} onTrace={openTrace} />}
					{logTab === 2 && <OutgoingNetLog trace={traceFocus} onTrace={openTrace} />}
					{logTab === 3 && <FileLogs />}
					{logTab === THREATS_TAB && <Threats data={threats} error={threatsError} updatedAt={threatsAt} onChanged={loadThreats} />}
				</Panel>
			)}
			{page === "correlations" && <Correlations />}
			{page === "archive" && <Archive />}
		</VBox>
	);
};
