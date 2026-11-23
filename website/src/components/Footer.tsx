import { Link } from "react-router-dom";
import { site } from "../site";

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div>
          <div className="footer-brand">{site.name}</div>
          <div className="muted">{site.fullName} · MIT license</div>
        </div>
        <nav className="footer-links" aria-label="Footer">
          <Link to="/docs/quick-start">Quick start</Link>
          <Link to="/docs/options">Options</Link>
          <Link to="/docs/security">Security model</Link>
          <Link to="/docs/pci-dss">PCI DSS mapping</Link>
        </nav>
      </div>
    </footer>
  );
}
