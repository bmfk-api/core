import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { search } from "../lib/search";
import { IconSearch } from "./icons";

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const results = useMemo(() => search(q), [q]);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const go = (i: number) => {
    const r = results[i];
    if (!r) return;
    navigate(`/docs/${r.s.slug}${r.s.anchor ? "#" + r.s.anchor : ""}`);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") go(active);
  };

  return (
    <div className="search-overlay" onMouseDown={onClose}>
      <div className="search-dialog" role="dialog" aria-modal="true" aria-label="Search the docs" onMouseDown={e => e.stopPropagation()} onKeyDown={onKey}>
        <div className="search-input">
          <IconSearch />
          <input ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder="Search: signing keys, blue-green, 2FA…" aria-label="Search" />
          <kbd onClick={onClose}>Esc</kbd>
        </div>
        <ul className="search-results" role="listbox">
          {q.trim().length >= 2 && results.length === 0 && <li className="search-empty">Nothing found for “{q}”.</li>}
          {results.map((r, i) => (
            <li key={r.s.slug + r.s.anchor + i} role="option" aria-selected={i === active}
                className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => go(i)}>
              <div className="search-path">{r.s.page}{r.s.anchor && <> <span>›</span> {r.s.heading}</>}</div>
              <div className="search-snippet">{r.snippet}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
