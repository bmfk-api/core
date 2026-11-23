import { Fragment, useEffect, useState } from "react";
import { styled } from "styled-components";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";
import { Label } from "../components/Label";
import { IBlockedList, IThreats, TThreatCategory } from "../types";
import { IError, request_blocked, request_unblock } from "../api/Request";
import { can } from "../services/Auth";
import { ActionButton, BlockDialog, BlockedPill, BlockedTable, ErrorBox } from "./IpBlocking";
import { levelColor } from "../lib/threats";

const FAIL = "#bb5656";
const WARN = "#e9b61e";
const MUTED = "#8a8699";


const CATEGORY_LABEL: Record<TThreatCategory, string> = {
	scanner: "scanner",
	injection: "injection",
	enumeration: "enumeration",
	method: "method",
	auth: "auth",
	"not-found": "404",
};

const fmtTime = (ts: number) => new Date(ts).toLocaleString();

const ago = (ts: number) => {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
};

const Row = styled.div<{ $open?: boolean }>`
	display: grid;
	grid-template-columns: 18px minmax(110px, 1.1fr) 82px 56px minmax(140px, 2fr) 90px 90px 96px;
	gap: 10px;
	align-items: center;
	padding: 8px 12px;
	font-size: 0.76rem;
	border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	cursor: pointer;
	background-color: ${({ $open }) => ($open ? "rgba(255,255,255,.04)" : "transparent")};
	&:hover {
		background-color: rgba(255, 255, 255, 0.05);
	}
`;

const HeadRow = styled(Row)`
	cursor: default;
	opacity: 0.55;
	font-weight: 600;
	font-size: 0.68rem;
	letter-spacing: 0.06em;
	&:hover {
		background-color: transparent;
	}
`;

const EventRow = styled.div`
	display: grid;
	grid-template-columns: 140px 120px 56px 1fr 44px minmax(120px, auto);
	gap: 10px;
	align-items: center;
	padding: 6px 12px;
	font-size: 0.74rem;
	border-bottom: 1px solid rgba(255, 255, 255, 0.05);
`;

const Cell = styled.div`
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
`;

const Mono = styled(Cell)`
	font-family: monospace;
`;

const Scroll = styled.div`
	overflow-x: auto;
	border: 1px solid rgba(255, 255, 255, 0.06);
	border-radius: 8px;
	> div {
		min-width: 820px;
	}
`;

const Pill = ({ color, children }: { color: string; children: React.ReactNode }) => (
	<Box
		sx={{
			display: "inline-block",
			padding: "2px 7px",
			borderRadius: "4px",
			fontSize: ".64rem",
			fontWeight: 600,
			letterSpacing: ".04em",
			textTransform: "uppercase",
			color,
			border: `1px solid ${color}55`,
			backgroundColor: `${color}1a`,
			whiteSpace: "nowrap",
		}}>
		{children}
	</Box>
);

const Categories = ({ list }: { list: TThreatCategory[] }) => (
	<HBox sx={{ gap: "4px", flexWrap: "wrap" }}>
		{list.map(c => (
			<Pill key={c} color={c === "scanner" || c === "injection" ? FAIL : c === "auth" || c === "not-found" ? MUTED : WARN}>
				{CATEGORY_LABEL[c] ?? c}
			</Pill>
		))}
	</HBox>
);

const Total = ({ label, value, color }: { label: string; value: number; color?: string }) => (
	<VBox sx={{ gap: "2px", minWidth: "90px" }}>
		<Label>{label}</Label>
		<Typo variant="headMedium" sx={color && value > 0 ? { color } : undefined}>
			{value}
		</Typo>
	</VBox>
);

interface IProps {
	data: IThreats | null;
	error: string | null;
	updatedAt: number | null;
	onChanged: () => void;
}

export const Threats = ({ data, error, updatedAt, onChanged }: IProps) => {
	const [open, setOpen] = useState<string | null>(null);
	const isAdmin = can("admin");
	const [blocked, setBlocked] = useState<IBlockedList | null>(null);
	const [blockedError, setBlockedError] = useState<string | null>(null);
	// null = dialog closed; string = prefilled address ("" for a manual entry)
	const [blockIp, setBlockIp] = useState<string | null>(null);
	const [busyIp, setBusyIp] = useState<string | null>(null);
	const [actionError, setActionError] = useState<IError | null>(null);

	// Refresh the block list together with each threats poll.
	useEffect(() => {
		let cancelled = false;
		request_blocked().then(r => {
			if (cancelled) return;
			if (r.error) {
				setBlockedError(r.error.details || r.error.message);
				return;
			}
			setBlockedError(null);
			setBlocked(r.data ?? null);
		});
		return () => {
			cancelled = true;
		};
	}, [updatedAt]);

	// block/unblock answer with the full list, so apply it directly and let the
	// parent re-poll threats for the per-IP `blocked` flags.
	const applyList = (list: IBlockedList) => {
		setBlocked(list);
		setActionError(null);
		onChanged();
	};

	const unblock = async (ip: string) => {
		if (busyIp) return;
		setBusyIp(ip);
		const r = await request_unblock({ ip });
		setBusyIp(null);
		if (r.error || !r.data) {
			setActionError(r.error ?? { code: -1, message: "Empty response" });
			return;
		}
		applyList(r.data);
	};

	if (error) return <Typo variant="medium" sx={{ color: FAIL }}>{error}</Typo>;
	if (!data) return <Label>Loading…</Label>;

	const { settings, totals, offenders, recent } = data;

	return (
		<VBox sx={{ gap: "20px" }}>
			<HBox sx={{ gap: "24px", flexWrap: "wrap", alignItems: "flex-end" }}>
				<Total label="Tracked IPs" value={totals.tracked} />
				<Total label="Suspicious" value={totals.suspicious} color={WARN} />
				<Total label="High" value={totals.high} color={FAIL} />
				<Box sx={{ marginLeft: "auto" }}>
					<Label sx={{ fontSize: ".7rem" }}>
						Scoring never blocks by itself — blocking is manual. Suspicious from {settings.suspiciousAt}, high from{" "}
						{settings.highAt} points; scores halve every {settings.halfLifeMinutes} min without new hits.
						{updatedAt ? ` Updated ${new Date(updatedAt).toLocaleTimeString()}.` : ""}
					</Label>
				</Box>
			</HBox>

			{actionError && <ErrorBox error={actionError} />}

			<VBox sx={{ gap: "8px" }}>
				<Label>Offenders ({offenders.length})</Label>
				{offenders.length === 0 ? (
					<Label>No probing activity right now.</Label>
				) : (
					<Scroll>
						<div>
							<HeadRow>
								<Cell />
								<Cell>IP</Cell>
								<Cell>LEVEL</Cell>
								<Cell style={{ textAlign: "right" }}>SCORE</Cell>
								<Cell>CATEGORIES</Cell>
								<Cell>FIRST</Cell>
								<Cell>LAST</Cell>
								<Cell />
							</HeadRow>
							{offenders.map(o => {
								const isOpen = open === o.ip;
								const cats = (Object.entries(o.categories) as [TThreatCategory, number][])
									.sort((a, b) => b[1] - a[1]);
								return (
									<Fragment key={o.ip}>
										<Row $open={isOpen} onClick={() => setOpen(isOpen ? null : o.ip)}>
											<Cell style={{ opacity: 0.6 }}>{isOpen ? "▾" : "▸"}</Cell>
											<HBox sx={{ gap: "6px", alignItems: "center", minWidth: 0 }}>
												<Mono>{o.ip}</Mono>
												{o.blocked && isAdmin && <BlockedPill />}
											</HBox>
											<Cell>
												<Pill color={levelColor(o.level)}>{o.level === "none" ? "low" : o.level}</Pill>
											</Cell>
											<Cell
												style={{
													textAlign: "right",
													fontVariantNumeric: "tabular-nums",
													color: levelColor(o.level),
													fontWeight: 600,
												}}>
												{Math.round(o.score)}
											</Cell>
											<Cell>
												{cats.map(([c, n]) => `${CATEGORY_LABEL[c] ?? c}×${n}`).join("  ")}
											</Cell>
											<Cell title={fmtTime(o.firstSeen)} style={{ opacity: 0.8 }}>
												{ago(o.firstSeen)}
											</Cell>
											<Cell title={fmtTime(o.lastSeen)}>{ago(o.lastSeen)}</Cell>
											<Cell style={{ textAlign: "right" }} onClick={e => e.stopPropagation()}>
												{o.blocked ? (
													isAdmin ? (
														<ActionButton
															type="button"
															title="Blocked — click to unblock"
															disabled={busyIp === o.ip}
															onClick={() => unblock(o.ip)}>
															{busyIp === o.ip ? "…" : "Unblock"}
														</ActionButton>
													) : (
														<BlockedPill />
													)
												) : (
													isAdmin && (
														<ActionButton type="button" $tone="danger" onClick={() => setBlockIp(o.ip)}>
															Block
														</ActionButton>
													)
												)}
											</Cell>
										</Row>
										{isOpen && (
											<VBox
												sx={{
													gap: "8px",
													padding: "10px 12px 14px 40px",
													backgroundColor: "rgba(0,0,0,.18)",
													borderBottom: "1px solid rgba(255,255,255,.06)",
												}}>
												<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
													<Label>
														Hits: <b>{o.hits}</b>
													</Label>
													<Label>
														First: {fmtTime(o.firstSeen)}
													</Label>
													<Label>
														Last: {fmtTime(o.lastSeen)}
													</Label>
												</HBox>
												<Label sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
													UA: {o.userAgent || "—"}
												</Label>
												{o.samples.map((s, i) => (
													<HBox key={i} sx={{ gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
														<Label sx={{ fontSize: ".7rem", minWidth: "140px" }}>{fmtTime(s.ts)}</Label>
														<Mono style={{ fontSize: ".74rem", minWidth: "48px" }}>{s.method}</Mono>
														<Mono
															style={{
																fontSize: ".74rem",
																color: s.status >= 500 ? FAIL : s.status >= 400 ? WARN : undefined,
															}}>
															{s.status}
														</Mono>
														<Mono style={{ fontSize: ".74rem", flex: 1, whiteSpace: "normal", wordBreak: "break-all" }}>
															{s.url}
														</Mono>
														<Categories list={s.categories} />
													</HBox>
												))}
											</VBox>
										)}
									</Fragment>
								);
							})}
						</div>
					</Scroll>
				)}
			</VBox>

			<VBox sx={{ gap: "8px" }}>
				<HBox sx={{ gap: "12px", alignItems: "center" }}>
					<Label>Blocked addresses ({blocked?.entries.filter(e => e.active).length ?? 0})</Label>
					{isAdmin && (
						<ActionButton type="button" onClick={() => setBlockIp("")}>
							Block address…
						</ActionButton>
					)}
				</HBox>
				{blockedError ? (
					<Typo variant="medium" sx={{ color: FAIL }}>{blockedError}</Typo>
				) : (
					<BlockedTable list={blocked} isAdmin={isAdmin} busyIp={busyIp} onUnblock={unblock} />
				)}
			</VBox>

			<VBox sx={{ gap: "8px" }}>
				<Label>Recent events ({recent.length})</Label>
				{recent.length === 0 ? (
					<Label>No events.</Label>
				) : (
					<Scroll>
						<div>
							{recent.map((e, i) => (
								<EventRow key={i}>
									<Cell style={{ opacity: 0.75 }} title={fmtTime(e.ts)}>
										{new Date(e.ts).toLocaleTimeString()} · {ago(e.ts)}
									</Cell>
									<Mono>{e.ip}</Mono>
									<Mono>{e.method}</Mono>
									<Mono title={e.url}>{e.url}</Mono>
									<Mono style={{ color: e.status >= 500 ? FAIL : e.status >= 400 ? WARN : undefined }}>
										{e.status}
									</Mono>
									<Categories list={e.categories} />
								</EventRow>
							))}
						</div>
					</Scroll>
				)}
				<Label sx={{ fontSize: ".68rem" }}>
					Only masked URLs are kept, never request bodies. Data lives in this process's memory: it resets on
					restart, and each blue-green process has its own.
				</Label>
			</VBox>

			{blockIp !== null && (
				<BlockDialog
					initialIp={blockIp}
					onClose={() => setBlockIp(null)}
					onDone={list => {
						setBlockIp(null);
						applyList(list);
					}}
				/>
			)}
		</VBox>
	);
};
