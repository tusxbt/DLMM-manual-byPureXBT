(function () {
  const $ = (id) => document.getElementById(id);
  const path = location.pathname;
  const m = path.match(/^\/v\/([A-Za-z0-9_-]+)$/);
  let token = m ? m[1] : null;
  let es = null;
  let pollTimer = null;

  function fmtPx(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n >= 1) return n.toFixed(4);
    if (n >= 0.01) return n.toFixed(6);
    return n.toPrecision(4);
  }

  function render(s) {
    $("pairLine").textContent = `${s.pair || "—"} · ${s.strategy || "—"} · ${s.positionShort || ""}`;
    const demo = !!s.demo;
    $("demoBadge").hidden = !demo;
    const rb = $("rangeBadge");
    rb.textContent = s.inRange ? "IN RANGE" : "OUT OF RANGE";
    rb.className = "badge range " + (s.inRange ? "in" : "out");

    const pnl = $("pnl");
    pnl.textContent = s.pnlText || "—";
    pnl.className = "v " + ((s.pnlUsd ?? 0) >= 0 ? "pos" : "neg");
    $("fees").textContent = s.feesText || "—";
    $("value").textContent = s.valueText || "—";
    $("capital").textContent = s.capitalText || "—";

    $("binMeta").textContent = `bin ${s.activeBinId} · ${s.bins?.length || 0} bars`;
    $("minPx").textContent = fmtPx(s.minPrice);
    $("maxPx").textContent = fmtPx(s.maxPrice);
    $("activeLbl").textContent = `active ${fmtPx(s.activePrice)}`;
    $("ts").textContent = s.ts ? new Date(s.ts).toLocaleTimeString() : "—";

    const chart = $("chart");
    chart.innerHTML = "";
    const bins = s.bins || [];
    const mid = bins.findIndex((b) => b.binId === s.activeBinId);
    bins.forEach((b, i) => {
      const el = document.createElement("div");
      el.className = "bar";
      if (b.binId === s.activeBinId) el.classList.add("active");
      if (mid >= 0 && (i === 0 || i === bins.length - 1)) el.classList.add("edge");
      el.style.height = `${Math.max(4, Math.round((b.height || 0) * 100))}%`;
      el.title = `bin ${b.binId}`;
      chart.appendChild(el);
    });
  }

  function setLive(ok) {
    const b = $("liveBadge");
    b.textContent = ok ? "● live" : "● reconnecting";
    b.className = "badge live " + (ok ? "on" : "off");
  }

  async function ensureToken() {
    if (token) return token;
    const r = await fetch("/api/demo-token", { method: "POST" });
    const j = await r.json();
    token = j.token;
    history.replaceState(null, "", `/v/${token}`);
    return token;
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch(`/api/snapshot/${token}`);
        if (!r.ok) return;
        render(await r.json());
        setLive(true);
      } catch {
        setLive(false);
      }
    }, 1500);
  }

  async function connect() {
    await ensureToken();
    if (es) {
      try { es.close(); } catch (_) {}
    }
    es = new EventSource(`/api/stream/${token}`);
    es.onopen = () => setLive(true);
    es.onmessage = (ev) => {
      try {
        render(JSON.parse(ev.data));
        setLive(true);
      } catch (_) {}
    };
    es.onerror = () => {
      setLive(false);
      try { es.close(); } catch (_) {}
      es = null;
      startPoll();
      setTimeout(connect, 2500);
    };
  }

  connect();
})();
