// The report page: reads the scan embedded in index.html and draws it. Filtering, scoring and
// sorting live in model.js, which has tests; this file is the DOM.
(() => {
  "use strict";
  const M = globalThis.SpreadModel;
  const $ = (id) => document.getElementById(id);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "style") node.setAttribute("style", value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }

  // ---- the scan --------------------------------------------------------------------------
  let scan;
  try {
    scan = JSON.parse($("scan-data").textContent);
  } catch {
    $("scan-meta").textContent = "This page has no scan in it. Make one with: node src/cli.ts report";
    return;
  }
  const VIEW_KEY = "spread-scanner.view";
  const WEIGHT_LABELS = {
    ivPercentile: "IV percentile",
    ivOverHv: "IV over realised vol",
    returnOnRisk: "Return on risk",
    pop: "Chance of profit",
    legSpread: "Tight bid-ask",
    distance: "Distance from the stock",
  };

  const state = {
    weights: { ...scan.weights },
    filters: M.emptyFilters(),
    sortKey: "score",
    sortDir: "desc",
    open: new Set(),
  };

  // Per-viewer convenience: the filters, weights and sort the person last used. Never required.
  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
      if (!saved) return;
      if (saved.filters) Object.assign(state.filters, saved.filters);
      if (saved.weights && M.WEIGHT_KEYS.every((k) => typeof saved.weights[k] === "number")) state.weights = saved.weights;
      if (saved.sortKey && M.SORTS[saved.sortKey]) {
        state.sortKey = saved.sortKey;
        state.sortDir = saved.sortDir === "asc" ? "asc" : "desc";
      }
    } catch {
      /* storage unavailable or damaged: start from the defaults */
    }
  }
  function persist() {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ filters: state.filters, weights: state.weights, sortKey: state.sortKey, sortDir: state.sortDir }));
    } catch {
      /* the choice just will not be remembered */
    }
  }

  // ---- formatting ------------------------------------------------------------------------
  const num = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? "–" : n.toFixed(d));
  const pct = (n, d = 0) => (n === null || n === undefined ? "–" : `${n.toFixed(d)}%`);
  const frac = (n, d = 0) => (n === null || n === undefined ? "–" : `${(n * 100).toFixed(d)}%`);
  const money = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
  const strike = (n) => String(Math.round(n * 1000) / 1000);
  const width = (n) => `$${strike(n)}`;

  // ---- the scan's header and counts ------------------------------------------------------
  // The zone the scan was configured to show times in (config display.timeZone). Scans saved before
  // that setting existed carry none, and are shown in the default zone, Mountain.
  function displayZone() {
    const zone = scan.config && scan.config.display && scan.config.display.timeZone;
    return zone || "America/Denver";
  }

  function renderHeader() {
    const when = new Date(scan.generatedAt);
    const stamp = new Intl.DateTimeFormat("en-US", { timeZone: displayZone(), weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(when);
    const hours = (Date.now() - when.getTime()) / 3_600_000;
    const age = hours < 1 ? "less than an hour ago" : hours < 36 ? `${Math.round(hours)} hours ago` : `${Math.round(hours / 24)} days ago`;
    const stale = hours > 6;
    $("scan-meta").textContent = `Scanned ${stamp}, ${age}. ${stale ? "Prices are from the scan, not live." : ""}`.trim();
    $("scan-meta").classList.toggle("stale", stale);
    $("count-universe").textContent = String(scan.universe);
    $("count-names").textContent = String(Object.keys(scan.symbols).length);
  }

  // ---- the filters -----------------------------------------------------------------------
  const numberFields = [
    ["f-ror", "minReturn"],
    ["f-pop", "minPop"],
    ["f-ivp", "minIvPercentile"],
    ["f-ivhv", "minIvOverHv"],
    ["f-slip", "maxSlippage"],
    ["f-leg", "maxLegSpread"],
  ];
  const allWidths = M.distinctWidths(scan.candidates);

  function buildFilters() {
    $("f-widths").replaceChildren(
      ...allWidths.map((w) => {
        const input = el("input", { type: "checkbox", value: String(w), "aria-label": `${width(w)} wide` });
        input.addEventListener("change", () => {
          const on = [...$("f-widths").querySelectorAll("input:checked")].map((i) => Number(i.value));
          state.filters.widths = on.length === allWidths.length ? null : on;
          update();
        });
        return el("label", { class: "chip" }, input, el("span", { text: width(w) }));
      }),
    );
    const exp = $("f-exp");
    exp.replaceChildren(el("option", { value: "all", text: "All expirations" }), ...M.distinctExpirations(scan.candidates).map((e) => el("option", { value: e.date, text: `${M.shortDate(e.date)}, ${e.dte} days` })));
    exp.addEventListener("change", () => { state.filters.expiration = exp.value; update(); });

    for (const id of ["f-put", "f-call"]) $(id).addEventListener("change", () => { state.filters[id === "f-put" ? "put" : "call"] = $(id).checked; update(); });
    $("f-kind").addEventListener("change", () => { state.filters.kind = $("f-kind").value; update(); });
    $("f-per").addEventListener("change", () => { state.filters.perUnderlying = Number($("f-per").value); update(); });
    $("f-search").addEventListener("input", () => { state.filters.search = $("f-search").value; update(); });
    for (const [id, key] of numberFields) {
      $(id).addEventListener("input", () => {
        const v = $(id).value.trim();
        state.filters[key] = v === "" ? null : Number(v);
        update();
      });
    }
    $("w-five").addEventListener("click", () => { state.filters.widths = allWidths.filter((w) => w === 5); syncFilters(); update(); });
    $("w-all").addEventListener("click", () => { state.filters.widths = null; syncFilters(); update(); });
    const reset = () => {
      const keep = state.filters.perUnderlying;
      state.filters = M.emptyFilters();
      state.filters.perUnderlying = keep;
      syncFilters();
      update();
    };
    $("f-reset").addEventListener("click", reset);
    $("empty-reset").addEventListener("click", reset);
  }

  /** Puts the controls in line with `state.filters`, after a restore or a reset. */
  function syncFilters() {
    const f = state.filters;
    $("f-put").checked = f.put;
    $("f-call").checked = f.call;
    $("f-kind").value = f.kind;
    $("f-per").value = String(f.perUnderlying);
    $("f-search").value = f.search;
    $("f-exp").value = [...$("f-exp").options].some((o) => o.value === f.expiration) ? f.expiration : "all";
    if ($("f-exp").value !== f.expiration) f.expiration = "all";
    for (const input of $("f-widths").querySelectorAll("input")) input.checked = f.widths === null || f.widths.includes(Number(input.value));
    for (const [id, key] of numberFields) $(id).value = f[key] === null ? "" : String(f[key]);
  }

  // ---- the weights -----------------------------------------------------------------------
  function buildWeights() {
    const total = () => M.WEIGHT_KEYS.reduce((a, k) => a + state.weights[k], 0);
    $("weights").replaceChildren(
      ...M.WEIGHT_KEYS.map((key) => {
        const out = el("output", { id: `wo-${key}` });
        const input = el("input", { type: "range", id: `w-${key}`, min: "0", max: "100", step: "5", "aria-label": `${WEIGHT_LABELS[key]} weight` });
        input.addEventListener("input", () => {
          state.weights[key] = Number(input.value);
          for (const k of M.WEIGHT_KEYS) $(`wo-${k}`).textContent = total() === 0 ? "0%" : `${Math.round((state.weights[k] / total()) * 100)}%`;
          update();
        });
        return el("div", { class: "weight" }, el("label", { for: `w-${key}`, text: WEIGHT_LABELS[key] }), out, input);
      }),
    );
    $("w-reset").addEventListener("click", () => { state.weights = { ...scan.weights }; syncWeights(); update(); });
  }

  /** The sliders run 0 to 100; the scan's weights are relative, so scale them to fit. */
  function syncWeights() {
    const max = Math.max(...M.WEIGHT_KEYS.map((k) => state.weights[k]), 1e-9);
    const scale = max <= 1 ? 100 : 1;
    const total = M.WEIGHT_KEYS.reduce((a, k) => a + state.weights[k], 0);
    for (const key of M.WEIGHT_KEYS) {
      const slider = $(`w-${key}`);
      slider.value = String(Math.round(state.weights[key] * scale));
      $(`wo-${key}`).textContent = total === 0 ? "0%" : `${Math.round((state.weights[key] / total) * 100)}%`;
    }
    if (scale === 100) for (const key of M.WEIGHT_KEYS) state.weights[key] = Math.round(state.weights[key] * 100);
  }

  // ---- the table -------------------------------------------------------------------------
  const COLUMNS = [
    { key: "symbol", label: "Symbol", left: true },
    { key: "expiration", label: "Spread", left: true },
    // Order is priority: a table wider than its room scrolls sideways, so what decides a trade comes first
    // and the strike ruler, the widest cell, follows the numbers.
    { key: "returnOnRisk", label: "Return on risk", short: "Return", hint: "The credit at the mid price over the most you can lose" },
    { key: "pop", label: "Chance of profit", short: "PoP", hint: "The chance the spread finishes at a profit at expiration, read from the options' delta at the break-even" },
    { key: "ivPercentile", label: "IV percentile", short: "IV pctl", hint: "The share of the past year that implied volatility was lower than it is now" },
    { key: "distance", label: "Strikes against the stock", short: "Strikes", ruler: true, hint: "Sorts by how many expected moves the short strike is from the stock" },
    { key: "credit", label: "Credit", hint: "The credit at the mid price. Under it, the most you can lose" },
    { key: "ivRank", label: "IV rank", hint: "Where implied volatility sits between its low and its high of the past year" },
    { key: "ivOverHv", label: "IV over realised", hint: "Implied volatility over the average of the 30, 60 and 90 day realised volatility. Above 1 the options cost more than the stock has been moving" },
    { key: "slippage", label: "Slippage", hint: "How much less credit you get trading at the worst prices, selling the short leg at the bid and buying the long leg at the ask, than at the mid" },
    { key: "score", label: "Score", hint: "The weighted average of the component ranks. The weights are in the rail" },
  ];

  function buildHead() {
    $("head").replaceChildren(
      ...COLUMNS.map((col) => {
        const button = col.short ? el("button", { type: "button" }, el("span", { class: "long", text: col.label }), el("span", { class: "short", text: col.short })) : el("button", { type: "button", text: col.label });
        button.addEventListener("click", () => {
          if (state.sortKey === col.key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
          else {
            state.sortKey = col.key;
            state.sortDir = M.defaultDirection(col.key);
          }
          update();
        });
        return el("th", { class: `${col.left ? "left" : ""} ${col.ruler ? "col-ruler" : ""}`.trim(), scope: "col", "data-key": col.key, title: col.hint }, button);
      }),
    );
  }

  const SVG = "http://www.w3.org/2000/svg";
  function svg(tag, attrs) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  /** The strike ruler: the stock at the middle, its one-expected-move band, the bar between the strikes. */
  function rulerSvg(candidate, info) {
    const r = M.ruler(candidate, info);
    if (r === null) return el("span", { class: "muted", text: "–" });
    const W = 103;
    const x = (f) => (f * W).toFixed(1);
    const text = `Short strike ${strike(candidate.spread.short.strike)} is ${r.distance.toFixed(1)} expected moves from the stock${r.clipped ? ", off the scale" : ""}`;
    const node = svg("svg", { class: "ruler", viewBox: `0 0 ${W} 28`, role: "img", "aria-label": text });
    node.append(svg("title", {}));
    node.firstChild.textContent = text;
    node.append(
      svg("line", { class: "axis", x1: 0, x2: W, y1: 14, y2: 14 }),
      svg("rect", { class: "band", x: x(r.band[0]), y: 4, width: ((r.band[1] - r.band[0]) * W).toFixed(1), height: 20 }),
      svg("line", { class: "spot", x1: x(0.5), x2: x(0.5), y1: 2, y2: 26 }),
      svg("rect", { class: "risk", x: x(Math.min(r.short, r.long)), y: 10, width: Math.max(2, Math.abs(r.short - r.long) * W).toFixed(1), height: 8 }),
      svg("line", { class: "be", x1: x(r.breakeven), x2: x(r.breakeven), y1: 3, y2: 25 }),
      svg("line", { class: "short", x1: x(r.short), x2: x(r.short), y1: 5, y2: 23 }),
    );
    // A strike past the scale is pinned to the edge; a small arrow there says it went further.
    if (r.clipped) {
      const edge = Math.max(r.short, r.long) > 0.5 ? W : 0;
      const dir = edge === 0 ? -1 : 1;
      node.append(svg("path", { class: "clip", d: `M${edge + dir * 1} 8 L${edge + dir * 6} 14 L${edge + dir * 1} 20 Z` }));
    }
    return node;
  }

  const rowKey = (c) => [c.symbol, c.spread.side, c.spread.expiration, c.spread.short.strike, c.spread.long.strike].join("|");

  function row(c) {
    const s = c.spread;
    const info = scan.symbols[c.symbol];
    const open = state.open.has(rowKey(c));
    const toggle = el("button", { type: "button", class: "sym", "aria-expanded": String(open), "aria-controls": `d-${rowKey(c)}` }, c.symbol, info.isEtf ? el("span", { class: "tag", text: "fund" }) : null);
    toggle.addEventListener("click", () => {
      const k = rowKey(c);
      if (state.open.has(k)) state.open.delete(k);
      else state.open.add(k);
      render();
    });
    const tr = el(
      "tr",
      { class: `item${open ? " open" : ""}` },
      el("td", { class: "left" }, toggle),
      el("td", { class: "left" }, el("span", { class: "two" }, el("span", { class: "strikes", text: `${strike(s.short.strike)} / ${strike(s.long.strike)} ${s.side}` }), el("small", {}, `${M.shortDate(s.expiration)}, `, el("span", { class: "days", text: `${s.dte} days, ` }), `${width(s.width)} wide`))),
      el("td", { text: pct(s.profitPct) }),
      el("td", { text: pct(s.popPct) }),
      el("td", { text: c.components.ivPercentile === null ? "–" : num(c.components.ivPercentile * 100) }),
      el("td", { class: "col-ruler" }, rulerSvg(c, info)),
      el("td", {}, el("span", { class: "two" }, s.creditMid.toFixed(2), el("small", { text: `${money(s.maxRisk)} at risk` }))),
      el("td", { text: c.components.ivRank === null || c.components.ivRank === undefined ? "–" : num(c.components.ivRank * 100) }),
      el("td", { text: c.components.ivOverHv === null ? "–" : c.components.ivOverHv.toFixed(2) }),
      el("td", { text: pct(s.slippagePct) }),
      el("td", {}, el("span", { class: "score" }, el("b", { text: String(Math.round(c.score * 100)) }), el("i", { style: `--w:${Math.round(c.score * 100)}%` }))),
    );
    if (!open) return [tr];
    const detail = el("tr", { class: "detail", id: `d-${rowKey(c)}` }, el("td", { colspan: String(COLUMNS.length) }, detailBlock(c, info)));
    return [tr, detail];
  }

  const bidAsk = (q) => (q.bid > 0 ? (((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100).toFixed(0) + "%" : "–");

  function detailBlock(c, info) {
    const s = c.spread;
    const r = M.ruler(c, info);
    // Per share, and signed as quoted: a put's delta is negative. The net line is the leg bought minus the leg sold.
    const GREEK_DIGITS = { delta: 3, gamma: 4, theta: 3, vega: 3, rho: 3 };
    const greek = (v, g) => (v === null || v === undefined ? "–" : v.toFixed(GREEK_DIGITS[g]));
    const leg = (label, q) =>
      el("tr", {}, el("td", { text: `${label} ${strike(q.strike)}` }), el("td", { text: q.bid.toFixed(2) }), el("td", { text: q.ask.toFixed(2) }), el("td", { class: "leg-opt", text: ((q.bid + q.ask) / 2).toFixed(2) }), el("td", { text: bidAsk(q) }), el("td", { text: q.iv ? frac(q.iv) : "–" }), ...M.GREEKS.map((g) => el("td", { class: g === "gamma" || g === "rho" ? "leg-opt" : "", text: greek(q[g], g) })), el("td", { text: q.openInterest.toLocaleString("en-US") }), el("td", { class: "leg-opt", text: q.volume.toLocaleString("en-US") }));
    const net = M.netGreeks(s);
    const netRow = el("tr", { class: "net" }, el("td", { text: "Net" }), el("td"), el("td"), el("td", { class: "leg-opt" }), el("td"), el("td"), ...M.GREEKS.map((g) => el("td", { class: g === "gamma" || g === "rho" ? "leg-opt" : "", text: net ? greek(net[g], g) : "–" })), el("td"), el("td", { class: "leg-opt" }));
    const HEADS = ["Leg", "Bid", "Ask", "Mid", "Bid-ask", "IV", "Delta", "Gamma", "Theta", "Vega", "Rho", "Open int.", "Volume"];
    const legs = el(
      "table",
      { class: "legs" },
      el("thead", {}, el("tr", {}, ...HEADS.map((h) => el("th", { text: h, class: ["Mid", "Gamma", "Rho", "Volume"].includes(h) ? "leg-opt" : "" })))),
      el("tbody", {}, leg("Sell", s.short), leg("Buy", s.long), netRow),
    );
    const facts = (pairs) => el("dl", { class: "facts" }, ...pairs.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));

    const report = info.earnings.next
      ? `${M.shortDate(info.earnings.next)}, in ${info.earnings.daysUntilNext} days${info.reportTimeOfDay && info.reportDate === info.earnings.next ? (info.reportTimeOfDay === "AMC" ? ", after the close" : info.reportTimeOfDay === "BMO" ? ", before the open" : "") : ""}`
      : info.earnings.reason;
    const hv = [info.hv30, info.hv60, info.hv90].map((v) => (v === null ? "–" : (v * 100).toFixed(0))).join(" / ");

    const why = el(
      "div",
      { class: "why" },
      ...M.WEIGHT_KEYS.map((key) => {
        const rank = c.ranks[key];
        const weight = state.weights[key];
        const on = rank !== null && weight > 0;
        return el("div", { class: on ? "" : "off" }, el("span", { text: WEIGHT_LABELS[key] }), el("output", { text: weight === 0 ? "not used" : rank === null ? "no data" : `rank ${Math.round(rank * 100)}` }), on ? el("i", { style: `--w:${Math.round(rank * 100)}%` }) : null);
      }),
    );

    const status = el("span", { class: "note", role: "status" });
    const copy = el("button", { type: "button", text: "Copy for the broker" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(M.describe(c));
        status.textContent = "Copied.";
      } catch {
        status.textContent = M.describe(c);
      }
    });

    return el(
      "div",
      { class: "detail-grid" },
      el("div", { class: "detail-legs" }, el("h3", { text: "The two legs" }), el("div", { class: "legs-wrap" }, legs), el("p", { class: "note legs-note", text: "Per share. Theta is per day, vega per point of volatility. Net is what you hold: the leg bought minus the leg sold." })),
      el("div", {}, el("h3", { text: "The spread" }), facts([
        ["Credit at the bid and ask", `${s.creditNatural.toFixed(2)}, ${pct(s.slippagePct)} less than the mid`],
        ["Break-even", s.breakeven.toFixed(2)],
        ["Short strike from the stock", r ? `${r.distance.toFixed(2)} expected moves` : "–"],
      ])),
      el("div", {}, el("h3", { text: `${c.symbol} today` }), facts([
        ["Price", info.spot.toFixed(2)],
        ["IV", frac(info.ivIndex)],
        ["Realised vol, 30 / 60 / 90 days", `${hv}%`],
        ["Where that came from", info.hvSource === "fmp bars" ? "Daily prices" : info.hvSource === "tastytrade" ? "tastytrade" : "–"],
        ["Beta", info.beta === null ? "–" : info.beta.toFixed(2)],
        ["Sector", info.sector || (info.isEtf ? "Fund" : "–")],
        ["Liquidity rating", info.liquidityRating === null ? "–" : `${info.liquidityRating} of 5`],
        ["Last report", info.earnings.last ? `${M.shortDate(info.earnings.last)}, ${info.earnings.daysSinceLast} days ago` : "–"],
        ["Next report", report],
      ])),
      el("div", {}, el("h3", { text: "Why it scores this" }), why),
      el("div", { class: "detail-actions" }, copy, status),
    );
  }

  // ---- drawing everything ----------------------------------------------------------------
  const SORT_NAMES = { score: "score", symbol: "symbol", expiration: "expiration", distance: "distance from the stock", credit: "credit", returnOnRisk: "return on risk", pop: "chance of profit", slippage: "slippage", ivPercentile: "IV percentile", ivOverHv: "IV over realised vol" };

  const DIRECTION_WORDS = { symbol: { asc: "A to Z", desc: "Z to A" }, expiration: { asc: "soonest first", desc: "latest first" } };

  /**
   * The opened row's panel is as wide as the visible table, not the whole scrollable one, so it stays in
   * view while the table is scrolled sideways. The CSS asks for the container's width, which counts the
   * vertical scrollbar, so the scrollbar's width is measured here and taken off.
   */
  function measureScrollbar() {
    const wrap = $("table-wrap");
    wrap.style.setProperty("--scrollbar", `${wrap.offsetWidth - wrap.clientWidth}px`);
  }
  new ResizeObserver(measureScrollbar).observe($("table-wrap"));

  function render() {
    const list = M.visible(scan, state.weights, state.filters, state.sortKey, state.sortDir);
    const body = $("body");
    body.replaceChildren(...list.flatMap(row));
    measureScrollbar();
    for (const th of $("head").children) {
      if (th.dataset.key === state.sortKey) th.setAttribute("aria-sort", state.sortDir === "asc" ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    }
    const names = new Set(list.map((c) => c.symbol)).size;
    $("count-shown").textContent = String(list.length);
    const per = state.filters.perUnderlying;
    $("summary").replaceChildren(
      el("strong", { text: String(list.length) }),
      ` of ${scan.candidates.length} spreads, on ${names} of ${Object.keys(scan.symbols).length} symbols${per ? `, the best ${per} of each` : ""}, ordered by ${SORT_NAMES[state.sortKey] || state.sortKey}, ${DIRECTION_WORDS[state.sortKey] ? DIRECTION_WORDS[state.sortKey][state.sortDir] : state.sortDir === "desc" ? "highest first" : "lowest first"}.`,
    );
    $("empty").hidden = list.length > 0;
    $("table-wrap").hidden = list.length === 0;
  }

  function update() {
    persist();
    render();
  }

  function renderDropped() {
    const total = scan.dropped.reduce((a, d) => a + d.symbols.length, 0);
    $("dropped").hidden = total === 0;
    $("dropped-summary").textContent = `${total} of ${scan.universe} symbols were left out, and why`;
    $("dropped-list").replaceChildren(...scan.dropped.map((d) => el("li", {}, el("b", { text: String(d.symbols.length) }), el("span", { text: d.reason }), el("span", { class: "names", text: d.symbols.join(", ") }))));
  }

  // ---- theme and layout ------------------------------------------------------------------
  function buildTheme() {
    const root = document.documentElement;
    const button = $("theme-btn");
    const label = () => (button.textContent = root.getAttribute("data-theme") === "light" ? "Dark" : "Light");
    label();
    button.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("spread-scanner.theme", next); } catch { /* not remembered */ }
      label();
    });
  }

  /** The filters sit open in the rail on a wide screen and fold behind a summary on a phone. */
  function buildControlsFold() {
    const query = matchMedia("(max-width: 860px)");
    const apply = () => { $("controls").open = !query.matches; };
    apply();
    query.addEventListener("change", apply);
  }

  restore();
  renderHeader();
  buildFilters();
  buildWeights();
  buildHead();
  buildTheme();
  buildControlsFold();
  syncFilters();
  syncWeights();
  renderDropped();
  render();
})();
