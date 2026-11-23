import { useEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { Box, HBox, VBox } from "ui/src/box/Box";
import Button from "ui/src/button/Button";
import Panel from "ui/src/panel/Panel";
import { Typo, TypoCaption } from "ui/src/text/Typo";
import { ITheme } from "ui/src/theme/GlobalTheme";
import { S_AUTH, S_AUTH_ERROR, S_AUTH_STATUS, S_ENROLL, S_ENROLLMENT, S_LOGOUT, TAuthForm } from "./services/Auth";
import { IError } from "./api/Request";
import { QrCode } from "./QrCode";

// Focus/active accent — matches the kit input focus blue (not the yellow brand accent).
const FOCUS = "#1a5bff";

// The backend injects a real value here when it serves the app; only then is
// the manual host field unnecessary.
const injectedHost = (window as { __host?: string }).__host;
const hasInjectedHost = !!injectedHost && !/\{\{\w+\}\}/.test(injectedHost);

// Build-time version injected by vite.config.ts (buildMetaPlugin).
const APP_VERSION = (window as { __ver?: string }).__ver;

// "Remember me" persists only host and login (never the password) in localStorage.
const STORAGE_KEY = "documentation.auth";

const loadStored = (): TAuthForm | null => {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return { host: parsed.host ?? "", login: parsed.login ?? "", password: "", totp: "" };
	} catch {
		return null;
	}
};

const FormEl = styled.form`
	display: flex;
	flex-direction: column;
	gap: 16px;
`;

const Switch = styled.button<{ $on: boolean; theme: ITheme }>`
	flex: 0 0 auto;
	position: relative;
	width: 34px;
	height: 19px;
	padding: 0;
	border: none;
	border-radius: 19px;
	cursor: pointer;
	background-color: ${({ $on }) => ($on ? FOCUS : "rgba(255,255,255,.16)")};
	transition: background-color 0.2s;
	&::after {
		content: "";
		position: absolute;
		top: 2px;
		left: 2px;
		width: 15px;
		height: 15px;
		border-radius: 50%;
		background-color: #fff;
		transition: transform 0.2s;
		transform: translateX(${({ $on }) => ($on ? "15px" : "0")});
	}
`;

const Field = styled.input<{ theme: ITheme }>`
	width: 100%;
	box-sizing: border-box;
	padding: 13px 14px;
	border-radius: 6px;
	font-size: 0.95rem;
	outline: none;
	color: ${({ theme }) => theme.colors.textPrimary};
	background-color: ${({ theme }) => theme.colors.inputBackgroundPrimary};
	border: 1px solid ${({ theme }) => theme.colors.inputBorderPrimary};
	transition: border-color 0.2s;
	&:focus {
		border-color: ${FOCUS};
	}
`;

export const Login = () => {
	const state = S_AUTH_STATUS.use([]);
	const error = S_AUTH_ERROR.use([]);
	const checking = state === "checking";

	const stored = useState(loadStored)[0];
	// When the backend injected a real __host, ignore any remembered host so a
	// stale value from a previous session can't override the detected one.
	const initialForm: TAuthForm = {
		host: hasInjectedHost ? "" : (stored?.host ?? ""),
		login: stored?.login ?? "",
		password: "",
		totp: "",
	};
	const [form, setForm] = useState<TAuthForm>(initialForm);
	const [remember, setRemember] = useState(!!stored);
	const set = (key: keyof TAuthForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
		setForm(prev => ({ ...prev, [key]: e.target.value }));

	const canSubmit =
		form.login.trim().length > 0 &&
		form.password.length > 0 &&
		(form.totp === "" || /^\d{6}$/.test(form.totp)) &&
		(hasInjectedHost || form.host.trim().length > 0);

	const submit = () => {
		if (!canSubmit || checking) return;
		try {
			if (remember) localStorage.setItem(STORAGE_KEY, JSON.stringify({ host: form.host, login: form.login }));
			else localStorage.removeItem(STORAGE_KEY);
		} catch {
			/* localStorage unavailable — ignore */
		}
		S_AUTH.invoke(form);
		setForm(prev => ({ ...prev, password: "", totp: "" }));
	};

	if (state === "enroll") return <Enroll />;

	return (
		<VBox sx={{ minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: "20px" }}>
			<Panel label="API Documentation" busy={checking} sx={{ minWidth: "340px", maxWidth: "380px" }}>
				<FormEl
					onSubmit={e => {
						e.preventDefault();
						submit();
					}}>
					{hasInjectedHost ? (
						<VBox sx={{ gap: "6px" }}>
							<TypoCaption>Detected API host</TypoCaption>
							<Box
								sx={{
									padding: "10px 12px",
									backgroundColor: "rgba(0,0,0,0.25)",
									border: "1px solid rgba(255,255,255,0.08)",
									borderRadius: "6px",
								}}>
								<Typo
									sx={{
										fontFamily: "monospace",
										fontSize: "12px",
										color: "rgba(255,255,255,0.75)",
										overflowWrap: "anywhere",
									}}>
									{injectedHost}
								</Typo>
							</Box>
						</VBox>
					) : (
						<VBox sx={{ gap: "6px" }}>
							<TypoCaption>API doc URL</TypoCaption>
							<Field value={form.host} onChange={set("host")} placeholder=".../api/v1/json" />
						</VBox>
					)}
					<VBox sx={{ gap: "6px" }}>
						<TypoCaption>Login</TypoCaption>
						<Field value={form.login} onChange={set("login")} autoComplete="username" />
					</VBox>
					<VBox sx={{ gap: "6px" }}>
						<TypoCaption>Password</TypoCaption>
						<Field
							type="password"
							value={form.password}
							onChange={set("password")}
							autoComplete="current-password"
						/>
					</VBox>

					<VBox sx={{ gap: "6px" }}>
						<TypoCaption>Code from the authenticator app (empty at the first sign-in)</TypoCaption>
						<Field
							value={form.totp}
							onChange={e => setForm(prev => ({ ...prev, totp: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
							inputMode="numeric"
							autoComplete="one-time-code"
							placeholder="123456"
						/>
					</VBox>

					<HBox sx={{ gap: "10px", alignItems: "center" }}>
						<Switch type="button" $on={remember} onClick={() => setRemember(v => !v)} />
						<TypoCaption>Remember me</TypoCaption>
					</HBox>

					{error && <ErrorBox error={error} />}

					<Button onClick={submit} disabled={!canSubmit || checking}>
						{checking ? "Signing in…" : "Sign in"}
					</Button>
				</FormEl>
				{APP_VERSION && (
					<Typo
						sx={{
							display: "block",
							marginTop: "14px",
							textAlign: "center",
							fontSize: "10px",
							color: "rgba(255,255,255,0.35)",
							letterSpacing: "0.3px",
						}}>
						v{APP_VERSION}
					</Typo>
				)}
			</Panel>
		</VBox>
	);
};

const ErrorBox = ({ error }: { error: IError }) => (
	<Box
		sx={{
			border: "1px dashed rgba(255,94,122,0.6)",
			backgroundColor: "rgba(255,94,122,0.12)",
			borderRadius: "6px",
			padding: "12px 14px",
		}}>
		<Typo variant="medium" sx={{ color: "#ff5e7a", fontWeight: 600 }}>
			{error.details ? `${error.message}: ${error.details}` : error.message}
		</Typo>
	</Box>
);

// The first sign-in: scan the QR, confirm with a code. The server stores the secret only once a
// correct code arrives, then returns a session.
const Enroll = () => {
	const enrollment = S_ENROLLMENT.use([]);
	const error = S_AUTH_ERROR.use([]);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [now, setNow] = useState(Date.now());
	const formRef = useRef<HTMLFormElement | null>(null);

	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);
	useEffect(() => {
		if (error) setBusy(false);
	}, [error]);

	if (!enrollment) return null;
	const left = Math.max(0, Math.round((enrollment.expiresAt - now) / 1000));
	const expired = left === 0;
	const valid = /^\d{6}$/.test(code);

	const submit = () => {
		if (!valid || busy || expired) return;
		setBusy(true);
		S_ENROLL.invoke(code);
		setCode("");
	};

	return (
		<VBox sx={{ minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: "20px" }}>
			<Panel label="Set up two-factor authentication" busy={busy} sx={{ minWidth: "340px", maxWidth: "420px" }}>
				<FormEl
					ref={formRef}
					onSubmit={e => {
						e.preventDefault();
						submit();
					}}>
					<TypoCaption>
						Scan the code with Google Authenticator (or any TOTP app), then enter the 6-digit code it shows.
					</TypoCaption>
					<VBox sx={{ alignItems: "center" }}>
						<QrCode value={enrollment.otpauthUri} size={208} />
					</VBox>
					<VBox sx={{ gap: "6px" }}>
						<TypoCaption>No camera? Enter this key manually</TypoCaption>
						<Field readOnly value={enrollment.secret} onFocus={e => e.currentTarget.select()} style={{ fontFamily: "monospace" }} />
					</VBox>
					<VBox sx={{ gap: "6px" }}>
						<TypoCaption>Code from the app</TypoCaption>
						<Field
							autoFocus
							value={code}
							onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
							inputMode="numeric"
							autoComplete="one-time-code"
							placeholder="123456"
						/>
					</VBox>
					<TypoCaption sx={{ fontSize: ".7rem" }}>
						{expired
							? "Enrollment expired — go back and sign in again."
							: `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
						{" · "}If the phone is lost, ask the API owner to reset your two-factor authentication.
					</TypoCaption>
					{error && <ErrorBox error={error} />}
					<HBox sx={{ gap: "10px" }}>
						<Button onClick={() => S_LOGOUT.invoke()}>Back</Button>
						<Button onClick={() => formRef.current?.requestSubmit()} disabled={!valid || busy || expired}>
							{busy ? "Verifying…" : "Enable 2FA"}
						</Button>
					</HBox>
				</FormEl>
			</Panel>
		</VBox>
	);
};
