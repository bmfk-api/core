import { useEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { HBox, VBox } from "ui/src/box/Box";
import Button from "ui/src/button/Button";
import { Error } from "ui/src/error/Error";
import Panel from "ui/src/panel/Panel";
import { TypoCaption } from "ui/src/text/Typo";
import { ITheme } from "ui/src/theme/GlobalTheme";
import { authForm, S_AUTH, S_AUTH_ERROR, S_AUTH_STATUS, S_ENROLL, S_ENROLLMENT, S_LOGOUT, TAuthForm } from "../services/Auth";
import { QrCode } from "../components/QrCode";
import { getPasswordFromBrowser, loadRemembered } from "../services/RememberMe";

// The backend injects a real value here when it serves the app; only then is
// the manual host field unnecessary.
const injectedHost = (window as { __host?: string }).__host;
const hasInjectedHost = !!injectedHost && !injectedHost.includes("{{");

const fromRemembered = (): TAuthForm | null => {
	const r = loadRemembered();
	return r ? { host: r.host, login: r.login, password: "", totp: "" } : null;
};

// The kit Button is a div, so it never fires a real form submit. A native
// submit button gives us Enter-to-submit and the submit event that browser
// password managers watch to offer "Save password".
const HiddenSubmit = styled.button`
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	border: 0;
	opacity: 0;
	pointer-events: none;
`;

const FormEl = styled.form`
	position: relative;
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
	background-color: ${({ $on }) => ($on ? "#5390d9" : "rgba(255,255,255,.16)")};
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
		border-color: #5390d9;
	}
`;

export const Login = () => {
	const state = S_AUTH_STATUS.use([]);
	const error = S_AUTH_ERROR.use([]);
	const checking = state === "checking";

	const stored = useState(fromRemembered)[0];
	const formRef = useRef<HTMLFormElement | null>(null);
	const [form, setForm] = useState<TAuthForm>(stored ?? { ...authForm });
	const [remember, setRemember] = useState(!!stored);
	const set = (key: keyof TAuthForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
		setForm(prev => ({ ...prev, [key]: e.target.value }));

	const canSubmit =
		form.login.trim().length > 0 &&
		form.password.length > 0 &&
		(hasInjectedHost || form.host.trim().length > 0) &&
		(form.totp === "" || /^\d{6}$/.test(form.totp));

	// Pre-fill from the browser's password manager (Chromium). Only when the
	// user opted in earlier, never auto-submits — a fresh 2FA code is needed.
	useEffect(() => {
		if (!stored) return;
		let cancelled = false;
		getPasswordFromBrowser().then(c => {
			if (cancelled || !c) return;
			setForm(prev =>
				prev.password || (prev.login && prev.login !== c.login)
					? prev
					: { ...prev, login: c.login, password: c.password },
			);
		});
		return () => {
			cancelled = true;
		};
	}, [stored]);

	const submit = () => {
		if (!canSubmit || checking) return;
		S_AUTH.invoke({ ...form, remember });
		// Secrets are only needed for this one call; a TOTP code is single-use.
		setForm(prev => ({ ...prev, password: "", totp: "" }));
	};

	if (state === "enroll") return <Enroll />;

	return (
		<VBox sx={{ minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: "20px" }}>
			<Panel label="Server Monitor" busy={checking} sx={{ minWidth: "340px", maxWidth: "380px" }}>
				<FormEl
					ref={formRef}
					method="post"
					onSubmit={e => {
						e.preventDefault();
						submit();
					}}>
					<HiddenSubmit type="submit" tabIndex={-1} aria-hidden="true" />
					{!hasInjectedHost && (
						<VBox sx={{ gap: "6px" }}>
							<TypoCaption>API host</TypoCaption>
							<Field value={form.host} onChange={set("host")} placeholder="https://example.com/api/v1" />
						</VBox>
					)}
					<VBox sx={{ gap: "6px" }}>
						<TypoCaption>Login</TypoCaption>
						<Field name="username" value={form.login} onChange={set("login")} autoComplete="username" />
					</VBox>
					<VBox sx={{ gap: "6px" }}>
						<TypoCaption>Password</TypoCaption>
						<Field
							name="password"
							type="password"
							value={form.password}
							onChange={set("password")}
							autoComplete="current-password"
						/>
					</VBox>

					<VBox sx={{ gap: "6px" }}>
						<TypoCaption>2FA code</TypoCaption>
						<Field
							name="totp"
							value={form.totp}
							onChange={e => setForm(prev => ({ ...prev, totp: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
							inputMode="numeric"
							autoComplete="one-time-code"
							placeholder="6 digits from your authenticator"
						/>
						<TypoCaption sx={{ fontSize: ".7rem" }}>
							Leave empty only on your very first sign-in, before 2FA is set up.
						</TypoCaption>
					</VBox>

					<HBox sx={{ gap: "10px", alignItems: "center" }}>
						<Switch type="button" $on={remember} onClick={() => setRemember(v => !v)} />
						<TypoCaption>Remember me</TypoCaption>
						<TypoCaption sx={{ fontSize: ".66rem", opacity: 0.7 }}>
							(host and login; the password goes to your browser&apos;s password manager)
						</TypoCaption>
					</HBox>

					{error && <Error error={error} />}

					<Button onClick={() => formRef.current?.requestSubmit()} disabled={!canSubmit || checking}>
						{checking ? "Signing in…" : "Sign in"}
					</Button>
				</FormEl>
			</Panel>
		</VBox>
	);
};

// Step 2 of the first sign-in: scan the QR, confirm with a code. The server
// only stores the secret once a correct code arrives, then returns a session.
const Enroll = () => {
	const enrollment = S_ENROLLMENT.use([]);
	const error = S_AUTH_ERROR.use([]);
	const [code, setCode] = useState("");
	const formRef = useRef<HTMLFormElement | null>(null);
	const [busy, setBusy] = useState(false);
	const [now, setNow] = useState(Date.now());

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
					<HiddenSubmit type="submit" tabIndex={-1} aria-hidden="true" />
					<TypoCaption>
						Scan the code with Google Authenticator (or any TOTP app), then enter the 6-digit code it
						shows.
					</TypoCaption>
					<VBox sx={{ alignItems: "center", gap: "10px" }}>
						<QrCode value={enrollment.otpauthUri} size={208} />
					</VBox>
					<VBox sx={{ gap: "6px" }}>
						<TypoCaption>No camera? Enter this key manually</TypoCaption>
						<Field
							readOnly
							value={enrollment.secret}
							onFocus={e => e.currentTarget.select()}
							style={{ fontFamily: "monospace", letterSpacing: ".08em" }}
						/>
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
						{" · "}2FA can't be re-enrolled from the UI; if the phone is lost, an administrator has to reset
						it on the server.
					</TypoCaption>

					{error && <Error error={error} />}

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
