(() => {
  const storageKey = "portfel-gpw-theme";
  const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  let preference;
  try { preference = localStorage.getItem(storageKey); } catch {}
  if (!["light", "dark"].includes(preference)) preference = null;

  function applyTheme() {
    const dark = preference ? preference === "dark" : Boolean(systemTheme?.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const button = document.querySelector("#theme-toggle");
    const label = dark ? "Włącz jasny motyw" : "Włącz ciemny motyw";
    button?.setAttribute("aria-label", label);
    button?.setAttribute("title", label);
  }

  // Apply before styles load to avoid a flash of the wrong theme.
  applyTheme();
  function initializeToggle() {
    applyTheme();
    document.querySelector("#theme-toggle")?.addEventListener("click", () => {
      preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(storageKey, preference); } catch {}
      applyTheme();
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeToggle, { once: true });
  } else {
    initializeToggle();
  }
  if (systemTheme?.addEventListener) systemTheme.addEventListener("change", applyTheme);
  else systemTheme?.addListener?.(applyTheme);
})();
