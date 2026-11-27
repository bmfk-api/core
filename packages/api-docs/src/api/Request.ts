import axios, { AxiosError, AxiosRequestConfig } from "axios";

import { authForm, session } from "../services/Auth";

export interface IError {
	code: number;
	message: string;
	details?: string;
	stack?: { [key: string]: IError };
}
export interface IApiResponse<T = any> {
	error?: IError;
	httpStatus: number;
	data?: T;
}

export interface ISession {
	token: string;
	login: string;
	idleTimeoutMs: number;
	maxLifetimeMs: number;
	twoFactor: boolean;
}

export interface IEnrollmentRequired {
	enrollmentRequired: true;
	enrollmentToken: string;
	secret: string;
	otpauthUri: string;
	expiresInMs: number;
}

// The API's origin. In the Vite dev server the page runs elsewhere: point it at a local API
// (VITE_API_ORIGIN, default the sandbox on :18900).
export const apiOrigin = (): string =>
	import.meta.env.DEV ? (import.meta.env.VITE_API_ORIGIN ?? "http://localhost:18900") : window.location.origin;

// Where the documentation's own endpoints live (".../doc/"). Served by the backend (it injects __host):
// always this page's own origin, so a crafted ?host= can't send the sign-in elsewhere. Otherwise (dev,
// a copy of the page): a doc-JSON URL pasted in the login form or given as ?host=.
export const docJsonUrl = (): string => {
	const injected = ((window as any)["__host"] as string | undefined)?.trim() ?? "";
	if (injected && !/\{\{\w+\}\}/.test(injected))
		return apiOrigin().replace(/\/$/, "") + (injected.startsWith("/") ? injected : "/" + injected);

	let pasted = authForm.host?.trim() ?? "";
	const fromQuery = new URLSearchParams(window.location.search).get("host");
	if (fromQuery) pasted = fromQuery.trim();
	if (pasted) {
		// Repair a garbled scheme ("https//host") and default to https.
		pasted = pasted.replace(/^(https?):?\/\//i, "$1://");
		if (!/^https?:\/\//i.test(pasted)) pasted = "https://" + pasted.replace(/^\/+/, "");
		return pasted;
	}
	return apiOrigin().replace(/\/$/, "") + "/api/doc/json";
};

const docUrl = (endpoint: string): string => docJsonUrl().replace(/json\/?$/, "") + endpoint;

// The auth layer registers this to go back to the sign-in screen when the session ends
// (15 min idle, 8 h at most, revoked, user removed).
let onUnauthorized: ((e: IError) => void) | null = null;
export const setUnauthorizedHandler = (fn: (e: IError) => void) => {
	onUnauthorized = fn;
};

export const request_login = (req: { login: string; password: string; totp?: string }) =>
	request<ISession | IEnrollmentRequired>(docUrl("login"), req, true);

export const request_enroll2fa = (req: { enrollmentToken: string; totp: string }) =>
	request<ISession>(docUrl("enroll2fa"), req, true);

export const request_logout = () => request<{ ok: boolean }>(docUrl("logout"), {});

export const request_doc = () => request<any>(docJsonUrl(), {});

const request = async <T>(url: string, data: unknown, signIn = false): Promise<IApiResponse<T>> => {
	const body: AxiosRequestConfig = {
		url,
		method: "POST",
		responseType: "json",
		headers: {
			"Content-Type": "application/json",
			...(session.current && !signIn ? { Authorization: "Bearer " + session.current.token } : {}),
		},
		data,
	};

	let resp;
	try {
		resp = await axios(body);
	} catch (err) {
		const e = err as AxiosError;
		const payload = e.response?.data as any;
		if (payload && typeof payload === "object" && "error" in payload) {
			const error = payload.error as IError;
			if (e.response?.status === 401 && !signIn) onUnauthorized?.(error);
			return { error, httpStatus: e.response?.status ?? 0 };
		}
		return { error: { code: -1, message: "Network error, " + e.message }, httpStatus: 0 };
	}
	if (!resp) return { error: { code: -1, message: "Network error" }, httpStatus: 0 };
	if (!resp.data.httpStatus) resp.data.httpStatus = resp.status;
	return resp.data;
};
