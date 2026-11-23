import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { Overview } from "./Overview";
import "./styles.css";
import "./workspace.css";

const root = document.getElementById("root");
const App = lazy(() => import("./App").then(({ App }) => ({ default: App })));

if (!root) {
  throw new Error("Missing #root element");
}

const { pathname, search } = window.location;
const openWorkspace = pathname.replace(/\/+$/, "") === "/workspace" || new URLSearchParams(search).has("role");

if (openWorkspace) document.title = "AIVORA Workspace";

createRoot(root).render(
  <StrictMode>
    {openWorkspace ? (
      <Suspense fallback={<main className="login-wrap"><p role="status">Opening AIVORA…</p></main>}>
        <App />
      </Suspense>
    ) : <Overview />}
  </StrictMode>,
);
