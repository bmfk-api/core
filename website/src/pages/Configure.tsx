import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from "react";
import {
    buildProject, projectConfigPath, projectNameProblem, deployUrlProblem, deployerLoginProblem, accessLoginProblem,
    passwordProblem, MONITOR_ROLES, type TMonitorRoleName, parseDoc, addDeployerUser, addReviewer, addMonitorUser,
    addDocumentationUser, listOf, shellWrite,
} from "../../../packages/api/src/apiServer/deployment/ConfigRules";
import { ed25519Pair, ed25519Supported, hashSecret, isPublicKey, publicKeyOf, randomHex } from "../lib/keys";
import { IconCheck, IconCopy, IconShield } from "../components/icons";
import { site } from "../site";

type Doc = Record<string, any>;

// ---- small pieces ----

function Field({ label, hint, error, group, children }: { label: string, hint?: ReactNode, error?: string | null, group?: boolean, children: ReactNode }) {
    const body = <>
        <span className="cfg-label">{label}</span>
        {children}
        {error ? <span className="cfg-error">{error}</span> : hint ? <span className="cfg-hint">{hint}</span> : null}
    </>;
    // A <label> around several buttons would press the first one on a click on its text.
    return group ? <div className="cfg-field" role="group" aria-label={label}>{body}</div> : <label className="cfg-field">{body}</label>;
}

const Input = ({ value, set, ...rest }: { value: string, set: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) =>
    <input className="cfg-input" value={value} onChange={e => set(e.target.value)} spellCheck={false} autoComplete="off" {...rest} />;

const Check = ({ checked, set, children }: { checked: boolean, set: (v: boolean) => void, children: ReactNode }) =>
    <label className="cfg-check"><input type="checkbox" checked={checked} onChange={e => set(e.target.checked)} /><span>{children}</span></label>;

function Choice<T extends string>({ value, set, options }: { value: T, set: (v: T) => void, options: [T, string][] }) {
    return (
        <div className="cfg-choice" role="radiogroup">
            {options.map(([v, label]) => <button type="button" key={v} role="radio" aria-checked={value === v} className={value === v ? "active" : ""} onClick={() => set(v)}>{label}</button>)}
        </div>
    );
}

function Output({ title, where, text, file, secret }: { title: string, where: string, text: string, file?: string, secret?: boolean }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
    };
    const download = () => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text + "\n"], { type: "application/json" }));
        a.download = file!;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    return (
        <div className={"cfg-output" + (secret ? " secret" : "")}>
            <div className="cfg-output-head">
                <div><div className="cfg-output-title">{title}</div><div className="cfg-output-where">{where}</div></div>
                <div className="cfg-output-actions">
                    {file && <button type="button" className="btn btn-small" onClick={download}>Download</button>}
                    <button type="button" className="btn btn-small" onClick={copy}>{copied ? <IconCheck /> : <IconCopy />} {copied ? "Copied" : "Copy"}</button>
                </div>
            </div>
            <pre>{text}</pre>
        </div>
    );
}

const json = (v: unknown) => JSON.stringify(v, null, 4);
const absProblem = (p: string) => !p.startsWith("/") ? "an absolute path" : /^\/(var|etc|home|usr|opt|srv|tmp|root)?\/?$/.test(p) ? "a folder of its own, not a system folder" : null;

// An existing file pasted in, or a new one; entries are added one by one, the result is shown whole.
function useDoc() {
    const [doc, setDoc] = useState<Doc>({});
    const [pasted, setPasted] = useState("");
    const [error, setError] = useState<string | null>(null);
    const load = () => { const r = parseDoc(pasted); if (r.error) setError(r.error); else { setDoc(r.doc!); setError(null); } };
    const apply = (r: { doc?: Doc, error?: string }) => { if (r.error) { setError(r.error); return false; } setDoc(r.doc!); setError(null); return true; };
    const remove = (list: string, login: string) => setDoc(d => {
        const rest = (d[list] ?? []).filter((u: any) => u.login !== login);
        const next = { ...d, [list]: rest };
        if (!rest.length) delete next[list];
        return next;
    });
    return { doc, setDoc, pasted, setPasted, load, apply, remove, error, setError };
}

function Existing({ d, what }: { d: ReturnType<typeof useDoc>, what: string }) {
    return (
        <details className="cfg-existing">
            <summary>Add to an existing {what}</summary>
            <textarea className="cfg-input cfg-textarea" value={d.pasted} onChange={e => d.setPasted(e.target.value)} placeholder={`Paste the current ${what} here`} spellCheck={false} />
            <button type="button" className="btn btn-small" onClick={d.load}>Load</button>
        </details>
    );
}

function Entries({ items, list, d, describe }: { items: any[] | undefined, list: string, d: ReturnType<typeof useDoc>, describe: (u: any) => string }) {
    if (!items?.length) return null;
    return (
        <ul className="cfg-entries">
            {items.map(u => <li key={u.login}><b>{u.login}</b><span>{describe(u)}</span><button type="button" onClick={() => d.remove(list, u.login)} aria-label={`Remove ${u.login}`}>Remove</button></li>)}
        </ul>
    );
}

// ---- project ----

function ProjectTab() {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [kind, setKind] = useState<"service" | "static">("service");
    const [destination, setDestination] = useState("");
    const [host, setHost] = useState("https://");
    const [login, setLogin] = useState("ci");
    const [keyMode, setKeyMode] = useState<"new" | "paste">("new");
    const [pastedKey, setPastedKey] = useState("");
    const [projectsPath, setProjectsPath] = useState("/var/bmfk/bmfk-deployer/projects");
    const [backup, setBackup] = useState(true);
    const [omitDev, setOmitDev] = useState(false);
    const [migrate, setMigrate] = useState(false);
    const [configKeys, setConfigKeys] = useState("");
    const [secrets, setSecrets] = useState(true);
    const [bg, setBg] = useState(false);
    const [bluePort, setBluePort] = useState("8055");
    const [greenPort, setGreenPort] = useState("8056");
    const [onSwitch, setOnSwitch] = useState("/usr/sbin/nginx -s reload");
    const [nginx, setNginx] = useState(false);
    const [nginxDir, setNginxDir] = useState("/etc/nginx/node-projects");
    const [domain, setDomain] = useState("");
    const [review, setReview] = useState(false);
    const [reviewers, setReviewers] = useState("");
    const [mode, setMode] = useState<"any" | "all">("any");
    const [emails, setEmails] = useState("");
    const [busy, setBusy] = useState(false);
    const [out, setOut] = useState<{ project: string, deploy: string, user?: string, path: string } | null>(null);
    const [failure, setFailure] = useState<string | null>(null);

    const dest = destination || (name ? `${kind === "static" ? "/var/www" : "/var/node"}/${name}` : "");
    const keys = listOf(configKeys);
    const problems = {
        name: name ? projectNameProblem(name) : "required",
        destination: dest ? absProblem(dest) : "required",
        host: deployUrlProblem(host),
        login: deployerLoginProblem(login),
        keys: keys.find(k => !/^[A-Za-z0-9_]+$/.test(k)) ? "letters, digits and _ only" : null,
        ports: bg && (!/^\d{2,5}$/.test(bluePort) || !/^\d{2,5}$/.test(greenPort) || bluePort === greenPort) ? "two different ports" : null,
        reviewers: review && !listOf(reviewers).length ? "at least one reviewer login from setup.json" : null,
        projectsPath: absProblem(projectsPath),
    };
    const ready = Object.values(problems).every(p => !p);

    const generate = async () => {
        setBusy(true); setFailure(null);
        try {
            let privateKey: string, publicKey: string | null = null;
            if (keyMode === "new") ({ privateKey, publicKey } = await ed25519Pair());
            else {
                privateKey = pastedKey.trim();
                if (!(await publicKeyOf(privateKey))) throw new Error("the pasted private key is not an Ed25519 key (base64 PKCS#8 from deploy.json)");
            }
            const token = randomHex(32);
            const service = kind === "service";
            const { project, deploy } = buildProject({
                name, description, destination: dest, kind, host: host.trim(), login,
                backup, omitDev, migrate, configKeys: keys, secrets,
                email: listOf(emails),
                bluegreen: service && bg ? { bluePort, greenPort, onSwitch: onSwitch.trim().split(/\s+/).filter(Boolean) } : undefined,
                nginx: nginx ? { configDir: nginxDir, domain: domain.trim() || undefined } : undefined,
                review: review ? { reviewers: listOf(reviewers), mode, ttlHours: 24 } : undefined,
            }, { token, tokenHash: await hashSecret(token), privateKey });
            const path = projectConfigPath(projectsPath, name);
            setOut({ project: json(project), deploy: json(deploy), path, user: publicKey ? json({ login, publicKey }) : undefined });
        } catch (e: any) { setFailure(e?.message ?? String(e)); setOut(null); }
        setBusy(false);
    };

    return (
        <div className="cfg-grid">
            <form className="cfg-form" onSubmit={e => { e.preventDefault(); if (ready) generate(); }}>
                <h3>Project</h3>
                <Field label="Name" hint="Lowercase, digits, . _ - — e.g. api.shop.example.com" error={name ? problems.name : null}><Input value={name} set={setName} placeholder="api.shop" /></Field>
                <Field label="Description"><Input value={description} set={setDescription} placeholder={name || "Shop API"} /></Field>
                <Field label="What is deployed" group><Choice value={kind} set={setKind} options={[["service", "Node service (pm2)"], ["static", "Static site (dist/)"]]} /></Field>
                <Field label="Folder on the server" hint="Cleaned on every deploy: a folder of its own" error={destination ? problems.destination : null}><Input value={destination} set={setDestination} placeholder={dest || "/var/node/api.shop"} /></Field>

                <h3>Deployer</h3>
                <Field label="Upload URL" hint="https://<deployer domain>/api/pckg/add" error={host.length > 8 ? problems.host : null}><Input value={host} set={setHost} /></Field>
                <Field label="Deployer user" hint="A login in the deployer's setup.json" error={problems.login}><Input value={login} set={setLogin} /></Field>
                <Field label="Signing key" group>
                    <Choice value={keyMode} set={setKeyMode} options={[["new", "Generate a new key"], ["paste", "Use my existing key"]]} />
                </Field>
                {keyMode === "paste" && <Field label="Private key" hint="privateKey from your current deploy.json"><Input value={pastedKey} set={setPastedKey} type="password" /></Field>}
                <Field label="Project configs folder on the deployer" error={problems.projectsPath}><Input value={projectsPath} set={setProjectsPath} /></Field>

                <h3>Deploy steps</h3>
                <Check checked={backup} set={setBackup}>Back up the current version before each deploy</Check>
                {kind === "service" && <>
                    <Check checked={migrate} set={setMigrate}>Run <code>npm run migrate</code> before the start</Check>
                    <Check checked={omitDev} set={setOmitDev}>Install without devDependencies</Check>
                    <Field label="Config keys" hint={<>Placeholders <code>_&#123;&#123;KEY&#125;&#125;_</code> in your code. Values are filled in on the server, not here.</>} error={problems.keys}><Input value={configKeys} set={setConfigKeys} placeholder="DB_HOST, DB_PASS" /></Field>
                    {keys.length > 0 && <Check checked={secrets} set={setSecrets}>Keep the values in a secrets file, out of the code and backups</Check>}
                    <Check checked={bg} set={setBg}>Blue-green: two slots, switch without downtime</Check>
                    {bg && <div className="cfg-row">
                        <Field label="Blue port" error={problems.ports}><Input value={bluePort} set={setBluePort} /></Field>
                        <Field label="Green port"><Input value={greenPort} set={setGreenPort} /></Field>
                    </div>}
                    {bg && <Field label="Command after a switch"><Input value={onSwitch} set={setOnSwitch} /></Field>}
                </>}
                <Check checked={nginx} set={setNginx}>Let the deployer manage this project's nginx config</Check>
                {nginx && <div className="cfg-row">
                    <Field label="nginx config folder"><Input value={nginxDir} set={setNginxDir} /></Field>
                    <Field label="Domain"><Input value={domain} set={setDomain} placeholder="shop.example.com" /></Field>
                </div>}
                <Check checked={review} set={setReview}>Deploys wait for a reviewer's approval</Check>
                {review && <div className="cfg-row">
                    <Field label="Reviewers" hint="Logins from setup.json" error={problems.reviewers}><Input value={reviewers} set={setReviewers} placeholder="lead, cto" /></Field>
                    <Field label="Approval" group><Choice value={mode} set={setMode} options={[["any", "Any one"], ["all", "All"]]} /></Field>
                </div>}
                <Field label="Emails for deploy events" hint="Optional, comma-separated"><Input value={emails} set={setEmails} /></Field>

                <button className="btn btn-primary" type="submit" disabled={!ready || busy}>{busy ? "Generating…" : out ? "Generate again" : "Generate"}</button>
                {failure && <div className="cfg-error">{failure}</div>}
            </form>
            <div className="cfg-results">
                {!out ? <div className="cfg-placeholder">The project config for the deployer and the deploy.json for your machine appear here. A new token is made each time.</div> : <>
                    <Output title="1. Project config" where={`On the deployer: paste into an SSH session (writes ${out.path}, mode 600). It is picked up without a restart.`} text={shellWrite(out.path, out.project)} />
                    {keys.length > 0 && <div className="cfg-note">Then fill in the <code>config</code> values in that file on the server.</div>}
                    {out.user && <Output title="2. Deployer user" where="Add to the deployer's setup.json (or use the Deployer setup tab): the public half of the new key." text={out.user} />}
                    <Output title={`${out.user ? "3" : "2"}. deploy.json`} where="On your machine, in the project folder. It can deploy on its own: never commit or share it." text={out.deploy} file="deploy.json" secret />
                    <div className="cfg-note">Deploy with <code>npx {site.cli} deploy</code>.</div>
                </>}
            </div>
        </div>
    );
}

// ---- deployer setup ----

function SetupTab() {
    const d = useDoc();
    const [login, setLogin] = useState("");
    const [keyMode, setKeyMode] = useState<"new" | "paste">("new");
    const [publicKey, setPublicKey] = useState("");
    const [madeKey, setMadeKey] = useState<{ login: string, privateKey: string } | null>(null);
    const [rLogin, setRLogin] = useState("");
    const [rEmail, setREmail] = useState("");
    const [rPass, setRPass] = useState("");
    const [ips, setIps] = useState("");
    const [reviewUrl, setReviewUrl] = useState("");
    const [setupPath, setSetupPath] = useState("/var/bmfk/bmfk-deployer/setup/setup.json");
    const [busy, setBusy] = useState(false);

    const addUser = async () => {
        if (keyMode === "paste") {
            if (!isPublicKey(publicKey)) return d.setError("not an Ed25519 public key — paste what `npx bmfk deploy-key` printed");
            if (d.apply(addDeployerUser(d.doc, { login, publicKey: publicKey.trim() }))) { setLogin(""); setPublicKey(""); }
            return;
        }
        const pair = await ed25519Pair();
        if (d.apply(addDeployerUser(d.doc, { login, publicKey: pair.publicKey }))) { setMadeKey({ login, privateKey: pair.privateKey }); setLogin(""); }
    };
    const addRev = async () => {
        const p = passwordProblem(rPass);
        if (p) return d.setError("reviewer password: " + p);
        setBusy(true);
        if (d.apply(addReviewer(d.doc, { login: rLogin, passwordHash: await hashSecret(rPass), email: rEmail.trim() }))) { setRLogin(""); setREmail(""); setRPass(""); }
        setBusy(false);
    };

    const doc: Doc = { ...d.doc };
    if (listOf(ips).length) doc.allowed_ips = listOf(ips);
    if (reviewUrl.trim()) doc.review_url = reviewUrl.trim();
    const text = json(doc);

    return (
        <div className="cfg-grid">
            <div className="cfg-form">
                <Existing d={d} what="setup.json" />
                <h3>Who may deploy</h3>
                <Field label="Login" error={login ? deployerLoginProblem(login) : null}><Input value={login} set={setLogin} placeholder="ci" /></Field>
                <Field label="Key" group><Choice value={keyMode} set={setKeyMode} options={[["new", "Generate a key pair"], ["paste", "Paste a public key"]]} /></Field>
                {keyMode === "paste" && <Field label="Public key" hint="From npx bmfk deploy-key"><Input value={publicKey} set={setPublicKey} /></Field>}
                <button type="button" className="btn" disabled={!login || !!deployerLoginProblem(login)} onClick={addUser}>Add user</button>
                <Entries items={d.doc.users} list="users" d={d} describe={u => u.publicKey ? "signing key" : "password"} />

                <h3>Reviewers <span className="cfg-optional">optional</span></h3>
                <div className="cfg-row">
                    <Field label="Login"><Input value={rLogin} set={setRLogin} /></Field>
                    <Field label="Email"><Input value={rEmail} set={setREmail} type="email" /></Field>
                </div>
                <Field label="Password" hint={`At least 12 characters. 2FA is set up at the first sign-in.`}><Input value={rPass} set={setRPass} type="password" autoComplete="new-password" /></Field>
                <button type="button" className="btn" disabled={!rLogin || busy} onClick={addRev}>{busy ? "Hashing…" : "Add reviewer"}</button>
                <Entries items={d.doc.reviewers} list="reviewers" d={d} describe={r => r.email} />
                <Field label="Review page URL" hint="https://<deployer domain>/api/review/html"><Input value={reviewUrl} set={setReviewUrl} /></Field>

                <h3>Settings</h3>
                <Field label="Addresses allowed to deploy" hint="IPs and subnets, comma-separated; empty — any (not recommended)"><Input value={ips} set={setIps} placeholder="203.0.113.7, 10.8.0.0/24" /></Field>
                <Field label="Path of setup.json on the server"><Input value={setupPath} set={setSetupPath} /></Field>
                {d.error && <div className="cfg-error">{d.error}</div>}
            </div>
            <div className="cfg-results">
                {madeKey && <Output title={`Private key of ${madeKey.login}`} where={`Put it into ${madeKey.login}'s deploy.json as "privateKey". Shown once: it is not kept anywhere.`} text={madeKey.privateKey} secret />}
                <Output title="setup.json" where={`On the deployer: paste into an SSH session (writes ${setupPath}, mode 600). The deployer re-reads it on change. Add the Telegram bot by hand on the server.`} text={shellWrite(setupPath, text)} />
                <Output title="setup.json (file only)" where="The same content, to edit or keep" text={text} file="setup.json" />
            </div>
        </div>
    );
}

// ---- access: monitor and documentation ----

function AccessTab() {
    const d = useDoc();
    const [who, setWho] = useState<"monitor" | "documentation">("monitor");
    const [login, setLogin] = useState("");
    const [pass, setPass] = useState("");
    const [pass2, setPass2] = useState("");
    const [role, setRole] = useState<TMonitorRoleName>("it");
    const [endpoints, setEndpoints] = useState("");
    const [ips, setIps] = useState("");
    const [project, setProject] = useState("");
    const [busy, setBusy] = useState(false);

    const add = async () => {
        const p = passwordProblem(pass) ?? (pass !== pass2 ? "the passwords differ" : null);
        if (p) return d.setError(p);
        setBusy(true);
        const passwordHash = await hashSecret(pass);
        const ok = d.apply(who === "monitor"
            ? addMonitorUser(d.doc, { login, passwordHash, role })
            : addDocumentationUser(d.doc, { login, passwordHash, endpoints: listOf(endpoints) }));
        if (ok) { setLogin(""); setPass(""); setPass2(""); setEndpoints(""); }
        setBusy(false);
    };

    const doc: Doc = { ...d.doc };
    if (listOf(ips).length) doc.monitorAllowedIps = listOf(ips);
    const text = json(doc);
    const file = `/var/bmfk/${project || "<project>"}/access.json`;

    return (
        <div className="cfg-grid">
            <div className="cfg-form">
                <Existing d={d} what="access.json" />
                <h3>Add a user</h3>
                <Field label="For" group><Choice value={who} set={setWho} options={[["monitor", "Monitor"], ["documentation", "API documentation"]]} /></Field>
                <Field label="Login" error={login ? accessLoginProblem(login) : null}><Input value={login} set={setLogin} /></Field>
                <div className="cfg-row">
                    <Field label="Password" hint="At least 12 characters"><Input value={pass} set={setPass} type="password" autoComplete="new-password" /></Field>
                    <Field label="Repeat"><Input value={pass2} set={setPass2} type="password" autoComplete="new-password" /></Field>
                </div>
                {who === "monitor"
                    ? <Field label="Role" group><Choice value={role} set={setRole} options={Object.entries(MONITOR_ROLES).map(([r, what]) => [r as TMonitorRoleName, `${r} — ${what}`])} /></Field>
                    : <Field label="Endpoints" hint="Paths this user sees, comma-separated; empty — all"><Input value={endpoints} set={setEndpoints} placeholder="/api/v1/payments" /></Field>}
                <button type="button" className="btn" disabled={!login || busy} onClick={add}>{busy ? "Hashing…" : "Add user"}</button>
                <div className="cfg-hint">2FA is set up at the first sign-in.</div>
                <Entries items={d.doc.monitor} list="monitor" d={d} describe={u => "monitor · " + (u.role ?? "no role — no access")} />
                <Entries items={d.doc.documentation} list="documentation" d={d} describe={u => "documentation · " + (u.endpoints?.join(", ") ?? "all endpoints")} />

                <h3>Settings</h3>
                <Field label="Addresses allowed to open the monitor" hint="IPs and subnets; empty — any"><Input value={ips} set={setIps} /></Field>
                <Field label="Project" hint="The file lives in its data folder"><Input value={project} set={setProject} placeholder="api.shop" /></Field>
                {d.error && <div className="cfg-error">{d.error}</div>}
            </div>
            <div className="cfg-results">
                <Output title="access.json" where={`On the service's server: paste into an SSH session (writes ${file}, mode 600). Changes apply without a restart.`} text={shellWrite(file, text)} />
                <Output title="access.json (file only)" where="The same content, to edit or keep" text={text} file="access.json" />
            </div>
        </div>
    );
}

// ---- page ----

const tabs = [
    { id: "project", label: "New project", C: ProjectTab },
    { id: "setup", label: "Deployer setup", C: SetupTab },
    { id: "access", label: "Monitor & docs access", C: AccessTab },
] as const;

export function Configure() {
    const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("project");
    const [supported, setSupported] = useState<boolean | null>(null);
    useEffect(() => {
        document.title = `Config generator — ${site.name}`;
        // The page must run under its own CSP (no connections): a client-side navigation here keeps the
        // previous page's, so reload it as a document.
        if (!import.meta.env.DEV && !document.querySelector('meta[http-equiv="Content-Security-Policy"]')) location.reload();
        ed25519Supported().then(setSupported);
    }, []);

    return (
        <main id="main" className="cfg">
            <div className="eyebrow">Tools</div>
            <h1>Config generator</h1>
            <p className="cfg-lead">Project configs, deploy keys, the deployer's setup.json and access files for the monitor and the API documentation — made in this tab, ready to paste on the server.</p>
            <div className="callout callout-security" role="note">
                <div className="callout-icon"><IconShield /></div>
                <div className="callout-body">
                    <div className="callout-title">Nothing leaves your browser</div>
                    Keys, tokens and password hashes are made here, and the page is not allowed to connect anywhere (Content-Security-Policy <code>connect-src 'none'</code>). Close the tab when you are done. The same files come from the CLI: <code>npx {site.cli} project-config</code>, <code>setup-config</code>, <code>access-config</code>.
                </div>
            </div>
            {supported === false && <div className="callout callout-warn" role="note"><div className="callout-body">This browser can't make Ed25519 keys. Use a current Chrome, Firefox or Safari, or the CLI.</div></div>}
            <div className="tabs-bar cfg-tabs" role="tablist">
                {tabs.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>{t.label}</button>)}
            </div>
            {/* All three stay mounted: switching tabs keeps what was typed. */}
            {tabs.map(t => <div key={t.id} role="tabpanel" hidden={tab !== t.id}><t.C /></div>)}
        </main>
    );
}
