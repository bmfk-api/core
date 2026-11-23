import { Signal } from "ui/src/signals";
import {
	IError,
	ISession,
	TCapability,
	request_enroll2fa,
	request_login,
	request_logout,
	setSuppressUnauthorized,
	setUnauthorizedHandler,
} from "../api/Request";
import { forgetRemembered, saveRemembered, storePasswordInBrowser } from "./RememberMe";

// Host and login are kept for the request layer and the form; the password is
// only held for the duration of a sign-in call and cleared right after.
export const authForm = {
	login: "",
	password: "",
	totp: "",
	host: "",
};

export type TAuthForm = typeof authForm;
export type TAuthStatus = "unauthorized" | "checking" | "enroll" | "authorized";

export interface IEnrollment {
	enrollmentToken: string;
	secret: string;
	otpauthUri: string;
	expiresAt: number;
}

// Session lives in memory only (per the guide: never localStorage).
export const session: { current: ISession | null } = { current: null };

// The "remember me" choice travels with the sign-in request so it can be
// applied only once the server has accepted the credentials.
export type TSignIn = TAuthForm & { remember: boolean };

export const S_AUTH = new Signal<TSignIn>("S_AUTH");
export const S_ENROLL = new Signal<string>("S_ENROLL");
export const S_LOGOUT = new Signal<void>("S_LOGOUT");
export const S_AUTH_STATUS = new Signal<TAuthStatus>("S_AUTH_STATUS");
export const S_AUTH_ERROR = new Signal<IError | null>("S_AUTH_ERROR");
export const S_ENROLLMENT = new Signal<IEnrollment | null>("S_ENROLLMENT");

// UI-only gate; the server enforces roles on every endpoint.
export const can = (cap: TCapability): boolean => session.current?.capabilities?.includes(cap) ?? false;

export class Auth {
	state: TAuthStatus = "unauthorized";
	private enrollment: IEnrollment | null = null;

	constructor() {
		S_AUTH_STATUS.onSubscribe = cb => cb!(this.state);
		S_ENROLLMENT.onSubscribe = cb => cb!(this.enrollment);
		S_AUTH.subscribe(form => this.signIn(form));
		S_ENROLL.subscribe(code => this.enroll(code));
		S_LOGOUT.subscribe(() => this.logout());
		setUnauthorizedHandler(error => this.expire(error));
	}

	private setState(state: TAuthStatus) {
		this.state = state;
		S_AUTH_STATUS.invoke(state);
	}

	private setEnrollment(e: IEnrollment | null) {
		this.enrollment = e;
		S_ENROLLMENT.invoke(e);
	}

	private startSession(s: ISession) {
		session.current = s;
		this.setEnrollment(null);
		this.setState("authorized");
	}

	// Persist only after the server accepted the credentials (session issued or
	// 2FA enrollment started) so a typo in host/login is never remembered.
	private applyRememberMe(form: TSignIn) {
		if (!form.remember) {
			forgetRemembered();
			return;
		}
		saveRemembered({ host: form.host, login: form.login });
		void storePasswordInBrowser(form.login, form.password);
	}

	private async signIn(form: TSignIn | null) {
		if (!form) return;
		authForm.login = form.login;
		authForm.host = form.host;

		S_AUTH_ERROR.invoke(null);
		this.setState("checking");

		const response = await request_login({
			login: form.login,
			password: form.password,
			totp: form.totp.trim() || undefined,
		});

		if (response.error || !response.data) {
			S_AUTH_ERROR.invoke(response.error ?? { code: -1, message: "Empty login response" });
			this.setState("unauthorized");
			return;
		}

		const d = response.data;
		this.applyRememberMe(form);
		if ("enrollmentRequired" in d) {
			this.setEnrollment({
				enrollmentToken: d.enrollmentToken,
				secret: d.secret,
				otpauthUri: d.otpauthUri,
				expiresAt: Date.now() + d.expiresInMs,
			});
			this.setState("enroll");
			return;
		}
		this.startSession(d);
	}

	private async enroll(code: string) {
		if (!this.enrollment) return;
		S_AUTH_ERROR.invoke(null);
		const response = await request_enroll2fa({ enrollmentToken: this.enrollment.enrollmentToken, totp: code.trim() });
		if (response.error || !response.data) {
			S_AUTH_ERROR.invoke(response.error ?? { code: -1, message: "Empty enrollment response" });
			return;
		}
		this.startSession(response.data);
	}

	private async logout() {
		if (session.current) await request_logout();
		session.current = null;
		setSuppressUnauthorized(false);
		this.setEnrollment(null);
		this.setState("unauthorized");
	}

	// Any 401 outside the login flow means the session is gone (idle 15 min or
	// the 8 h cap) — drop it and send the operator back to the login screen.
	private expire(error: IError) {
		if (this.state !== "authorized") return;
		session.current = null;
		S_AUTH_ERROR.invoke({ ...error, message: "Session expired — please sign in again." });
		this.setState("unauthorized");
	}
}
