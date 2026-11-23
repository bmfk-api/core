import { useEffect, useState, type ComponentType } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { docs, groups, loadDoc } from "../docs/nav";
import { mdxComponents } from "../components/mdx";
import { Toc } from "../components/Toc";
import { NotFound } from "./NotFound";
import { site } from "../site";

export function DocPage() {
  const { slug = "" } = useParams();
  const { hash } = useLocation();
  const [Content, setContent] = useState<{ slug: string, C: ComponentType<any> } | null>(null);

  const index = docs.findIndex(d => d.slug === slug);
  const doc = docs[index];
  const group = groups.find(g => g.items.some(d => d.slug === slug));

  useEffect(() => {
    let alive = true;
    loadDoc(slug)?.then(m => { if (alive) setContent({ slug, C: m.default }); });
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    if (doc) document.title = `${doc.title} — ${site.name}`;
  }, [doc]);

  // Scroll to the #heading once the page is rendered (links from search and other pages).
  useEffect(() => {
    if (!Content || Content.slug !== slug || !hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    el?.scrollIntoView();
  }, [Content, slug, hash]);

  if (!doc) return <NotFound />;
  const prev = docs[index - 1], next = docs[index + 1];
  const ready = Content && Content.slug === slug;

  return (
    <>
      <main id="main" className="doc">
        <div className="doc-group">{group?.title}</div>
        <h1 className="doc-title">{doc.title}</h1>
        <p className="doc-lead">{doc.description}</p>
        <article className="prose">
          {ready ? <Content.C components={mdxComponents} /> : <div className="doc-loading" aria-busy="true" />}
        </article>
        <nav className="pager" aria-label="Pages">
          {prev ? <Link to={`/docs/${prev.slug}`} className="pager-link"><span>Previous</span>{prev.title}</Link> : <span />}
          {next ? <Link to={`/docs/${next.slug}`} className="pager-link next"><span>Next</span>{next.title}</Link> : <span />}
        </nav>
      </main>
      {ready ? <Toc articleKey={slug} /> : <aside className="toc" />}
    </>
  );
}
