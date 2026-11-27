// Build-time only (scripts/prerender.mjs): renders each page to HTML so it can be read without JavaScript.
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { App } from "./App";
import { docs, loadDoc } from "./docs/nav";
import { site } from "./site";

export interface Page { path: string, title: string, description: string, csp?: string }

// The config generator makes keys and hashes passwords: its page may not connect anywhere.
const NO_CONNECTIONS = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";

export const pages: Page[] = [
  { path: "/", title: `${site.name} — ${site.fullName}`, description: "" },
  ...docs.map(d => ({ path: `/docs/${d.slug}`, title: `${d.title} — ${site.name}`, description: d.description })),
  { path: "/configure", title: `Config generator — ${site.name}`, csp: NO_CONNECTIONS,
    description: "Project configs, deploy keys, the deployer's setup.json and access files — made in the browser, ready to paste on the server." },
];

export const notFound: Page = { path: "/404", title: `Page not found — ${site.name}`, description: "" };

export { site };

export async function render(path: string): Promise<string> {
  const slug = path.match(/^\/docs\/([^/]+)$/)?.[1];
  if (slug) await loadDoc(slug);
  return renderToString(<StaticRouter location={path}><App /></StaticRouter>);
}
