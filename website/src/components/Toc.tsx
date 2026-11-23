import { useEffect, useState } from "react";

interface Heading { id: string, text: string, level: number }

// Built from the rendered article (ids come from rehype-slug); highlights the section in view.
export function Toc({ articleKey }: { articleKey: string }) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState("");

  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".prose h2[id], .prose h3[id]"));
    setHeadings(els.map(el => ({ id: el.id, text: el.textContent ?? "", level: el.tagName === "H2" ? 2 : 3 })));
    if (els.length === 0) return;
    const io = new IntersectionObserver(entries => {
      const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: "-72px 0px -70% 0px" });
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [articleKey]);

  if (headings.length < 2) return <aside className="toc" />;
  return (
    <aside className="toc" aria-label="On this page">
      <div className="toc-title">On this page</div>
      <ul>
        {headings.map(h => (
          <li key={h.id} className={(h.level === 3 ? "toc-sub " : "") + (active === h.id ? "active" : "")}>
            <a href={"#" + h.id}>{h.text}</a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
