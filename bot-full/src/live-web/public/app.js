(function () {
  const $ = (id) => document.getElementById(id);
  const path = location.pathname;
  const m = path.match(/^\/v\/([A-Za-z0-9_-]+)$/);
  let token = m ? m[1] : null;
  let es = null;
  let pollTimer = null;
  let reconnectTimer = null;
  let hasData = false;

  function fmtPx(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n >= 1) return n.toFixed(4);
    if (n >= 0.01) return n.toFixed(6);
    return n.toPrecision(4);
  }

  function setStatus(kind, text) {
    const b = $("liveBadge");
    b.textContent = text;
    b.className = "badge live " + (kind === "ok" ? "on" : kind === "err" ? "err" : "off");
  }

  function render(s) {
    if (!s || typeof s !== "object") return;
    const isErr = !!(s.error && s.error !== "loading");
    const isLoading = s.error === "loading" && !(s.bins && s.bins.length);
    const useful = !isErr && ((s.bins && s.bins.length > 0) || s.valueUsd != null || s.demo);

    $("pairLine").textContent = `${s.pair || "—"} · ${s.strategy || "—"} · ${s.positionShort || ""}`;
    $("demoBadge").hidden = !s.demo;
    const rb = $("rangeBadge");
    if (useful || s.demo) {
      rb.textContent = s.inRange ? "IN RANGE" : "OUT OF RANGE";
      rb.className = "badge range " + (s.inRange ? "in" : "out");
    } else {
      rb.textContent = isLoading ? "LOADING" : "ERROR";
      rb.className = "badge range out";
    }

    $("pnl").textContent = s.pnlText || "—";
    $("pnl").className = "v " + ((s.pnlUsd ?? 0) >= 0 ? "pos" : "neg");
    $("fees").textContent = s.feesText || "—";
    $("value").textContent = s.valueText || "—";
    $("capital").textContent = s.capitalText || "—";

    const nBars = s.bins?.length || 0;
    $("binMeta").textContent = isLoading ? "loading…" : isErr ? "data error" : `bin ${s.activeBinId} · ${nBars} bars`;
    $("minPx").textContent = useful || s.demo ? fmtPx(s.minPrice) : "—";
    $("maxPx").textContent = useful || s.demo ? fmtPx(s.maxPrice) : "—";
    $("activeLbl").textContent = useful || s.demo ? `active ${fmtPx(s.activePrice)}` : "active —";
    $("ts").textContent = s.ts ? new Date(s.ts).toLocaleTimeString() : "—";

    const err = $("errLine");
    if (err) {
      if (isErr) {
        err.hidden = false;
        err.textContent = "❌ " + String(s.error).slice(0, 180);
      } else if (isLoading) {
        err.hidden = false;
        err.textContent = "⏳ Loading position…";
      } else {
        err.hidden = true;
        err.textContent = "";
      }
    }

    const chart = $("chart");
    chart.innerHTML = "";
    (s.bins || []).forEach((b, i, bins) => {
      const el = document.createElement("div");
      el.className = "bar";
      if (b.binId === s.activeBinId) el.classList.add("active");
      if (i === 0 || i === bins.length - 1) el.classList.add("edge");
      el.style.height = `${Math.max(4, Math.round((b.height || 0) * 100))}%`;
      el.title = `bin ${b.binId}`;
      chart.appendChild(el);
    });

    if (useful || s.demo) {
      hasData = true;
      setStatus("ok", "● live");
    } else if (isLoading) setStatus("off", "● loading");
    else setStatus("err", "● error");
  }

  async function ensureToken() {
    if (token) return token;
    const r = await fetch("/api/demo-token", { method: "POST" });
    const j = await r.json();
    token = j.token;
    history.replaceState(null, "", `/v/${token}`);
    return token;
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch(`/api/snapshot/${token}`, { cache: "no-store" });
        if (!r.ok) return setStatus("err", "● error");
        render(await r.json());
      } catch {
        setStatus("off", "● reconnecting");
      }
    }, 2000);
  }

  async function connect() {
    await ensureToken();
    setStatus("off", "● connecting");
    if (es) {
      try { es.close(); } catch (_) {}
      es = null;
    }
    try {
      const r = await fetch(`/api/snapshot/${token}`, { cache: "no-store" });
      if (r.ok) render(await r.json());
    } catch (_) {}

    es = new EventSource(`/api/stream/${token}`);
    es.onopen = () => {
      if (!hasData) setStatus("off", "● connecting");
    };
    es.onmessage = (ev) => {
      try {
        render(JSON.parse(ev.data));
        stopPoll();
      } catch (_) {}
    };
    es.onerror = () => {
      setStatus("off", "● reconnecting");
      try { es.close(); } catch (_) {}
      es = null;
      startPoll();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    };
  }

  connect();
})();
