import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/global.css";
import { App } from "./App";
import { loadDoc } from "./docs/nav";

const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </StrictMode>
);

// A prerendered page is hydrated once its document is loaded, so the first pass matches the HTML.
if (root.hasChildNodes()) {
  const slug = location.pathname.match(/^\/docs\/([^/]+)\/?$/)?.[1];
  Promise.resolve(slug && loadDoc(slug)).catch(() => {}).then(() => hydrateRoot(root, app));
} else {
  createRoot(root).render(app);
}
