(() => {
  "use strict";

  const STORE_KEY = "registry-check:tlds";
  const BOOTSTRAP_KEY = "registry-check:rdap-bootstrap";
  const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
  const RDAP_FALLBACK = "https://rdap.org/";
  const DOH = [
    (name) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=NS`,
    (name) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=NS`,
  ];
  const REGISTER_URL = (d) => `https://www.namecheap.com/domains/registration/results/?domain=${encodeURIComponent(d)}`;
  const MAX_PARALLEL = 6;
  const TIMEOUT_MS = 10000;

  const $ = (sel, root = document) => root.querySelector(sel);
  const groups = window.TLD_GROUPS || [];
  const curated = [...new Set(groups.flatMap((g) => g.tlds.map((t) => t.tld)))];
  const defaults = [...new Set(groups.flatMap((g) => g.tlds.filter((t) => t.on).map((t) => t.tld)))];

  // ---------- storage (best effort) ----------
  const store = {
    get(key, storage = localStorage) {
      try { return JSON.parse(storage.getItem(key)); } catch { return null; }
    },
    set(key, val, storage = localStorage) {
      try { storage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
    },
  };

  // ---------- TLD selection ----------
  const saved = store.get(STORE_KEY);
  let custom = Array.isArray(saved?.custom) ? saved.custom.filter(isLabel) : [];
  let selected = new Set(Array.isArray(saved?.selected) ? saved.selected : defaults);

  function persist() {
    store.set(STORE_KEY, { selected: [...selected], custom });
  }

  function chip(tld) {
    const id = `tld-${tld}`;
    const wrap = document.createElement("span");
    wrap.className = "chip";
    wrap.innerHTML = `<input type="checkbox" id="${id}" value="${tld}"><label for="${id}">.${tld}</label>`;
    const box = wrap.querySelector("input");
    box.checked = selected.has(tld);
    box.addEventListener("change", () => {
      box.checked ? selected.add(tld) : selected.delete(tld);
      persist();
    });
    return wrap;
  }

  function renderTlds() {
    const host = $("#tld-groups");
    host.textContent = "";
    const all = [...groups];
    if (custom.length) all.push({ name: "Yours", tlds: custom.map((tld) => ({ tld })) });
    for (const g of all) {
      const row = document.createElement("div");
      row.className = "group";
      const h = document.createElement("h3");
      h.textContent = g.name;
      const list = document.createElement("div");
      list.className = "chips";
      for (const t of g.tlds) list.append(chip(t.tld));
      row.append(h, list);
      host.append(row);
    }
  }

  function renderPresets() {
    const host = $("#presets");
    const presets = [
      ["Starter set", () => new Set(defaults)],
      ["All", () => new Set([...curated, ...custom])],
      ["Just .love", () => new Set(["love"])],
      ["Clear", () => new Set()],
    ];
    for (const [label, make] of presets) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link";
      b.textContent = label;
      b.addEventListener("click", () => { selected = make(); persist(); renderTlds(); });
      host.append(b);
    }
  }

  $("#add-tld").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#custom-tld");
    const tld = input.value.trim().toLowerCase().replace(/^\.+/, "");
    if (!isLabel(tld)) { input.setCustomValidity("Letters, numbers and hyphens only"); input.reportValidity(); return; }
    input.setCustomValidity("");
    if (!curated.includes(tld) && !custom.includes(tld)) custom.push(tld);
    selected.add(tld);
    persist();
    renderTlds();
    input.value = "";
  });
  $("#custom-tld").addEventListener("input", (e) => e.target.setCustomValidity(""));

  // ---------- words ----------
  function isLabel(s) {
    return typeof s === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s);
  }

  function parseWords(raw) {
    const good = [], bad = [];
    for (const part of raw.split(/[,\n;]+/)) {
      const original = part.trim();
      if (!original) continue;
      const label = original.toLowerCase().replace(/['’]/g, "").replace(/\s+/g, "");
      if (isLabel(label)) { if (!good.includes(label)) good.push(label); }
      else bad.push(original);
    }
    return { good, bad };
  }

  // ---------- lookups ----------
  function fetchJson(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    return fetch(url, { ...opts, signal: ctrl.signal, credentials: "omit" })
      .finally(() => clearTimeout(timer));
  }

  let bootstrapPromise = null;
  function rdapBases() {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      const cached = store.get(BOOTSTRAP_KEY, sessionStorage);
      if (cached && typeof cached === "object") return cached;
      try {
        const res = await fetchJson(BOOTSTRAP_URL);
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        const map = {};
        for (const [tlds, urls] of data.services || []) {
          const url = urls.find((u) => u.startsWith("https://")) || urls[0];
          for (const t of tlds) map[t.toLowerCase()] = url.endsWith("/") ? url : url + "/";
        }
        store.set(BOOTSTRAP_KEY, map, sessionStorage);
        return map;
      } catch {
        return null; // fall back to rdap.org for everything
      }
    })();
    return bootstrapPromise;
  }

  function fmtDate(s) {
    const d = new Date(s);
    return isNaN(d) ? null : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function summarizeRdap(data) {
    const ev = (name) => (data.events || []).find((e) => e.eventAction === name)?.eventDate;
    const registrar = (data.entities || []).find((e) => (e.roles || []).includes("registrar"));
    const fn = registrar?.vcardArray?.[1]?.find((f) => f[0] === "fn")?.[3];
    const bits = [];
    const reg = fmtDate(ev("registration"));
    const exp = fmtDate(ev("expiration"));
    if (reg) bits.push(`Registered ${reg}`);
    if (exp) bits.push(`expires ${exp}`);
    if (fn) bits.push(`via ${fn}`);
    return bits.join(" · ");
  }

  async function rdap(domain, tld) {
    const bases = await rdapBases();
    let base = bases ? bases[tld] : RDAP_FALLBACK;
    if (bases && !base) return null; // registry publishes no RDAP service
    try {
      const res = await fetchJson(`${base}domain/${domain}`, { headers: { Accept: "application/rdap+json" } });
      if (res.status === 404) return { state: "available", source: "rdap" };
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return { state: "taken", source: "rdap", detail: summarizeRdap(data) };
      }
    } catch { /* CORS, network or timeout: fall through to DNS */ }
    return null;
  }

  async function dns(domain) {
    for (const make of DOH) {
      try {
        const res = await fetchJson(make(domain), { headers: { Accept: "application/dns-json" } });
        if (!res.ok) continue;
        const data = await res.json();
        if (data.Status === 3) return { state: "likely", source: "dns" };
        if (data.Status === 0) return { state: "taken", source: "dns", detail: "Has live DNS records" };
      } catch { /* try next resolver */ }
    }
    return null;
  }

  async function check(domain, tld) {
    return (await rdap(domain, tld)) || (await dns(domain)) || { state: "unknown" };
  }

  // ---------- simple concurrency queue ----------
  function makeQueue(limit) {
    let active = 0;
    const waiting = [];
    const next = () => {
      if (active >= limit || !waiting.length) return;
      active++;
      const { fn, resolve } = waiting.shift();
      fn().then(resolve, () => resolve({ state: "unknown" })).finally(() => { active--; next(); });
    };
    return (fn) => new Promise((resolve) => { waiting.push({ fn, resolve }); next(); });
  }

  // ---------- results ----------
  const LABELS = {
    checking: "Checking…",
    available: "Available",
    likely: "Probably available",
    taken: "Taken",
    unknown: "Couldn't tell",
  };

  let runId = 0;

  function run(words, tlds) {
    const myRun = ++runId;
    const enqueue = makeQueue(MAX_PARALLEL);
    const host = $("#results");
    host.textContent = "";
    const tpl = $("#row-tpl");

    for (const word of words) {
      const card = document.createElement("article");
      card.className = "card";
      const head = document.createElement("header");
      const h = document.createElement("h2");
      h.textContent = word;
      const tally = document.createElement("span");
      tally.className = "tally";
      head.append(h, tally);
      const list = document.createElement("ul");
      card.append(head, list);
      host.append(card);

      let free = 0, done = 0;
      const updateTally = () => {
        tally.textContent = done < tlds.length
          ? `${done} of ${tlds.length} checked`
          : `${free} of ${tlds.length} look free`;
      };
      updateTally();

      for (const tld of tlds) {
        const domain = `${word}.${tld}`;
        const row = tpl.content.firstElementChild.cloneNode(true);
        $(".domain", row).innerHTML = `<b>${word}</b>.${tld}`;
        list.append(row);

        enqueue(() => check(domain, tld)).then((r) => {
          if (myRun !== runId) return;
          row.dataset.state = r.state;
          $(".label", row).textContent = LABELS[r.state];
          const detail = r.detail || (r.state === "likely" ? "No DNS record; registry has no lookup service" : "");
          $(".detail", row).textContent = detail;
          const act = $(".act", row);
          if (r.state === "available" || r.state === "likely") {
            act.href = REGISTER_URL(domain); act.textContent = "Register";
            free++;
          } else if (r.state === "taken") {
            act.href = `https://${domain}`; act.textContent = "Visit";
          } else {
            act.href = REGISTER_URL(domain); act.textContent = "Look up";
          }
          done++;
          updateTally();
          sortList(list);
        });
      }
    }
  }

  const ORDER = { available: 0, likely: 1, checking: 2, unknown: 3, taken: 4 };
  function sortList(list) {
    const rows = [...list.children];
    rows.sort((a, b) => ORDER[a.dataset.state] - ORDER[b.dataset.state]);
    rows.forEach((r) => list.append(r));
  }

  function showMessage(text) {
    const host = $("#results");
    host.textContent = "";
    const p = document.createElement("p");
    p.className = "message";
    p.textContent = text;
    host.append(p);
  }

  function submit(raw, pushUrl) {
    const { good, bad } = parseWords(raw);
    const tlds = [...selected];
    if (!good.length) {
      showMessage(bad.length ? `“${bad.join("”, “")}” can't be a domain name. Use letters, numbers and hyphens.` : "Type a word to get started.");
      return;
    }
    if (!tlds.length) { showMessage("Pick at least one domain ending below."); return; }
    if (pushUrl) {
      const url = new URL(location.href);
      url.searchParams.set("q", raw);
      history.replaceState(null, "", url);
    }
    run(good, tlds);
    if (bad.length) {
      const note = document.createElement("p");
      note.className = "message";
      note.textContent = `Skipped “${bad.join("”, “")}”: domain names can only use letters, numbers and hyphens.`;
      $("#results").prepend(note);
    }
  }

  $("#search").addEventListener("submit", (e) => {
    e.preventDefault();
    submit($("#words").value, true);
  });

  renderPresets();
  renderTlds();
  rdapBases(); // warm the cache

  const q = new URLSearchParams(location.search).get("q");
  if (q) { $("#words").value = q; submit(q, false); }

  // exposed for tests
  window.__registryCheck = { parseWords, isLabel };
})();
