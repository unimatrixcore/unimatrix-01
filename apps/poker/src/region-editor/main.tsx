import { createRoot } from "react-dom/client";
import { installLabTransport } from "../lib/native-transport.js";
import { RegionEditor } from "./editor.js";
import "./editor.css";
const root = document.getElementById("region-editor-root");
if (!root) throw new Error("Missing region editor root.");
installLabTransport();
createRoot(root).render(<RegionEditor />);
