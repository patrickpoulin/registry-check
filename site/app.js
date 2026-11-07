(() => {
  "use strict";

  const BOOTSTRAP_KEY = "registry-check:rdap-bootstrap";
  const LENGTHS_KEY = "registry-check:lengths";
  const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
  const DOH = [
    (name, type) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
    (name, type) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
  ];
  const REGISTER_URL = (d) => `https://www.namecheap.com/domains/registration/results/?domain=${encodeURIComponent(d)}`;
  const DNS_PARALLEL = 8;
  const RDAP_PARALLEL = 3;
  const TIMEOUT_MS = 10000;
  const POPULAR = ["love", "com", "io", "ai", "app", "dev", "co", "me", "xyz", "lol", "fun", "life", "art", "shop", "blog", "club"];
  const SUGGEST = POPULAR.concat(["net", "org", "online", "site", "store", "tech", "studio", "design", "world", "live", "space", "cool", "rocks", "wtf", "fans", "party", "pizza", "cafe", "coffee", "games", "music", "photo", "pet", "dog", "baby", "family", "guru", "vip", "bio", "eco", "gg", "tv", "fm", "so", "to", "sh", "ly"]);

  const $ = (sel, root = document) => root.querySelector(sel);
  const fmt = (n) => n.toLocaleString();

  // ---------- word library ----------
  const LIB = {};
  for (const [len, list] of Object.entries(window.WORDS || {})) {
    LIB[len] = [...new Set(list.split(/\s+/).filter((w) => /^[a-z]+$/.test(w)))];
  }
  const ALL_LENGTHS = Object.keys(LIB).map(Number).sort((a, b) => a - b);
  const total = ALL_LENGTHS.reduce((n, l) => n + LIB[l].length, 0);
  $("#lib-count").textContent = fmt(total);

  // ---------- storage (best effort) ----------
  const store = {
    get(key, s = localStorage) { try { return JSON.parse(s.getItem(key)); } catch { return null; } },
    set(key, v, s = localStorage) { try { s.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------- controls ----------
  const savedLengths = store.get(LENGTHS_KEY);
  let lengths = new Set(Array.isArray(savedLengths) && savedLengths.length ? savedLengths : ALL_LENGTHS);

  function renderLengthChips() {
    const host = $("#length-chips");
    host.textContent = "";
    for (const len of ALL_LENGTHS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.setAttribute("aria-pressed", lengths.has(len));
      b.innerHTML = `${len} letters <span class="muted">${fmt(LIB[len].length)}</span>`;
      b.addEventListener("click", () => {
        if (lengths.has(len) && lengths.size === 1) return; // keep at least one
        lengths.has(len) ? lengths.delete(len) : lengths.add(len);
        store.set(LENGTHS_KEY, [...lengths]);
        renderLengthChips();
        applyFilters();
      });
      host.append(b);
    }
  }

  function renderQuick() {
    const host = $("#quick");
    for (const t of POPULAR) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill";
      b.textContent = `.${t}`;
      b.addEventListener("click", () => { $("#tld").value = t; start(t); });
      host.append(b);
    }
    const dl = $("#tld-suggest");
    for (const t of [...new Set(SUGGEST)]) {
      const o = document.createElement("option");
      o.value = t;
      dl.append(o);
    }
  }

  // ---------- network helpers ----------
  function fetchT(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    return fetch(url, { ...opts, signal: ctrl.signal, credentials: "omit" }).finally(() => clearTimeout(timer));
  }

  async function doh(name, type = "NS") {
    for (const make of DOH) {
      try {
        const res = await fetchT(make(name, type), { headers: { Accept: "application/dns-json" } });
        if (!res.ok) continue;
        const data = await res.json();
        if (typeof data.Status === "number") return data.Status; // 0 NOERROR, 3 NXDOMAIN, 2 SERVFAIL...
      } catch { /* next resolver */ }
    }
    return null;
  }

  let bootstrapPromise = null;
  function rdapBases() {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      const cached = store.get(BOOTSTRAP_KEY, sessionStorage);
      if (cached && typeof cached === "object") return cached;
      try {
        const res = await fetchT(BOOTSTRAP_URL);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const map = {};
        for (const [tlds, urls] of data.services || []) {
          const url = urls.find((u) => u.startsWith("https://")) || urls[0];
          for (const t of tlds) map[t.toLowerCase()] = url.endsWith("/") ? url : url + "/";
        }
        store.set(BOOTSTRAP_KEY, map, sessionStorage);
        return map;
      } catch {
        return {};
      }
    })();
    return bootstrapPromise;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Returns "available" | "taken" | null (couldn't tell)
  async function rdap(base, domain, attempt = 0) {
    try {
      const res = await fetchT(`${base}domain/${domain}`, { headers: { Accept: "application/rdap+json" } });
      if (res.status === 404) return "available";
      if (res.ok) return "taken";
      if (res.status === 429 && attempt < 2) {
        const wait = Number(res.headers.get("Retry-After")) || 4;
        await sleep(Math.min(wait, 20) * 1000);
        return rdap(base, domain, attempt + 1);
      }
    } catch { /* CORS, network, timeout */ }
    return null;
  }

  function makeQueue(limit) {
    let active = 0;
    let waiting = [];
    const next = () => {
      while (active < limit && waiting.length) {
        const { fn, resolve } = waiting.shift();
        active++;
        fn().then(resolve, () => resolve(null)).finally(() => { active--; next(); });
      }
    };
    return {
      add: (fn) => new Promise((resolve) => { waiting.push({ fn, resolve }); next(); }),
      clear: () => { waiting = []; },
    };
  }

  // ---------- run ----------
  let run = null; // { id, tld, ... }
  let view = "available";

  const grid = $("#grid");

  function setView(v) {
    view = v;
    for (const tab of document.querySelectorAll("[data-view]")) tab.setAttribute("aria-selected", tab.dataset.view === v);
    grid.dataset.view = v;
    applyFilters();
  }
  document.querySelectorAll("[data-view]").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));

  function tally() {
    const c = { available: 0, taken: 0, all: 0, done: 0 };
    for (const tile of grid.children) {
      if (!lengths.has(Number(tile.dataset.len))) continue;
      c.all++;
      const s = tile.dataset.state;
      if (s === "available" || s === "likely") c.available++;
      else if (s === "taken") c.taken++;
      if (s !== "checking") c.done++;
    }
    return c;
  }

  function applyFilters() {
    grid.dataset.lengths = [...lengths].join(" ");
    for (const tile of grid.children) tile.hidden = !lengths.has(Number(tile.dataset.len));
    updateProgress();
  }

  function updateProgress() {
    if (!run) return;
    const c = tally();
    $("#n-available").textContent = fmt(c.available);
    $("#n-taken").textContent = fmt(c.taken);
    $("#n-all").textContent = fmt(c.all);
    const pct = c.all ? (c.done / c.all) * 100 : 0;
    $("#bar").style.width = `${pct}%`;
    const finished = c.done >= c.all;
    $("#progress-text").textContent = finished
      ? `Done. ${fmt(c.available)} of ${fmt(c.all)} words look free on .${run.tld}.`
      : run.stopped
        ? `Stopped after ${fmt(c.done)} of ${fmt(c.all)} words.`
        : `Checking ${fmt(c.done)} of ${fmt(c.all)} words…`;
    if (finished || run.stopped) { $("#stop").hidden = true; $(".progress").classList.add("done"); }

    const visible = [...grid.children].some((t) => !t.hidden && matchesView(t));
    const empty = $("#empty");
    empty.hidden = visible;
    if (!visible) {
      empty.textContent = view === "available"
        ? (finished ? `No free words found on .${run.tld} for these lengths.` : "Free words will show up here as they're found.")
        : "Nothing here yet.";
    }
  }

  function matchesView(tile) {
    const s = tile.dataset.state;
    if (view === "all") return true;
    if (view === "available") return s === "available" || s === "likely";
    return s === "taken";
  }

  function setTile(tile, state) {
    tile.dataset.state = state;
    const a = tile.firstElementChild;
    const domain = `${tile.dataset.word}.${run.tld}`;
    if (state === "available" || state === "likely") {
      a.href = REGISTER_URL(domain);
      a.title = state === "likely" ? "Probably available (registry didn't confirm). Click to check with a registrar." : "Available. Click to register.";
    } else if (state === "taken") {
      a.href = `https://${domain}`;
      a.title = "Taken. Click to visit.";
    } else {
      a.href = REGISTER_URL(domain);
      a.title = "Couldn't tell. Click to check with a registrar.";
    }
  }

  function showError(msg) {
    $("#status").hidden = false;
    $("#status-title").textContent = msg;
    $(".tabs").hidden = true;
    $(".progress").hidden = true;
    $("#progress-text").textContent = "";
    grid.textContent = "";
    $("#empty").hidden = true;
    $("#stop").hidden = true;
  }

  function stop() {
    if (!run) return;
    run.stopped = true;
    run.dnsQ.clear();
    run.rdapQ.clear();
    updateProgress();
  }
  $("#stop").addEventListener("click", stop);

  async function start(raw) {
    if (run) stop();
    const tld = String(raw).trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
    if (!/^(?:[a-z0-9-]+\.)*[a-z0-9-]{2,63}$/.test(tld)) {
      showError("That doesn't look like a domain ending. Try something like .love");
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set("tld", tld);
    history.replaceState(null, "", url);

    const id = Symbol("run");
    run = { id, tld, stopped: false, dnsQ: makeQueue(DNS_PARALLEL), rdapQ: makeQueue(RDAP_PARALLEL) };
    const me = run;

    $("#status").hidden = false;
    $("#status-title").textContent = `Checking .${tld}`;
    $(".tabs").hidden = true;
    $(".progress").hidden = true;
    $("#progress-text").textContent = "Looking up the domain ending…";
    grid.textContent = "";
    $("#empty").hidden = true;

    // Does the ending exist, and does it answer for every name (wildcard DNS)?
    const [tldStatus, wildStatus, bases] = await Promise.all([
      doh(tld, "SOA"),
      doh(`zq${Math.random().toString(36).slice(2, 10)}x.${tld}`, "NS"),
      rdapBases(),
    ]);
    if (run !== me) return;
    if (tldStatus === 3) { showError(`.${tld} isn't a domain ending that exists.`); run = null; return; }
    const rdapBase = bases[tld.split(".").pop()] || null;
    const wildcard = wildStatus === 0;
    if (wildcard && !rdapBase) {
      showError(`.${tld} answers DNS for every name and has no public registry lookup, so availability can't be checked from a browser.`);
      run = null;
      return;
    }

    $("#status-title").textContent = `Words on .${tld}`;
    $(".tabs").hidden = false;
    $(".progress").hidden = false;
    $(".progress").classList.remove("done");
    $("#stop").hidden = false;

    const words = ALL_LENGTHS.filter((l) => lengths.has(l)).flatMap((l) => LIB[l]);
    const frag = document.createDocumentFragment();
    const tiles = words.map((w) => {
      const li = document.createElement("li");
      li.className = "tile";
      li.dataset.word = w;
      li.dataset.len = w.length;
      li.dataset.state = "checking";
      li.innerHTML = `<a target="_blank" rel="noopener"><span class="w">${w}</span><span class="t">.${tld}</span></a>`;
      frag.append(li);
      return li;
    });
    grid.append(frag);
    setView(view);

    let pending = 0;
    const refresh = () => { if (!pending++) requestAnimationFrame(() => { pending = 0; if (run === me) updateProgress(); }); };

    const checkOne = async (tile) => {
      const domain = `${tile.dataset.word}.${tld}`;
      let state = null;
      if (!wildcard) {
        const s = await doh(domain, "NS");
        if (s === 0 || s === 2) state = "taken"; // has records (or a broken delegation)
        else if (s === 3) state = "likely";
      }
      if ((state === "likely" || state === null) && rdapBase && !me.stopped) {
        const r = await me.rdapQ.add(() => rdap(rdapBase, domain));
        if (r) state = r;
      }
      return state || "unknown";
    };

    for (const tile of tiles) {
      me.dnsQ.add(() => checkOne(tile)).then((state) => {
        if (run !== me || !state) return;
        setTile(tile, state);
        refresh();
      });
    }
    updateProgress();
  }

  $("#search").addEventListener("submit", (e) => {
    e.preventDefault();
    start($("#tld").value);
  });

  renderLengthChips();
  renderQuick();
  grid.dataset.view = view;
  rdapBases();

  const q = new URLSearchParams(location.search).get("tld");
  if (q) { $("#tld").value = q; start(q); }
})();
