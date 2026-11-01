import { useEffect, useState } from "react";
import type { ThemePref } from "../api/s3";
import { applyWindowTheme, getOsTheme, onOsThemeChanged, type Theme } from "../api/window";

/**
 * Resolves the theme preference to "light" | "dark" and applies it to the page
 * (data-theme on <html>) and the native window. "system" follows the OS live;
 * if the OS can't report a theme, dark is used.
 */
export function useTheme(pref: ThemePref): Theme {
  const [osTheme, setOsTheme] = useState<Theme | null>(null);

  useEffect(() => onOsThemeChanged(setOsTheme), []);

  useEffect(() => {
    let stale = false;
    void (async () => {
      await applyWindowTheme(pref);
      // Read after un-forcing the window theme, so we get the OS value.
      if (pref === "system") {
        const t = await getOsTheme();
        if (!stale) setOsTheme(t);
      }
    })();
    return () => {
      stale = true;
    };
  }, [pref]);

  const resolved: Theme = pref === "system" ? (osTheme ?? "dark") : pref;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  return resolved;
}
