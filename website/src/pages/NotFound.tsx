import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <main id="main" className="notfound">
      <div className="notfound-code">404</div>
      <h1>This page doesn’t exist</h1>
      <p className="muted">It may have moved when the docs were reorganized.</p>
      <div className="hero-actions">
        <Link to="/docs/introduction" className="btn btn-primary">Open the docs</Link>
        <Link to="/" className="btn">Home</Link>
      </div>
    </main>
  );
}
