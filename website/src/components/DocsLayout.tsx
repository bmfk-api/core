import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { groups } from "../docs/nav";
import { IconClose, IconMenu } from "./icons";

export function DocsLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="docs">
      <button className="sidebar-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls="sidebar">
        {open ? <IconClose /> : <IconMenu />} Menu
      </button>
      <aside id="sidebar" className={"sidebar" + (open ? " open" : "")} aria-label="Documentation">
        <nav>
          {groups.map(g => (
            <div className="sidebar-group" key={g.title}>
              <div className="sidebar-title">{g.title}</div>
              <ul>
                {g.items.map(d => (
                  <li key={d.slug}>
                    <NavLink to={`/docs/${d.slug}`} className={({ isActive }) => isActive ? "active" : ""}>{d.title}</NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      {children}
    </div>
  );
}
