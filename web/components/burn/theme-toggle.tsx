"use client";

import { useEffect, useState } from "react";

// Dark is the default; the choice persists per browser.
export function ThemeToggle() {
  const [light, setLight] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("burn-theme") === "light";
    setLight(saved);
    document.documentElement.classList.toggle("dark", !saved);
  }, []);

  const flip = () => {
    const next = !light;
    setLight(next);
    document.documentElement.classList.toggle("dark", !next);
    localStorage.setItem("burn-theme", next ? "light" : "dark");
  };

  return (
    <button
      type="button"
      onClick={flip}
      aria-label={light ? "Switch to dark theme" : "Switch to light theme"}
      className="rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
    >
      {light ? "dark" : "light"}
    </button>
  );
}
