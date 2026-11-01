import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initialThemeGuess } from "./api/window";
import "./styles.css";

// Set a theme before first paint to avoid a light/dark flash; useTheme refines it.
document.documentElement.dataset.theme = initialThemeGuess();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
