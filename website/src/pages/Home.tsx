import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { site } from "../site";
import { mdxComponents } from "../components/mdx";
import { IconArrow, IconCheck, IconCopy } from "../components/icons";
import HeroCode from "./snippets/hero.mdx";
import ServiceCode from "./snippets/service.mdx";
import MicroserviceCode from "./snippets/microservice.mdx";
import DeployCode from "./snippets/deploy.mdx";

const pillars = [
  {
    name: "Build",
    text: "Endpoints, validation and types from one sample object.",
    items: [
      ["Endpoint classes with per-method handlers", "/docs/endpoints"],
      ["Validation models with inferred TypeScript types", "/docs/validation"],
      ["API documentation generated from the code", "/docs/api-documentation"],
      ["WebSockets on the same port", "/docs/websocket"],
    ],
  },
  {
    name: "Monitor",
    text: "An operations console that ships with every service.",
    items: [
      ["Request rate, errors and latency, with history", "/docs/monitor"],
      ["p50 / p95 / p99 per outgoing host", "/docs/http-client"],
      ["Application, request, pm2 and nginx logs", "/docs/monitor"],
      ["Probe and scanner detection", "/docs/monitor"],
    ],
  },
  {
    name: "Fortify",
    text: "Controls an auditor asks about, on by default.",
    items: [
      ["Mandatory TOTP 2FA, roles, lockout", "/docs/authentication"],
      ["Ed25519-signed requests, nothing stealable on the server", "/docs/interceptors"],
      ["Card data and secrets masked in every log", "/docs/logging"],
      ["IP allow-lists and blocking", "/docs/ip-blocking"],
    ],
  },
  {
    name: "Keep",
    text: "Releases you can review, switch and take back.",
    items: [
      ["Blue-green releases without downtime", "/docs/blue-green"],
      ["Backups before every deploy, atomic restore", "/docs/backups"],
      ["Four-eyes deploy review with a diff", "/docs/deploy-review"],
      ["Secrets outside the deployed code", "/docs/deployer#keeping-secrets-out-of-the-deployed-code"],
    ],
  },
] as const;

const pipeline = [
  { step: `${site.cli} deploy`, title: "Build and sign", text: "Builds, optionally bundles into one file, and signs the upload with the developer’s Ed25519 key." },
  { step: "Deployer", title: "Verify", text: "Allowed IPs, signature, project token and archive safety are checked before anything is unpacked." },
  { step: "Review", title: "Approve", text: "Reviewers see the diff and accept with password and 2FA. The archive hash must match what they saw." },
  { step: "Standby slot", title: "Install", text: "npm ci with scripts disabled, secrets written to a 600 file, the new version started in pm2." },
  { step: `${site.cli} activate`, title: "Switch", text: "nginx moves to the new slot. Rolling back is the same command, and takes seconds." },
];

const tabs = [
  { id: "service", label: "Service", C: ServiceCode },
  { id: "microservice", label: "Signed calls", C: MicroserviceCode },
  { id: "deploy", label: "Deploy", C: DeployCode },
] as const;

export function Home() {
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("service");
  const Active = tabs.find(t => t.id === tab)!.C;
  useEffect(() => { document.title = `${site.name} — ${site.fullName}`; }, []);

  return (
    <main id="main" className="home">
      <section className="hero">
        <div className="hero-text">
          <div className="eyebrow">TypeScript · Node.js {site.node}+ · MIT</div>
          <h1>APIs, operations and deploys in one TypeScript framework</h1>
          <p className="hero-lead">
            {site.name} gives a Node.js service everything around its business logic: validated endpoints, an
            operations console behind 2FA, signed deploys with blue-green releases, backups and four-eyes review,
            and logs that mask card data. Built for teams that run payment systems.
          </p>
          <div className="hero-actions">
            <Link to="/docs/quick-start" className="btn btn-primary">Get started <IconArrow /></Link>
            <Link to="/docs/security" className="btn">Security model</Link>
          </div>
          <Install />
        </div>
        <div className="hero-code window">
          <div className="window-bar"><span /><span /><span /><em>src/api/Payments.ts</em></div>
          <HeroCode components={mdxComponents} />
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow">{site.fullName}</div>
          <h2>{site.tagline}</h2>
          <p>Four jobs every production service has, handled by the same framework instead of four separate tools.</p>
        </div>
        <div className="pillars">
          {pillars.map(p => (
            <div className="pillar" key={p.name}>
              <div className="pillar-name">{p.name}</div>
              <p className="pillar-text">{p.text}</p>
              <ul>
                {p.items.map(([label, href]) => (
                  <li key={label}><Link to={href}>{label}</Link></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow">Deployment</div>
          <h2>From a commit to production, with a checkpoint at every step</h2>
          <p>The deployer runs on your server. Nothing is pushed by a third party, and every step leaves a record.</p>
        </div>
        <ol className="pipeline">
          {pipeline.map((s, i) => (
            <li key={s.step} className="pipeline-step">
              <div className="pipeline-num">{i + 1}</div>
              <code className="pipeline-cmd">{s.step}</code>
              <div className="pipeline-title">{s.title}</div>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
        <div className="section-more"><Link to="/docs/deployer">How the deployer works <IconArrow /></Link></div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow">In code</div>
          <h2>Small surface, explicit configuration</h2>
          <p>Options have safe defaults; everything that matters for security is written down in one place.</p>
        </div>
        <div className="tabs window">
          <div className="tabs-bar" role="tablist">
            {tabs.map(t => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
          <div className="tabs-panel" role="tabpanel"><Active components={mdxComponents} /></div>
        </div>
      </section>

      <section className="section scope">
        <div className="section-head">
          <div className="eyebrow">Scope</div>
          <h2>What it doesn’t claim</h2>
          <p>Knowing the limits is part of the security model. These are stated as plainly in the docs as the features.</p>
        </div>
        <div className="scope-grid">
          <div className="scope-item">
            <div className="scope-title">Not PCI DSS compliance on its own</div>
            <p>Compliance is assessed for your whole environment. The framework helps with specific requirements, and the mapping says which.</p>
            <Link to="/docs/pci-dss">PCI DSS mapping <IconArrow /></Link>
          </div>
          <div className="scope-item">
            <div className="scope-title">Not a WAF</div>
            <p>Threat monitoring records suspicious clients but never blocks them. Floods belong to nginx, fail2ban or a WAF.</p>
            <Link to="/docs/security">Security model <IconArrow /></Link>
          </div>
          <div className="scope-item">
            <div className="scope-title">Redaction is a safety net</div>
            <p>Masking is pattern-based. It catches mistakes; it is not a reason to log card data on purpose.</p>
            <Link to="/docs/logging">Logging and redaction <IconArrow /></Link>
          </div>
        </div>
      </section>

      <section className="cta">
        <h2>Start with one endpoint</h2>
        <p>A running service, its API documentation and the monitor console in a few minutes.</p>
        <div className="hero-actions">
          <Link to="/docs/quick-start" className="btn btn-primary">Quick start <IconArrow /></Link>
          <Link to="/docs/introduction" className="btn">Read the introduction</Link>
        </div>
      </section>
    </main>
  );
}

function Install() {
  const cmd = `npm install ${site.pkg}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { /* clipboard blocked */ }
  };
  return (
    <div className="install">
      <span className="install-prompt">$</span>
      <code>{cmd}</code>
      <button onClick={copy} aria-label="Copy install command">{copied ? <IconCheck /> : <IconCopy />}</button>
    </div>
  );
}
