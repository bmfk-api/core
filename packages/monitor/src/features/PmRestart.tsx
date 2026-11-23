import { useEffect, useRef, useState } from "react";
import { Box, HBox, VBox } from "ui/src/box/Box";
import { Typo } from "ui/src/text/Typo";
import { Label } from "../components/Label";
import { Modal } from "../components/Modal";
import { TextInput } from "../components/TextInput";
import { REQ_PROCINFO, REQ_RESTART } from "../services/Metrix";
import { IProcInfo } from "../types";
import { IError, setSuppressUnauthorized } from "../api/Request";
import { S_AUTH_ERROR, S_LOGOUT, can } from "../services/Auth";

const ACCENT = "#48BFE3";
const WARN = "#e9b61e";
const FAIL = "#bb5656";
const OK = "#80FFDB";
const MUTED = "#9a96ad";

// Timings for the restart lifecycle.
// - GRACE_MS: wait a bit longer than the server's ~750ms grace before
//   we start hammering procinfo, so pm2 has a chance to respawn.
// - POLL_MS: cadence while we're checking if the new process is up.
// - TIMEOUT_MS: give up asking after this window (still leaves the panel
//   in "waiting" so the operator can see what happened).
// - DONE_HOLD_MS: how long to show the "Restarted ✓" success chip.
const GRACE_MS = 2500;
const POLL_MS = 2000;
const TIMEOUT_MS = 45_000;
const DONE_HOLD_MS = 6000;

type TPhase = "idle" | "confirming" | "restarting" | "waiting" | "done" | "timeout";

// Chip that renders a small colored badge — used for the pm2 managed/not-managed
// indicator and other status pills.
const Chip = ({ tone, children }: { tone: "ok" | "warn" | "fail" | "muted"; children: React.ReactNode }) => {
	const color =
		tone === "ok" ? OK : tone === "warn" ? WARN : tone === "fail" ? FAIL : MUTED;
	return (
		<HBox
			sx={{
				alignItems: "center",
				gap: "6px",
				padding: "3px 10px",
				borderRadius: "999px",
				border: `1px solid ${color}55`,
				backgroundColor: `${color}18`,
			}}>
			<Box sx={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: color }} />
			<Typo variant="medium" sx={{ fontSize: ".72rem", color, letterSpacing: ".04em", textTransform: "uppercase" }}>
				{children}
			</Typo>
		</HBox>
	);
};

const Metric = ({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) => (
	<VBox sx={{ gap: "2px", minWidth: "90px" }}>
		<Label>{label}</Label>
		<Typo variant="headMedium" sx={color ? { color } : undefined}>
			{value}
		</Typo>
	</VBox>
);

interface IProps {
	data: IProcInfo;
}

export const PmRestart = ({ data }: IProps) => {
	const pm2 = data.identity.pm2;
	const managed = pm2?.managed === true;
	const name = pm2?.name ?? "";
	const currentPid = data.identity.pid;
	const currentUptime = data.identity.uptimeSec;
	const isAdmin = can("admin");

	const [phase, setPhase] = useState<TPhase>("idle");
	const [confirmText, setConfirmText] = useState("");
	const [password, setPassword] = useState("");
	const [totp, setTotp] = useState("");
	const [error, setError] = useState<IError | null>(null);
	const [lastRestartBy, setLastRestartBy] = useState<string | null>(null);
	// Sessions live in the server process's memory, so the respawned process
	// answers our old token with 401 — that is the "it's back" signal too.
	const [sessionDropped, setSessionDropped] = useState(false);

	// Snapshot of the process identity at the moment we sent the restart
	// request. Used to detect that pm2 respawned us: either the pid changed
	// or uptime went backwards.
	const preRestart = useRef<{ pid: number; uptimeSec: number } | null>(null);

	const clearSecrets = () => {
		setPassword("");
		setTotp("");
	};

	const [, sendRestart, , sending] = REQ_RESTART.useRequest(response => {
		if (response?.error) {
			setError(response.error);
			setTotp(""); // a TOTP code is single-use; force a fresh one
			setPhase("confirming"); // stay in the modal so operator sees the error
			return;
		}
		if (response?.data?.restarting) {
			setLastRestartBy(response.data.by);
			preRestart.current = { pid: currentPid, uptimeSec: currentUptime };
			setError(null);
			setSuppressUnauthorized(true);
			setPhase("waiting");
			setConfirmText("");
			clearSecrets();
		}
	});

	// Separate procinfo poll during the "waiting" phase. The parent's own poll
	// is too slow to give responsive feedback that the process is back.
	const [, getProcInfo] = REQ_PROCINFO.useRequest(response => {
		if (phase !== "waiting") return;
		if (response?.error?.code === 401) {
			setSessionDropped(true);
			setPhase("done");
			return;
		}
		if (response?.error) return; // expected during respawn
		const id = response?.data?.identity;
		if (!id || !preRestart.current) return;
		const respawned =
			id.pid !== preRestart.current.pid || id.uptimeSec < preRestart.current.uptimeSec;
		if (respawned) setPhase("done");
	});

	// Never leave the global 401 suppression on past the restart window.
	useEffect(() => {
		if (phase === "timeout" || phase === "idle") setSuppressUnauthorized(false);
	}, [phase]);
	useEffect(() => () => setSuppressUnauthorized(false), []);

	// While waiting, fire procinfo pings on a fast interval, after a small grace
	// period. Also arm a timeout so we don't loop forever on a broken pm2.
	useEffect(() => {
		if (phase !== "waiting") return;
		let cancelled = false;
		const graceTimer = window.setTimeout(() => {
			if (cancelled) return;
			getProcInfo();
		}, GRACE_MS);
		const interval = window.setInterval(() => {
			if (cancelled) return;
			getProcInfo();
		}, POLL_MS);
		const timeout = window.setTimeout(() => {
			if (cancelled) return;
			setPhase("timeout");
		}, TIMEOUT_MS);
		return () => {
			cancelled = true;
			window.clearTimeout(graceTimer);
			window.clearInterval(interval);
			window.clearTimeout(timeout);
		};
	}, [phase, getProcInfo]);

	// Auto-clear the "done" state after showing it for a bit. If the new
	// process doesn't know our session, go back to the login screen.
	useEffect(() => {
		if (phase !== "done") return;
		const t = window.setTimeout(() => {
			if (sessionDropped) {
				S_AUTH_ERROR.invoke({ code: 401, message: "Process restarted — please sign in again." });
				S_LOGOUT.invoke();
				return;
			}
			setPhase("idle");
		}, DONE_HOLD_MS);
		return () => window.clearTimeout(t);
	}, [phase, sessionDropped]);

	const openConfirm = () => {
		if (!managed) return;
		setError(null);
		setConfirmText("");
		clearSecrets();
		setPhase("confirming");
	};

	const closeConfirm = () => {
		if (sending) return;
		setPhase("idle");
		setConfirmText("");
		clearSecrets();
		setError(null);
	};

	const confirmMatches = managed && confirmText === name && name.length > 0;
	const canSubmit = confirmMatches && password.length > 0 && /^\d{6}$/.test(totp.trim());

	const submitRestart = () => {
		if (!canSubmit || sending) return;
		setError(null);
		setPhase("restarting");
		sendRestart({ confirm: confirmText, password, totp: totp.trim() });
	};

	// ---------- render ----------

	return (
		<VBox sx={{ gap: "14px" }}>
			<HBox sx={{ gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
				<Typo variant="headMedium">Process management</Typo>
				{managed ? <Chip tone="ok">pm2 managed</Chip> : <Chip tone="warn">not under pm2</Chip>}
				{phase === "waiting" && <Chip tone="muted">restarting…</Chip>}
				{phase === "restarting" && <Chip tone="muted">sending…</Chip>}
				{phase === "done" && <Chip tone="ok">restarted ✓</Chip>}
				{phase === "timeout" && <Chip tone="fail">timed out</Chip>}
			</HBox>

			{managed ? (
				<HBox sx={{ gap: "20px", flexWrap: "wrap" }}>
					<Metric label="pm2 name" value={pm2?.name ?? "—"} color={ACCENT} />
					<Metric label="pm2 id" value={pm2?.pmId ?? "—"} />
					<Metric label="instance" value={pm2?.instanceId ?? "—"} />
					<Metric label="pid" value={currentPid} />
				</HBox>
			) : (
				<Label sx={{ fontSize: ".78rem" }}>
					This process has no pm2 pm_id in its environment — restarting from the UI is disabled because
					nothing would bring it back up.
				</Label>
			)}

			{!isAdmin && (
				<Label sx={{ fontSize: ".74rem" }}>Restart is available to the admin role only.</Label>
			)}

			{isAdmin && (
			<HBox sx={{ gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
				<Box
					onClick={managed && phase === "idle" ? openConfirm : undefined}
					sx={{
						padding: "9px 18px",
						borderRadius: "6px",
						cursor: managed && phase === "idle" ? "pointer" : "not-allowed",
						fontSize: ".78rem",
						fontWeight: 600,
						letterSpacing: ".08em",
						textTransform: "uppercase",
						color: managed && phase === "idle" ? "#fff" : "rgba(255,255,255,.35)",
						backgroundColor: managed && phase === "idle" ? FAIL : "rgba(255,255,255,.05)",
						border: `1px solid ${managed && phase === "idle" ? FAIL : "rgba(255,255,255,.08)"}`,
						transition: "background-color .2s, border-color .2s",
						"&:hover":
							managed && phase === "idle"
								? { backgroundColor: "#9c4a4a" }
								: undefined,
					}}>
					Restart process
				</Box>

				{phase === "waiting" && (
					<Label sx={{ fontSize: ".76rem" }}>
						Waiting for process to come back up… (pm2 autorestart)
					</Label>
				)}
				{phase === "done" && lastRestartBy && (
					<Label sx={{ fontSize: ".76rem", color: OK }}>
						Restart requested by <b>{lastRestartBy}</b>
						{sessionDropped && " — session ended with the old process, signing out…"}
					</Label>
				)}
				{phase === "timeout" && (
					<Label sx={{ fontSize: ".76rem", color: FAIL }}>
						Process didn't come back within {Math.round(TIMEOUT_MS / 1000)} s — check pm2 autorestart.
					</Label>
				)}
			</HBox>
			)}

			{isAdmin && (
				<Label sx={{ fontSize: ".7rem", opacity: 0.8 }}>
					Relies on pm2 autorestart. Restart briefly interrupts traffic — for blue-green setups, prefer
					restarting the inactive slot.
				</Label>
			)}

			{(phase === "confirming" || phase === "restarting") && (
				<Modal title="Restart process" onClose={closeConfirm} width="520px">
					<VBox sx={{ gap: "16px" }}>
						<VBox sx={{ gap: "6px" }}>
							<Typo variant="medium">
								You are about to restart the pm2 process{" "}
								<Typo variant="medium" sx={{ fontFamily: "monospace", color: ACCENT, display: "inline" }}>
									{name}
								</Typo>
								{pm2?.pmId != null && (
									<Typo variant="medium" sx={{ opacity: 0.8, display: "inline" }}>
										{" "}
										(id {pm2.pmId})
									</Typo>
								)}
								.
							</Typo>
							<Label sx={{ fontSize: ".76rem" }}>
								This will briefly interrupt in-flight requests. pm2 autorestart will bring the
								process back within a few seconds.
							</Label>
						</VBox>

						<VBox sx={{ gap: "6px" }}>
							<Label>
								To confirm, type the pm2 process name:{" "}
								<Typo variant="medium" sx={{ fontFamily: "monospace", color: ACCENT, display: "inline" }}>
									{name}
								</Typo>
							</Label>
							<TextInput
								autoFocus
								value={confirmText}
								disabled={sending}
								placeholder={name}
								onChange={e => setConfirmText(e.target.value)}
								onKeyDown={e => {
									if (e.key === "Enter") submitRestart();
								}}
							/>
						</VBox>

						<VBox sx={{ gap: "6px" }}>
							<Label>Re-enter your password and a fresh 2FA code</Label>
							<HBox sx={{ gap: "10px", flexWrap: "wrap" }}>
								<Box sx={{ flex: "1 1 200px" }}>
									<TextInput
										type="password"
										autoComplete="current-password"
										value={password}
										disabled={sending}
										placeholder="Password"
										onChange={e => setPassword(e.target.value)}
										onKeyDown={e => {
											if (e.key === "Enter") submitRestart();
										}}
									/>
								</Box>
								<Box sx={{ flex: "0 0 140px" }}>
									<TextInput
										inputMode="numeric"
										autoComplete="one-time-code"
										maxLength={6}
										value={totp}
										disabled={sending}
										placeholder="2FA code"
										onChange={e => setTotp(e.target.value.replace(/\D/g, ""))}
										onKeyDown={e => {
											if (e.key === "Enter") submitRestart();
										}}
									/>
								</Box>
							</HBox>
						</VBox>

						{error && (
							<Box
								sx={{
									padding: "10px 12px",
									borderRadius: "6px",
									backgroundColor: "rgba(187,86,86,.14)",
									border: "1px solid rgba(187,86,86,.4)",
								}}>
								<Typo variant="medium" sx={{ fontSize: ".82rem", color: FAIL }}>
									{error.details || error.message || "Restart failed."}
								</Typo>
							</Box>
						)}

						<HBox sx={{ gap: "10px", justifyContent: "flex-end", marginTop: "4px" }}>
							<Box
								onClick={sending ? undefined : closeConfirm}
								sx={{
									padding: "9px 16px",
									borderRadius: "6px",
									cursor: sending ? "not-allowed" : "pointer",
									fontSize: ".78rem",
									fontWeight: 600,
									letterSpacing: ".06em",
									textTransform: "uppercase",
									color: sending ? "rgba(255,255,255,.35)" : "rgba(255,255,255,.85)",
									border: "1px solid rgba(255,255,255,.12)",
									"&:hover": sending ? undefined : { backgroundColor: "rgba(255,255,255,.06)" },
								}}>
								Cancel
							</Box>
							<Box
								onClick={canSubmit && !sending ? submitRestart : undefined}
								sx={{
									padding: "9px 18px",
									borderRadius: "6px",
									cursor: canSubmit && !sending ? "pointer" : "not-allowed",
									fontSize: ".78rem",
									fontWeight: 600,
									letterSpacing: ".08em",
									textTransform: "uppercase",
									color: canSubmit && !sending ? "#fff" : "rgba(255,255,255,.35)",
									backgroundColor: canSubmit && !sending ? FAIL : "rgba(255,255,255,.05)",
									border: `1px solid ${canSubmit && !sending ? FAIL : "rgba(255,255,255,.08)"}`,
									"&:hover": canSubmit && !sending ? { backgroundColor: "#9c4a4a" } : undefined,
								}}>
								{sending ? "Sending…" : "Restart"}
							</Box>
						</HBox>
					</VBox>
				</Modal>
			)}
		</VBox>
	);
};
