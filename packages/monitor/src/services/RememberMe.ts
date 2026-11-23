// "Remember me": host + login go to localStorage; the password is never stored
// by us — it is handed to the browser's password manager, which keeps it in the
// OS-encrypted store bound to this origin. Storing it ourselves (even
// "encrypted" in JS) would leave the key right next to the ciphertext.

const STORAGE_KEY = "monitor.auth";

export interface IRemembered {
	host: string;
	login: string;
}

export const loadRemembered = (): IRemembered | null => {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return { host: parsed.host ?? "", login: parsed.login ?? "" };
	} catch {
		return null;
	}
};

export const saveRemembered = (v: IRemembered) => {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ host: v.host, login: v.login }));
	} catch {
		/* storage unavailable */
	}
};

export const forgetRemembered = () => {
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* storage unavailable */
	}
};

// Credential Management API (Chromium only). Not in TS's DOM lib, so typed here.
interface IPasswordCredentialCtor {
	new (data: { id: string; password: string; name?: string }): Credential;
}
interface IPasswordCredential extends Credential {
	password?: string;
}

const PasswordCredentialCtor = (window as unknown as { PasswordCredential?: IPasswordCredentialCtor })
	.PasswordCredential;

// Ask the browser to save the password after a successful sign-in. The
// browser shows its own "Save password?" prompt; the user stays in control.
export const storePasswordInBrowser = async (login: string, password: string) => {
	if (!PasswordCredentialCtor || !navigator.credentials || !login || !password) return;
	try {
		await navigator.credentials.store(new PasswordCredentialCtor({ id: login, password, name: login }));
	} catch {
		/* user declined or API blocked — nothing to do */
	}
};

// Pre-fill from the password manager. Never auto-submits: a fresh 2FA code is
// still required for every sign-in.
export const getPasswordFromBrowser = async (): Promise<{ login: string; password: string } | null> => {
	if (!PasswordCredentialCtor || !navigator.credentials) return null;
	try {
		const cred = (await navigator.credentials.get({
			password: true,
			mediation: "optional",
		} as CredentialRequestOptions)) as IPasswordCredential | null;
		if (!cred || !cred.password) return null;
		return { login: cred.id, password: cred.password };
	} catch {
		return null;
	}
};
