import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/noto-sans-sc";
import "./index.css";

// A rebuild deletes the old hashed chunks, so a tab opened before it fails to load lazy parts
// (the note editor) and the whole page goes blank. Reload once to pick up the new build.
window.addEventListener("vite:preloadError", (event) => {
  const key = "learning-map:chunk-reload";
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch { /* storage blocked: still reload once */ }
  event.preventDefault();
  window.location.reload();
});
// Clear the guard only after the page has stayed up a while, so a chunk that is still missing cannot loop reloads.
setTimeout(() => { try { sessionStorage.removeItem("learning-map:chunk-reload"); } catch { /* ignore */ } }, 10000);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
