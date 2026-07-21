import { useEffect, useState } from "react";

type Theme = "dark" | "light";

/** Two themes, one switch. The choice survives a reload. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("laneyard-theme") as Theme | null) ?? "dark",
  );

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    localStorage.setItem("laneyard-theme", theme);
  }, [theme]);

  return (
    <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
      {theme === "dark" ? "paper" : "dark"}
    </button>
  );
}
