import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const root = document.getElementById("app");

if (!root) {
	throw new Error("app root not found");
}

createRoot(root).render(<App />);
