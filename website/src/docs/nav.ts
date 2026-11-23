import type { ComponentType } from "react";

export interface DocEntry { slug: string, title: string, description: string }
export interface DocGroup { title: string, items: DocEntry[] }

// Sidebar order. Every slug is a file in this folder: <slug>.mdx.
export const groups: DocGroup[] = [
  { title: "Getting started", items: [
    { slug: "introduction", title: "Introduction", description: "What the framework is, what it includes and how the parts fit together." },
    { slug: "quick-start", title: "Quick start", description: "A running service with one endpoint in a few minutes." },
  ] },
  { title: "Building APIs", items: [
    { slug: "endpoints", title: "Endpoints", description: "Endpoint classes, handlers, per-method routing and per-endpoint flags." },
    { slug: "validation", title: "Validation models", description: "Request validation from sample objects, with inferred TypeScript types." },
    { slug: "interceptors", title: "Interceptors", description: "Authentication for your endpoints, including Ed25519-signed server-to-server requests." },
    { slug: "api-documentation", title: "API documentation", description: "Interactive documentation generated from your endpoints, with per-user access." },
    { slug: "websocket", title: "WebSocket server", description: "WebSockets on the HTTP port with authorization, origin checks and limits." },
  ] },
  { title: "Services", items: [
    { slug: "http-client", title: "Outgoing HTTP", description: "A pooled HTTP client that never throws and reports latency per host." },
    { slug: "microservices", title: "Microservice calls", description: "Signed calls between services: per-caller keys, signed answers, operations that run once." },
    { slug: "logging", title: "Logging and redaction", description: "Logs with card data and secrets masked at write time." },
    { slug: "signals", title: "Signals and requests", description: "How services notify and ask each other without importing each other." },
  ] },
  { title: "Operations", items: [
    { slug: "monitor", title: "Monitor console", description: "Metrics, logs, threats and restarts behind mandatory 2FA." },
    { slug: "authentication", title: "Authentication", description: "How each built-in console signs users in, and how to manage them." },
    { slug: "ip-blocking", title: "IP blocking", description: "Blocking addresses and subnets before any request processing." },
  ] },
  { title: "Deployment", items: [
    { slug: "deployer", title: "Deployer and CLI", description: "Signed deploys, project configs, secrets files, bundling and the CLI." },
    { slug: "blue-green", title: "Blue-green", description: "Zero-downtime releases and rollbacks in seconds." },
    { slug: "backups", title: "Backups and restore", description: "Complete copies before every deploy, restored atomically." },
    { slug: "deploy-review", title: "Deploy review", description: "Four-eyes approval with a diff before anything reaches production." },
  ] },
  { title: "Reference", items: [
    { slug: "options", title: "Options", description: "Every APIService option with its default." },
    { slug: "security", title: "Security model", description: "What you get by default, what you must configure, and what is out of scope." },
    { slug: "pci-dss", title: "PCI DSS mapping", description: "Which PCI DSS v4.0.1 requirements the framework helps with, and what stays with you." },
  ] },
];

export const docs: DocEntry[] = groups.flatMap(g => g.items);

const modules = import.meta.glob<{ default: ComponentType<any> }>("./*.mdx");
const raw = import.meta.glob<string>("./*.mdx", { query: "?raw", import: "default", eager: true });

export function loadDoc(slug: string) {
  return modules[`./${slug}.mdx`]?.();
}

export function rawDoc(slug: string): string {
  return raw[`./${slug}.mdx`] ?? "";
}
