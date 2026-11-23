import { useState } from "react";
import { styled } from "styled-components";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";
import { Label } from "../components/Label";
import { Modal } from "../components/Modal";
import { TextInput } from "../components/TextInput";
import { IError, request_block } from "../api/Request";
import { IBlockEntry, IBlockedList } from "../types";

const FAIL = "#bb5656";
const OK = "#80FFDB";
const MUTED = "#8a8699";

export const ActionButton = styled.button<{ $tone?: "danger" | "plain" }>`
	padding: 4px 10px;
	border-radius: 5px;
	font-size: 0.66rem;
	font-weight: 600;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	white-space: nowrap;
	cursor: pointer;
	color: ${({ $tone }) => ($tone === "danger" ? "#fff" : "rgba(255,255,255,.85)")};
	background-color: ${({ $tone }) => ($tone === "danger" ? FAIL : "transparent")};
	border: 1px solid ${({ $tone }) => ($tone === "danger" ? FAIL : "rgba(255,255,255,.18)")};
	&:hover:not(:disabled) {
		background-color: ${({ $tone }) => ($tone === "danger" ? "#9c4a4a" : "rgba(255,255,255,.06)")};
	}
	&:disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}
`;

export const ErrorBox = ({ error }: { error: IError }) => (
	<Box
		sx={{
			padding: "10px 12px",
			borderRadius: "6px",
			backgroundColor: "rgba(187,86,86,.14)",
			border: "1px solid rgba(187,86,86,.4)",
		}}>
		<Typo variant="medium" sx={{ fontSize: ".82rem", color: FAIL }}>
			{error.details || error.message}
		</Typo>
	</Box>
);

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "");

// ---------- block dialog ----------

type TDuration = "forever" | "hours";

interface IBlockDialogProps {
	initialIp?: string;
	onClose: () => void;
	onDone: (list: IBlockedList) => void;
}

export const BlockDialog = ({ initialIp = "", onClose, onDone }: IBlockDialogProps) => {
	const [ip, setIp] = useState(initialIp);
	const [reason, setReason] = useState("");
	const [duration, setDuration] = useState<TDuration>("hours");
	const [hours, setHours] = useState("24");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<IError | null>(null);

	const hoursNum = Number(hours);
	const valid = ip.trim().length > 0 && (duration === "forever" || (Number.isFinite(hoursNum) && hoursNum > 0));

	const submit = async () => {
		if (!valid || busy) return;
		setBusy(true);
		setError(null);
		const r = await request_block({
			ip: ip.trim(),
			reason: reason.trim() || undefined,
			hours: duration === "forever" ? 0 : hoursNum,
		});
		setBusy(false);
		if (r.error || !r.data) {
			setError(r.error ?? { code: -1, message: "Empty response" });
			return;
		}
		onDone(r.data);
	};

	const onEnter = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") submit();
	};

	return (
		<Modal title="Block address" onClose={busy ? () => {} : onClose} width="480px">
			<VBox sx={{ gap: "16px" }}>
				<Label sx={{ fontSize: ".76rem" }}>
					A blocked address gets 403 on every request to the service — API, WebSocket and this monitor.
				</Label>

				<VBox sx={{ gap: "6px" }}>
					<Label>IP address or subnet</Label>
					<TextInput
						autoFocus
						value={ip}
						disabled={busy}
						placeholder="203.0.113.7 or 10.0.0.0/24"
						style={{ fontFamily: "monospace" }}
						onChange={e => setIp(e.target.value)}
						onKeyDown={onEnter}
					/>
				</VBox>

				<VBox sx={{ gap: "6px" }}>
					<Label>Reason (optional, visible only in the monitor)</Label>
					<TextInput
						value={reason}
						disabled={busy}
						placeholder="brute force"
						maxLength={200}
						onChange={e => setReason(e.target.value)}
						onKeyDown={onEnter}
					/>
				</VBox>

				<VBox sx={{ gap: "6px" }}>
					<Label>Duration</Label>
					<HBox sx={{ gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
						<ActionButton
							type="button"
							$tone={duration === "hours" ? "danger" : "plain"}
							onClick={() => setDuration("hours")}>
							Hours
						</ActionButton>
						<ActionButton
							type="button"
							$tone={duration === "forever" ? "danger" : "plain"}
							onClick={() => setDuration("forever")}>
							Forever
						</ActionButton>
						{duration === "hours" && (
							<Box sx={{ width: "110px" }}>
								<TextInput
									inputMode="numeric"
									value={hours}
									disabled={busy}
									onChange={e => setHours(e.target.value.replace(/[^\d.]/g, ""))}
									onKeyDown={onEnter}
								/>
							</Box>
						)}
					</HBox>
				</VBox>

				{error && <ErrorBox error={error} />}

				<HBox sx={{ gap: "10px", justifyContent: "flex-end" }}>
					<ActionButton type="button" disabled={busy} onClick={onClose} style={{ padding: "9px 16px" }}>
						Cancel
					</ActionButton>
					<ActionButton
						type="button"
						$tone="danger"
						disabled={!valid || busy}
						onClick={submit}
						style={{ padding: "9px 18px" }}>
						{busy ? "Blocking…" : "Block"}
					</ActionButton>
				</HBox>
			</VBox>
		</Modal>
	);
};

// ---------- blocked list ----------

const Grid = styled.div<{ $inactive?: boolean }>`
	display: grid;
	grid-template-columns: minmax(130px, 1fr) minmax(140px, 2fr) 150px 90px 70px 100px;
	gap: 10px;
	align-items: center;
	padding: 7px 12px;
	font-size: 0.76rem;
	border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	opacity: ${({ $inactive }) => ($inactive ? 0.45 : 1)};
`;

const Head = styled(Grid)`
	opacity: 0.55;
	font-weight: 600;
	font-size: 0.68rem;
	letter-spacing: 0.06em;
`;

const Cell = styled.div`
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
`;

const Scroll = styled.div`
	overflow-x: auto;
	border: 1px solid rgba(255, 255, 255, 0.06);
	border-radius: 8px;
	> div {
		min-width: 720px;
	}
`;

interface IBlockedListProps {
	list: IBlockedList | null;
	isAdmin: boolean;
	busyIp: string | null;
	onUnblock: (ip: string) => void;
}

export const BlockedTable = ({ list, isAdmin, busyIp, onUnblock }: IBlockedListProps) => {
	const [showExpired, setShowExpired] = useState(false);
	if (!list) return <Label>Loading…</Label>;

	const expired = list.entries.filter(e => !e.active).length;
	const entries = showExpired ? list.entries : list.entries.filter(e => e.active);

	const until = (e: IBlockEntry) => (e.until ? fmtDate(e.until) : "forever");

	return (
		<VBox sx={{ gap: "8px" }}>
			{expired > 0 && (
				<Box>
					<ActionButton type="button" onClick={() => setShowExpired(v => !v)}>
						{showExpired ? "Hide" : "Show"} {expired} expired
					</ActionButton>
				</Box>
			)}
			{entries.length === 0 ? (
				<Label>No blocked addresses.</Label>
			) : (
				<Scroll>
					<div>
						<Head>
							<Cell>ADDRESS</Cell>
							<Cell>REASON</Cell>
							<Cell>UNTIL</Cell>
							<Cell>BY</Cell>
							<Cell style={{ textAlign: "right" }}>REJECTED</Cell>
							<Cell />
						</Head>
						{entries.map(e => (
							<Grid key={e.ip} $inactive={!e.active}>
								<Cell style={{ fontFamily: "monospace", color: e.active ? FAIL : MUTED }}>{e.ip}</Cell>
								<Cell title={e.reason}>{e.reason || "—"}</Cell>
								<Cell title={e.at ? `blocked ${fmtDate(e.at)}` : undefined}>
									{e.active ? until(e) : "expired"}
								</Cell>
								<Cell>{e.by || "—"}</Cell>
								<Cell style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
									{list.hits[e.ip] ?? 0}
								</Cell>
								<Cell style={{ textAlign: "right" }}>
									{isAdmin && e.active && (
										<ActionButton
											type="button"
											disabled={busyIp === e.ip}
											onClick={() => onUnblock(e.ip)}>
											{busyIp === e.ip ? "…" : "Unblock"}
										</ActionButton>
									)}
								</Cell>
							</Grid>
						))}
					</div>
				</Scroll>
			)}
			{list.file && <Label sx={{ fontSize: ".68rem" }}>Stored in {list.file}. Rejected counts reset on restart.</Label>}
		</VBox>
	);
};

export const BlockedPill = () => (
	<Box
		sx={{
			display: "inline-block",
			padding: "2px 7px",
			borderRadius: "4px",
			fontSize: ".64rem",
			fontWeight: 600,
			letterSpacing: ".04em",
			textTransform: "uppercase",
			color: OK,
			border: `1px solid ${OK}55`,
			backgroundColor: `${OK}1a`,
			whiteSpace: "nowrap",
		}}>
		blocked
	</Box>
);
