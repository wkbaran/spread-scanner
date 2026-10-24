// Palette switcher (the swatch button in the lower left). The same control as equity-watch's web/palette.js,
// with its own storage key and its own six presets, so the two apps share a control but not a look.
//
// The page's stylesheet reads exactly three custom properties off <html>:
// --p-ground (the background in dark mode), --p-ink (the text in dark mode)
// and --p-signal (the one accent). Every other colour is mixed from those
// three, and light mode swaps ground and ink, so a palette is a complete theme.
//
// index.html declares the default with data-palette="ground,ink,signal" on
// <html>. A chosen palette is remembered per browser. Loaded in <head>, before
// first paint, so the page never flashes another palette.

(() => {
  "use strict";
  const KEY = "spread-scanner.palette";
  const root = document.documentElement;

  const PRESETS = [
    { name: "Slate and lime", colors: ["#1b2229", "#e8edf0", "#9bcf2e"] },
    { name: "Plum and peach", colors: ["#251428", "#f1e4ec", "#ff9f72"] },
    { name: "Pine and rose", colors: ["#10261f", "#e6efe3", "#ff7fa8"] },
    { name: "Olive and orchid", colors: ["#1e2016", "#ecebdc", "#d68cff"] },
    { name: "Denim and tangerine", colors: ["#172a45", "#e9eef5", "#ff9a3c"] },
    { name: "Cocoa and mint", colors: ["#2a1714", "#f3e7e1", "#2fd197"] },
  ];

  const pageDefault = (root.dataset.palette ?? "").split(",").filter(Boolean);
  const defaults = pageDefault.length === 3 ? pageDefault : PRESETS[0].colors;

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
      if (Array.isArray(saved) && saved.length === 3) return saved;
    } catch {
      /* fall through to the default */
    }
    return defaults;
  }

  function apply(colors) {
    const [ground, ink, signal] = colors;
    root.style.setProperty("--p-ground", ground);
    root.style.setProperty("--p-ink", ink);
    root.style.setProperty("--p-signal", signal);
  }

  function save(colors) {
    try {
      localStorage.setItem(KEY, JSON.stringify(colors));
    } catch {
      /* the choice just won't persist */
    }
  }

  // Before first paint, so the page never flashes another palette.
  let colors = read();
  apply(colors);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  }

  function buildPanel() {
    const inputs = ["Background", "Text", "Accent"].map((label, i) => {
      const id = `pal-${i}`;
      const input = el("input", { type: "color", id, value: colors[i] });
      input.addEventListener("input", () => {
        colors = colors.map((c, j) => (j === i ? input.value : c));
        apply(colors);
        save(colors);
        code.textContent = colors.join(", ");
      });
      return { input, row: el("div", { class: "pal-field" }, input, el("label", { for: id, text: label })) };
    });
    const sync = () => inputs.forEach(({ input }, i) => (input.value = colors[i]));
    const code = el("code", { class: "pal-code", text: colors.join(", ") });

    const presets = el(
      "div",
      { class: "pal-presets" },
      ...PRESETS.map((p) =>
        el(
          "button",
          {
            type: "button",
            class: "pal-preset",
            title: p.name,
            "aria-label": `Use ${p.name}`,
            onclick: () => {
              colors = [...p.colors];
              apply(colors);
              save(colors);
              sync();
              code.textContent = colors.join(", ");
            },
          },
          ...p.colors.map((c) => el("span", { style: `background:${c}` }))
        )
      )
    );

    const reset = el("button", {
      type: "button",
      text: "Reset to this design's default",
      class: "pal-reset",
      onclick: () => {
        colors = [...defaults];
        apply(colors);
        try {
          localStorage.removeItem(KEY);
        } catch {
          /* nothing saved */
        }
        sync();
        code.textContent = colors.join(", ");
      },
    });

    const panel = el(
      "div",
      { class: "pal-panel", id: "pal-panel", role: "dialog", "aria-label": "Palette", hidden: "" },
      el("div", { class: "pal-heading", text: "Palette" }),
      presets,
      ...inputs.map((x) => x.row),
      code,
      reset
    );
    const toggle = el("button", {
      type: "button",
      class: "pal-toggle",
      "aria-expanded": "false",
      "aria-controls": "pal-panel",
      "aria-label": "Palette",
      onclick: () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute("aria-expanded", String(!panel.hidden));
      },
    });
    toggle.append(...[0, 1, 2].map((i) => el("span", { style: `background:var(--p-${["ground", "ink", "signal"][i]})` })));
    const box = el("div", { class: "pal" }, panel, toggle);
    const close = () => {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.hidden) close();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!panel.hidden && !box.contains(e.target)) close();
    });
    document.body.append(box);
  }

  document.addEventListener("DOMContentLoaded", buildPanel);
})();
