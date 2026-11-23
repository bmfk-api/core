import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { site } from "../site";
import { Logo, IconSearch } from "./icons";
import { ThemeToggle } from "./ThemeToggle";
import { SearchDialog } from "./SearchDialog";

export function Header() {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen(o => !o); }
      else if (e.key === "/" && !/^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="brand" aria-label={`${site.name} home`}>
          <Logo />
          <span className="brand-name">{site.name}</span>
          <span className="brand-version">{site.version}</span>
        </Link>
        <nav className="header-nav" aria-label="Main">
          <NavLink to="/docs/introduction" className={({ isActive }) => isActive ? "active" : ""}>Docs</NavLink>
          <NavLink to="/docs/deployer">Deploy</NavLink>
          <NavLink to="/docs/security">Security</NavLink>
          <NavLink to="/docs/pci-dss">PCI DSS</NavLink>
        </nav>
        <div className="header-actions">
          <button className="search-btn" onClick={() => setSearchOpen(true)} aria-label="Search the docs">
            <IconSearch />
            <span className="search-btn-label">Search docs</span>
            <kbd>{mac ? "⌘" : "Ctrl"} K</kbd>
          </button>
          <ThemeToggle />
        </div>
      </div>
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
    </header>
  );
}
