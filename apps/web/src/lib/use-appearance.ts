import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const eventName = "wooble:appearance";
function storedTheme(): Theme {
  const stored = localStorage.getItem("wooble-theme");
  return stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
}
export function useAppearance() {
  const [theme, setThemeState] = useState<Theme>(storedTheme);
  useEffect(() => {
    const sync = () => setThemeState(storedTheme());
    window.addEventListener(eventName, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(eventName, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const setTheme = (next: Theme) => {
    localStorage.setItem("wooble-theme", next);
    window.dispatchEvent(new Event(eventName));
  };
  return { theme, setTheme };
}
