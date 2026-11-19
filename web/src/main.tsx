import { createRoot } from "react-dom/client";
import "@fontsource/bebas-neue/latin.css";
import "@fontsource-variable/nunito-sans/wght.css";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);

if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
