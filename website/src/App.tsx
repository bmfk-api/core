import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { Home } from "./pages/Home";
import { DocsLayout } from "./components/DocsLayout";
import { DocPage } from "./pages/DocPage";
import { NotFound } from "./pages/NotFound";

export function App() {
  const { pathname, hash } = useLocation();
  // New page → top; a #hash is scrolled to by the page once its content has rendered.
  useEffect(() => { if (!hash) window.scrollTo(0, 0); }, [pathname, hash]);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Header />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/docs" element={<Navigate to="/docs/introduction" replace />} />
        <Route path="/docs/:slug" element={<DocsLayout><DocPage /></DocsLayout>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Footer />
    </>
  );
}
