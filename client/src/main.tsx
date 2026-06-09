import "./hljs-setup";
import "highlight.js/styles/github-dark.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./global.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register service worker for PWA (skip in Electron — custom protocol conflicts with SW)
if ("serviceWorker" in navigator && !import.meta.env.VITE_ELECTRON) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(e => console.error(e));
  });
}