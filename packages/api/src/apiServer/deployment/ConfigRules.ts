// Rules and builders shared by the CLI wizards and the config generator on the website. No Node
// imports: the site bundles this file and runs it in the browser. Tests check what it builds
// against the deployer's and the access file's own validation.

export const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function projectNameProblem(name: unknown): string | null {
    if (typeof name !== "string" || name.length === 0) return "the project has no \"name\"";
    if (!PROJECT_NAME.test(name))
        return `project name "${name}" is not allowed — lowercase letters, digits, ".", "_" and "-" only, starting with a letter or digit, up to 100 characters (e.g. "api.gateway.example.com")`;
    return null;
}

// PCI DSS v4.0 (8.3.6) wants 12 characters.
export const MIN_PASSWORD_LENGTH = 12;

export function passwordProblem(password: string): string | null {
    if (!password || !password.trim()) return "the password is empty";
    if (password.length < MIN_PASSWORD_LENGTH) return `at least ${MIN_PASSWORD_LENGTH} characters`;
    return null;
}

/** Monitor and documentation logins: ":" separates the realm in sessions and 2FA records. */
export function accessLoginProblem(login: string): string | null {
    if (!login.trim()) return "required";
    return login.includes(":") ? "no \":\" in logins" : null;
}

/** Deployer users and reviewers. */
export function deployerLoginProblem(login: string): string | null {
    return /^[A-Za-z0-9._@-]{1,64}$/.test(login) ? null : "letters, digits, \".\", \"_\", \"-\", \"@\" only";
}

/** The deployer's upload URL: https (http only to this machine, through an SSH tunnel), ending in /pckg/add. */
export function deployUrlProblem(url: string): string | null {
    let u: URL;
    try { u = new URL(url); } catch { return "not a URL"; }
    if (!/\/pckg\/add\/?$/.test(u.pathname)) return "must end with /pckg/add";
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return u.protocol === "https:" || (u.protocol === "http:" && local) ? null : "must be https (http only to localhost)";
}

export const MONITOR_ROLES = { admin: "everything", it: "dashboard and logs", analytic: "dashboard only" } as const;
export type TMonitorRoleName = keyof typeof MONITOR_ROLES;

// ---- scrypt hashes: scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>, as PasswordHash writes them ----

export const SCRYPT = { N: 16384, r: 8, p: 1, dkLen: 32 } as const;
export type TScrypt = (password: Uint8Array, salt: Uint8Array, o: { N: number, r: number, p: number, dkLen: number }) => Promise<Uint8Array>;

export function toBase64(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

/** A PasswordHash-compatible hash, with the scrypt implementation of the environment (Node or browser). */
export async function scryptHash(scrypt: TScrypt, secret: string, salt: Uint8Array): Promise<string> {
    const key = await scrypt(new TextEncoder().encode(secret), salt, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${toBase64(salt)}$${toBase64(key)}`;
}

// ---- project: the config for the deployer and the deploy.json for the machine that deploys ----

export interface IProjectAnswers {
    name: string;
    description?: string;
    destination: string;
    kind: "service" | "static";             // a Node service under pm2, or files only (a site)
    omitDev?: boolean;
    migrate?: boolean;
    backup?: boolean;
    pm2Attributes?: string[];
    liveness?: string;
    email?: string[];
    configKeys?: string[];                  // _{{KEY}}_ placeholders; values are filled in on the server
    secrets?: boolean;                      // keep config values in a secrets file outside the code
    bluegreen?: { bluePort: string, greenPort: string, onSwitch: string[] };
    nginx?: { configDir: string, domain?: string };
    review?: { reviewers: string[], mode: "any" | "all", ttlHours: number };
    host: string;                           // deployer upload URL, …/pckg/add
    login: string;                          // deployer user in setup.json
}

export function buildProject(a: IProjectAnswers, s: { token: string, tokenHash: string, privateKey: string })
    : { project: Record<string, unknown>, deploy: Record<string, unknown> } {
    const service = a.kind === "service";
    const config: Record<string, string> = {};
    for (const k of a.configKeys ?? []) config[k] = "";
    const project: Record<string, unknown> = {
        name: a.name,
        destination: a.destination,
        description: a.description?.trim() || a.name,   // required, non-empty
        token: s.tokenHash,
        unpack: true,
        ignoreDirectoryClean: false,
        backup: a.backup ?? true,
        install: service,
        migrate: service && !!a.migrate,
        pm2: service,
        ...(service && a.omitDev ? { omitDev: true } : {}),
        ...(service && a.pm2Attributes?.length ? { pm2_attributes: a.pm2Attributes } : {}),
        ...(a.email?.length ? { email: a.email } : {}),
        ...(a.liveness ? { liveness: a.liveness } : {}),
        config,
        ...(service && a.bluegreen ? { bluegreen: {
            blue_config: { port: a.bluegreen.bluePort }, green_config: { port: a.bluegreen.greenPort },
            ...(a.bluegreen.onSwitch.length ? { on_switch: a.bluegreen.onSwitch } : {}),
        } } : {}),
        ...(a.nginx ? { nginx: { config_dir: a.nginx.configDir, ...(a.nginx.domain ? { domain: a.nginx.domain } : {}) } } : {}),
        ...(service && a.secrets && a.configKeys?.length ? { secrets: {} } : {}),
        ...(a.review ? { review: a.review } : {}),
    };
    const deploy: Record<string, unknown> = {
        name: a.name,
        host: a.host,
        token: s.token,
        username: a.login,
        privateKey: s.privateKey,
        ...(service ? {} : { versionBump: false }),
    };
    return { project, deploy };
}

/** Where a project's config goes on the deployer. */
export const projectConfigPath = (projectsPath: string, name: string) => `${projectsPath.replace(/\/+$/, "")}/${name}.json`;

// ---- setup.json (the deployer) and access.json (monitor, documentation): add entries to a document ----

type TDoc = Record<string, any>;

/** Parses a pasted file; empty text starts a new one. */
export function parseDoc(text: string): { doc?: TDoc, error?: string } {
    if (!text.trim()) return { doc: {} };
    try {
        const doc = JSON.parse(text);
        return doc && typeof doc === "object" && !Array.isArray(doc) ? { doc } : { error: "not a JSON object" };
    } catch (e: any) { return { error: "not valid JSON: " + (e?.message ?? e) }; }
}

const withEntry = (doc: TDoc, list: string, entry: TDoc): { doc?: TDoc, error?: string } => {
    const items: TDoc[] = Array.isArray(doc[list]) ? doc[list] : [];
    if (items.some(u => u?.login === entry.login)) return { error: `"${entry.login}" is already in ${list}` };
    return { doc: { ...doc, [list]: [...items, entry] } };
};

export function addDeployerUser(doc: TDoc, u: { login: string, publicKey: string }) {
    const problem = deployerLoginProblem(u.login);
    return problem ? { error: problem } : withEntry(doc, "users", { login: u.login, publicKey: u.publicKey });
}

export function addReviewer(doc: TDoc, r: { login: string, passwordHash: string, email: string }) {
    const problem = deployerLoginProblem(r.login) ?? (/^[^\s@]+@[^\s@]+$/.test(r.email) ? null : "a valid email is needed for the review links");
    return problem ? { error: problem } : withEntry(doc, "reviewers", { login: r.login, password: r.passwordHash, email: r.email });
}

export function addMonitorUser(doc: TDoc, u: { login: string, passwordHash: string, role: TMonitorRoleName }) {
    const problem = accessLoginProblem(u.login) ?? (u.role in MONITOR_ROLES ? null : "a role is required");
    return problem ? { error: problem } : withEntry(doc, "monitor", { login: u.login, password: u.passwordHash, role: u.role });
}

export function addDocumentationUser(doc: TDoc, u: { login: string, passwordHash: string, endpoints?: string[] }) {
    const problem = accessLoginProblem(u.login);
    return problem ? { error: problem }
        : withEntry(doc, "documentation", { login: u.login, password: u.passwordHash, ...(u.endpoints?.length ? { endpoints: u.endpoints } : {}) });
}

/** "10.0.0.0/8, 203.0.113.7" → a list; the server checks each entry when it loads the file. */
export const listOf = (text: string) => text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

/** A file written in one paste into a shell, private to its owner. */
export function shellWrite(file: string, content: string): string {
    let marker = "BMFK_EOF";
    while (content.includes(marker)) marker += "_";
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    return `${dir ? `mkdir -p '${dir}' && ` : ""}umask 077 && cat > '${file}' <<'${marker}'\n${content}\n${marker}\nchmod 600 '${file}'`;
}
