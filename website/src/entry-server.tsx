// Build-time only (scripts/prerender.mjs): renders each page to HTML so it can be read without JavaScript.
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { App } from "./App";
import { docs, loadDoc } from "./docs/nav";
import { site } from "./site";

export interface Page { path: string, title: string, description: string }

export const pages: Page[] = [
  { path: "/", title: `${site.name} — ${site.fullName}`, description: "" },
  ...docs.map(d => ({ path: `/docs/${d.slug}`, title: `${d.title} — ${site.name}`, description: d.description })),
];

export const notFound: Page = { path: "/404", title: `Page not found — ${site.name}`, description: "" };

export { site };

export async function render(path: string): Promise<string> {
  const slug = path.match(/^\/docs\/([^/]+)$/)?.[1];
  if (slug) await loadDoc(slug);
  return renderToString(<StaticRouter location={path}><App /></StaticRouter>);
}
