import { Signal } from "ui/src/signals";
import { IError, ISession, request_enroll2fa, request_login, request_logout, setUnauthorizedHandler } from "../api/Request";

// Host and login are kept for the request layer and the form; the password only for the sign-in call.
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

// The session lives in memory only: never in localStorage.
export const session: { current: ISession | null } = { current: null };

export const S_AUTH = new Signal<TAuthForm>("S_AUTH");
export const S_ENROLL = new Signal<string>("S_ENROLL");
export const S_LOGOUT = new Signal<void>("S_LOGOUT");
export const S_AUTH_STATUS = new Signal<TAuthStatus>("S_AUTH_STATUS");
export const S_AUTH_ERROR = new Signal<IError | null>("S_AUTH_ERROR");
export const S_ENROLLMENT = new Signal<IEnrollment | null>("S_ENROLLMENT");

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

	private async signIn(form: TAuthForm | null) {
		if (!form) return;
		authForm.login = form.login;
		authForm.host = form.host;

		S_AUTH_ERROR.invoke(null);
		this.setState("checking");

		const response = await request_login({ login: form.login, password: form.password, totp: form.totp.trim() || undefined });
		if (response.error || !response.data) {
			S_AUTH_ERROR.invoke(response.error ?? { code: -1, message: "Empty sign-in response" });
			this.setState("unauthorized");
			return;
		}
		const d = response.data;
		if ("enrollmentRequired" in d) {
			this.setEnrollment({ enrollmentToken: d.enrollmentToken, secret: d.secret, otpauthUri: d.otpauthUri, expiresAt: Date.now() + d.expiresInMs });
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
		this.setEnrollment(null);
		this.setState("unauthorized");
	}

	// A 401 outside sign-in means the session is gone: back to the sign-in screen.
	private expire(error: IError) {
		if (this.state !== "authorized") return;
		session.current = null;
		S_AUTH_ERROR.invoke({ ...error, message: "Session expired — please sign in again." });
		this.setState("unauthorized");
	}
}
