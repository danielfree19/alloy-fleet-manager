import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// Basename matters because the UI is served under /ui/ in production.
// Vite sets import.meta.env.BASE_URL to "/ui/" (from vite.config.ts), so we
// reuse it to keep the React Router tree aligned with the asset paths.
const basename = import.meta.env.BASE_URL.replace(/\/$/, "");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
