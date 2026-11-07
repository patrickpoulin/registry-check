(() => {
  "use strict";

  const BOOTSTRAP_KEY = "registry-check:rdap-bootstrap";
  const LENGTHS_KEY = "registry-check:lengths";
  const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
  const DOH = [
    (name, type) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
    (name, type) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
  ];
  const REGISTER_URL = (d) => `https://porkbun.com/checkout/search?q=${encodeURIComponent(d)}`;
  const PRICE_API = String((window.REGISTRY_CHECK_CONFIG || {}).priceApi || "").replace(/\/+$/, "");
  const PRICE_BATCH = 50;
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

  // ---------- price service (optional; see worker/README.md) ----------
  // Batches free names into POST {PRICE_API}/check { domains: [...] } and resolves each with
  // { premium, price, renewal, reserved } or null when the service can't answer.
  function makePricer(owner) {
    let waiting = [];
    let timer = null;
    let inflight = 0;
    const queue = [];
    const pump = () => {
      while (inflight < 2 && queue.length) {
        const batch = queue.shift();
        inflight++;
        send(batch).finally(() => { inflight--; pump(); });
      }
    };
    const flush = () => {
      clearTimeout(timer); timer = null;
      while (waiting.length) queue.push(waiting.splice(0, PRICE_BATCH));
      pump();
    };
    async function send(batch) {
      let results = {};
      try {
        const res = await fetchT(`${PRICE_API}/check`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" }, // simple request: no CORS preflight
          body: JSON.stringify({ domains: batch.map((b) => b.domain) }),
        });
        if (!res.ok) throw new Error(String(res.status));
        results = (await res.json()).results || {};
      } catch {
        owner.priceError = true;
      }
      for (const b of batch) {
        const r = results[b.domain];
        b.resolve(r ? {
          premium: !!r.premium,
          price: typeof r.price === "number" ? r.price : null,
          renewal: typeof r.renewal === "number" ? r.renewal : null,
          reserved: r.purchasable === false,
        } : null);
      }
    }
    return {
      add(domain) {
        return new Promise((resolve) => {
          waiting.push({ domain, resolve });
          if (waiting.length >= PRICE_BATCH) flush();
          else if (!timer) timer = setTimeout(flush, 400);
        });
      },
      clear() { waiting = []; queue.length = 0; clearTimeout(timer); timer = null; },
    };
  }

  const premiumBox = $("#show-premium");
  premiumBox.checked = false;
  if (!PRICE_API) {
    premiumBox.disabled = true;
    $("#premium-toggle").title = "Premium detection isn't set up yet. See worker/README.md.";
    $("#premium-toggle").classList.add("off");
    $("#premium-count").textContent = "(not set up yet)";
  }
  premiumBox.addEventListener("change", () => {
    showPremium = premiumBox.checked;
    grid.classList.toggle("show-premium", showPremium);
    updateProgress();
  });

  // ---------- run ----------
  let run = null; // { id, tld, ... }
  let view = "available";
  let showPremium = false;
  const money = (n) => (typeof n === "number" ? `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 2 : 0 })}` : "");
  const isFree = (s) => s === "available" || s === "likely";
  const premiumHidden = (tile) => tile.dataset.premium === "yes" && !showPremium;

  const grid = $("#grid");

  function setView(v) {
    view = v;
    for (const tab of document.querySelectorAll("[data-view]")) tab.setAttribute("aria-selected", tab.dataset.view === v);
    grid.dataset.view = v;
    applyFilters();
  }
  document.querySelectorAll("[data-view]").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));

  function tally() {
    const c = { available: 0, taken: 0, all: 0, done: 0, premium: 0, hidden: 0 };
    for (const tile of grid.children) {
      if (!lengths.has(Number(tile.dataset.len))) continue;
      const s = tile.dataset.state;
      if (tile.dataset.premium === "yes") c.premium++;
      if (s !== "checking") c.done++;
      if (premiumHidden(tile)) { c.hidden++; continue; }
      c.all++;
      if (isFree(s)) c.available++;
      else if (s === "taken") c.taken++;
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
    const totalWords = c.all + c.hidden;
    const pct = totalWords ? (c.done / totalWords) * 100 : 0;
    $("#bar").style.width = `${pct}%`;
    const finished = c.done >= totalWords;
    const premiumNote = c.premium
      ? (showPremium ? ` ${fmt(c.premium)} of them are premium.` : ` ${fmt(c.premium)} premium ${c.premium === 1 ? "name is" : "names are"} hidden.`)
      : "";
    $("#progress-text").textContent = (finished
      ? `Done. ${fmt(c.available)} words look free on .${run.tld}.`
      : run.stopped
        ? `Stopped after ${fmt(c.done)} of ${fmt(totalWords)} words.`
        : `Checking ${fmt(c.done)} of ${fmt(totalWords)} words…`) + premiumNote + (run.priceError ? " Prices couldn't be loaded, so premium names may be included." : "");
    if (PRICE_API) $("#premium-count").textContent = c.premium ? `(${fmt(c.premium)})` : "";
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
    if (premiumHidden(tile)) return false;
    if (view === "all") return true;
    if (view === "available") return isFree(s);
    return s === "taken";
  }

  function setTile(tile, state, info) {
    tile.dataset.state = state;
    const a = tile.firstElementChild;
    const domain = `${tile.dataset.word}.${run.tld}`;
    if (info && info.premium && isFree(state)) tile.dataset.premium = "yes";
    if (info && isFree(state) && typeof info.price === "number") {
      const p = document.createElement("span");
      p.className = "p";
      p.textContent = money(info.price);
      a.append(p);
    }
    if (isFree(state)) {
      a.href = REGISTER_URL(domain);
      a.title = info && info.premium
        ? `Premium name: ${money(info.price)} to register${typeof info.renewal === "number" ? `, ${money(info.renewal)}/yr to renew` : ""}.`
        : state === "likely" ? "Probably available (registry didn't confirm). Click to check with a registrar." : "Available. Click to register.";
    } else if (info && info.reserved) {
      a.href = REGISTER_URL(domain);
      a.title = "Not registered, but the registry doesn't allow it to be bought (reserved).";
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
    run.pricer && run.pricer.clear();
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
    if (PRICE_API) me.pricer = makePricer(me);

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
      li.innerHTML = `<a target="_blank" rel="noopener"><span class="n"><span class="w">${w}</span><span class="t">.${tld}</span></span></a>`;
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
      me.dnsQ.add(() => checkOne(tile)).then(async (state) => {
        if (run !== me || !state) return;
        let info = null;
        if (isFree(state) && me.pricer) {
          // Free by the registry: ask the price service whether it's premium before showing it.
          info = await me.pricer.add(`${tile.dataset.word}.${tld}`);
          if (run !== me) return;
          if (info && info.reserved) state = "taken";
        }
        setTile(tile, state, info);
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
