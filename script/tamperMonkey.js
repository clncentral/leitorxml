// ==UserScript==
// @name         InfraDesk — Injetar Operador + CSV (FAST + cores)
// @namespace    clncentral/infradesk
// @version      1.4
// @match        https://asp.infradesk.app/backend/despesas*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @updateURL    https://clncentral.github.io/leitorxml/script/tamperMonkey.js
// @downloadURL  https://clncentral.github.io/leitorxml/script/tamperMonkey.js
// ==/UserScript==


(() => {
  // ======================
  // CONFIG
  // ======================
  const WEBAPP_URL = "https://script.google.com/macros/s/AKfycby48yW6Cl1M33FjPb_Wky4u2UbZ4mpP00SE5WsS3_ddKEvBEyy8RYC0PXssSlQiXucyug/exec";

  // ⚠️ “instantâneo” real só com push (não tem). Então a gente faz polling leve:
  const FETCH_MS = 1500; // 1500ms (se quiser mais leve: 2500 / 4000)
  const MAX_ROWS = 500;  // limite por ciclo de injeção
  const SHOW_UNASSIGNED = false; // true => mostra "—" quando não tem operador

  // Pintura
  const PAINT_BADGE = true; // pinta a pílula do operador
  const PAINT_BAR   = true; // pinta a barrinha à esquerda

  // Cores fixas (bate com a planilha)
  const OP_COLOR_OVERRIDES = {
    "Elias Araujo": "#0324ff",
    "Camily": "#ed5ac1",
    "Elia Maria": "#962bcc",
    "Patricia": "#ff8e03",
  };
  // ======================

  // ======================
  // HELPERS
  // ======================
  const clean = (s) => String(s ?? "")
    .replace(/\u00a0/g, " ")        // NBSP -> espaço normal
    .replace(/\s+/g, " ")
    .trim();

  const onlyDigits = (s) => (String(s ?? "").match(/\d+/g) || []).join("");
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const normName = (s) => clean(s).toLowerCase();

  // normaliza overrides pra bater case-insensitive
  const OP_COLOR_OVERRIDES_NORM = Object.fromEntries(
    Object.entries(OP_COLOR_OVERRIDES).map(([k, v]) => [normName(k), v])
  );

  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  function colorForOperator(op) {
    const key = normName(op);
    if (!key) return "#111827";

    // ✅ override direto
    if (OP_COLOR_OVERRIDES_NORM[key]) return OP_COLOR_OVERRIDES_NORM[key];

    // fallback: cor consistente por nome
    const hue = hashHue(key);
    return `hsl(${hue} 70% 38%)`;
  }

  // ======================
  // STATE (debug no console)
  // ======================
  const STATE = {
    syncing: true,
    lastMap: {},
    lastMapCount: 0,
    lastFetch: null,
    lastInject: null,
    lastInjected: 0,
    lastError: null,
    lastRaw: null,
    lastMsFetch: 0,
    lastMsInject: 0,
  };

  unsafeWindow.__INFRA_TM__ = STATE;
  unsafeWindow.__INFRA_TM_dump = () => ({
    ...STATE,
    keys_sample: Object.keys(STATE.lastMap || {}).slice(0, 30),
    op_40373: (STATE.lastMap || {})["40373"],
  });

  // ======================
  // UI (mini)
  // ======================
  const ui = document.createElement("div");
  ui.style.cssText = "position:fixed;bottom:14px;right:14px;z-index:2147483647;display:flex;gap:8px;align-items:center;";
  document.body.appendChild(ui);

  function mkMiniBtn(text, bg) {
    const b = document.createElement("button");
    b.textContent = text;
    b.style.cssText =
      `height:34px;min-width:34px;padding:0 10px;border-radius:999px;border:0;background:${bg};color:#fff;font-weight:900;` +
      "box-shadow:0 8px 24px rgba(0,0,0,.25);font:12px/1 system-ui;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;";
    return b;
  }

  const btnCSV = mkMiniBtn("CSV", "#10b981");
  const btnMenu = mkMiniBtn("⋯", "#111827");
  ui.appendChild(btnCSV);
  ui.appendChild(btnMenu);

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;bottom:56px;right:14px;z-index:2147483647;" +
    "background:#0b1220;color:#fff;border-radius:12px;padding:10px 10px;" +
    "box-shadow:0 10px 30px rgba(0,0,0,.35);min-width:260px;display:none;";
  document.body.appendChild(panel);

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
      <div style="font-weight:900;">InfraDesk Sync</div>
      <button id="tmClose" style="border:0;background:transparent;color:#fff;font-size:16px;cursor:pointer;">✕</button>
    </div>

    <div id="tmStatus" style="font:12px/1.3 system-ui;opacity:.95;margin-bottom:10px;">
      iniciando…
    </div>

    <div style="display:flex;gap:8px;">
      <button id="tmSync" style="flex:1;border:0;border-radius:10px;padding:8px 10px;background:#1c84c6;color:#fff;font-weight:900;cursor:pointer;">SYNC: ON</button>
      <button id="tmNow"  style="border:0;border-radius:10px;padding:8px 10px;background:#7c3aed;color:#fff;font-weight:900;cursor:pointer;">AGORA</button>
    </div>

    <div style="margin-top:8px;font:11px/1.35 system-ui;opacity:.8;">
      Dica: console -> <b>__INFRA_TM_dump()</b>
    </div>
  `;

  const elStatus = panel.querySelector("#tmStatus");
  const btnSync = panel.querySelector("#tmSync");
  const btnNow = panel.querySelector("#tmNow");
  const btnClose = panel.querySelector("#tmClose");

  function setStatus(ok, msg) {
    if (!STATE.syncing) {
      elStatus.textContent = `SYNC: OFF | ${msg || ""}`.trim();
      btnSync.textContent = "SYNC: OFF";
      btnSync.style.background = "#6b7280";
      return;
    }

    if (ok) {
      elStatus.textContent = msg;
      btnSync.textContent = "SYNC: ON";
      btnSync.style.background = "#1c84c6";
    } else {
      elStatus.textContent = `ERRO: ${msg}`;
      btnSync.textContent = "SYNC: ON";
      btnSync.style.background = "#ef4444";
    }
  }

  btnMenu.onclick = () => {
    panel.style.display = (panel.style.display === "none" ? "block" : "none");
  };
  btnClose.onclick = () => (panel.style.display = "none");

  btnSync.onclick = () => {
    STATE.syncing = !STATE.syncing;
    setStatus(true, "toggle");
  };

  btnNow.onclick = () => {
    if (!STATE.syncing) STATE.syncing = true;
    tickFetchAndInject(true);
  };

  // ======================
  // GM REQUEST
  // ======================
  function gmGetJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        onload: (res) => {
          try { resolve(JSON.parse(res.responseText)); }
          catch { reject(new Error("Resposta não é JSON")); }
        },
        onerror: () => reject(new Error("Falha na requisição (GM)")),
      });
    });
  }

  function buildUrlNoCache(base) {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}t=${Date.now()}`;
  }

  async function fetchMap() {
    if (!STATE.syncing) return false;

    const url = buildUrlNoCache(WEBAPP_URL);

    const t0 = performance.now();
    const j = await gmGetJson(url);
    const t1 = performance.now();

    STATE.lastRaw = j;
    STATE.lastMsFetch = Math.round(t1 - t0);

    if (!j.ok) throw new Error(j.error || "WebApp ok=false");
    if (!j.map || typeof j.map !== "object") throw new Error("WebApp não retornou map");

    STATE.lastMap = j.map;
    STATE.lastMapCount = Object.keys(j.map).length;
    STATE.lastFetch = new Date().toISOString();
    STATE.lastError = null;

    return true;
  }

  // ======================
  // DOM / INJEÇÃO
  // ======================
  function findTable() {
    return (
      document.querySelector(".ibox-content table.table.table-stripped") ||
      document.querySelector("table.table.table-stripped") ||
      document.querySelector("table")
    );
  }

  function getMainRows(table) {
    // ✅ só linhas principais (evita “lixo” do expandir)
    return [...table.querySelectorAll("tbody tr.tr-index:not(.expandir)")];
  }

  function ensureBadge(anchorEl) {
    let badge = anchorEl.parentNode.querySelector(".tm-op-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "tm-op-badge";
      badge.style.cssText =
        "display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;" +
        "background:#111827;color:#fff;font-size:11px;font-weight:900;vertical-align:middle;";
      anchorEl.parentNode.appendChild(badge);
    }
    return badge;
  }

  function clearPaint(tr, anchorEl) {
    const td = anchorEl?.closest("td");
    if (td) td.style.boxShadow = "";
  }

  function applyPaint(anchorEl, color) {
    const td = anchorEl?.closest("td");
    if (PAINT_BAR && td) td.style.boxShadow = `inset 6px 0 0 ${color}`;
  }

  function injectOnce() {
    if (!STATE.syncing) return 0;

    const map = STATE.lastMap || {};
    const table = findTable();
    if (!table) return 0;

    const trs = getMainRows(table);

    const t0 = performance.now();

    let injected = 0;
    let seen = 0;

    for (const tr of trs) {
      seen++;
      if (seen > MAX_ROWS) break;

      const firstTd = tr.querySelector("td");
      const p = firstTd?.querySelector("p");
      const id = onlyDigits(p?.textContent || "");
      if (!id) continue;

      const op = map[id] || "";
      if (!op && !SHOW_UNASSIGNED) {
        const old = p.parentNode.querySelector(".tm-op-badge");
        if (old) old.remove();
        clearPaint(tr, p);
        continue;
      }

      const nextText = op || "—";
      const color = colorForOperator(op);

      const badge = ensureBadge(p);
      const prevOp = badge.getAttribute("data-op") || "";

      // atualiza só quando precisa
      if (prevOp !== op || badge.textContent !== nextText) {
        badge.textContent = nextText;
        badge.setAttribute("data-op", op);
        injected++;
      }

      // aplica cor sempre (sem custo pesado)
      if (PAINT_BADGE) {
        badge.style.background = color;
        badge.style.color = "#fff";
      } else {
        badge.style.background = "#111827";
        badge.style.color = "#fff";
      }

      applyPaint(p, color);
    }

    const t1 = performance.now();
    STATE.lastInjected = injected;
    STATE.lastInject = new Date().toISOString();
    STATE.lastMsInject = Math.round(t1 - t0);

    if (!STATE.lastError) {
      setStatus(true, `ids:${STATE.lastMapCount} | inj:${injected} | ${STATE.lastMsFetch}ms/${STATE.lastMsInject}ms`);
    }

    return injected;
  }

  // throttling de injeção (pra não travar quando a tabela “re-renderiza”)
  let injectScheduled = false;
  function scheduleInjectSoon() {
    if (injectScheduled) return;
    injectScheduled = true;

    requestAnimationFrame(() => {
      injectScheduled = false;
      injectOnce();
    });
  }

  // MutationObserver: se a tabela mudar (filtro, paginação, expandir…), injeta na hora
  function attachObserver() {
    const table = findTable();
    const tbody = table?.querySelector("tbody");
    if (!tbody) return;

    const obs = new MutationObserver(() => {
      // evita loop: nossa própria badge altera o DOM -> throttling resolve
      scheduleInjectSoon();
    });

    obs.observe(tbody, { childList: true, subtree: true });
  }

  // ======================
  // CSV (limpo)
  // ======================
  function exportCsv() {
  const table = findTable();
  if (!table) { alert("Não achei a tabela."); return; }

  const map = STATE.lastMap || {};

  // ✅ só linhas principais (as expandir também são tr-index, então filtramos)
  const trs = [...table.querySelectorAll("tbody tr.tr-index:not(.expandir)")];

  // ✅ SEM colunas novas
  const header = ["id","descricao","documento","fornecedor","emissao","vencimento","valor","operador"];
  const lines = [header.map(q).join(";")];

  let count = 0;

  for (const tr of trs) {
    // ✅ ID só se tiver <p> dentro do 1º td
    const firstTd = tr.querySelector("td");
    const p = firstTd?.querySelector("p");
    const id = onlyDigits(p?.textContent || "");
    if (!id) continue;

    const tds = tr.querySelectorAll("td");

    // descricao
    const descricao = clean(tds[1]?.innerText);

    // documento (pega texto do primeiro span do documento)
    const docSpan = tds[2]?.querySelector("span");
    let documento = clean(docSpan?.innerText || tds[2]?.innerText);

    // ✅ ATIVO (ícone sitemap dentro do TD do documento)
    const isAtivo = !!tds[2]?.querySelector("i.fa-sitemap, i.fa.fa-sitemap");
    if (isAtivo) documento = documento ? `${documento}\nAtivo` : "Ativo";


    // fornecedor (pega só o nome, sem o badge)
    const fornNameSpan =
      tds[3]?.querySelector('span[data-toggle="tooltip"]') ||
      tds[3]?.querySelector("span");
    let fornecedor = clean(fornNameSpan?.innerText || tds[3]?.innerText);

    // ✅ PGTO ANTECIPADO (badge no TD fornecedor)
    const badgesForn = [...(tds[3]?.querySelectorAll("span.badge") || [])];
    const isPgtoAntecipado = badgesForn.some(b => /pgto\s*antecipado/i.test(clean(b.textContent)));
    if (isPgtoAntecipado) fornecedor = fornecedor ? `${fornecedor}\nPgto Antecipado` : "Pgto Antecipado";


    // emissao/vencimento
    const bTags = tds[4]?.querySelectorAll("b") || [];
    const emissao = clean(bTags[0]?.innerText);
    const vencimento = clean(bTags[1]?.innerText);

    // valor
    const valor = clean(tds[5]?.innerText);

    // operador (map)
    const operador = clean(map[id] || "");

    lines.push([id, descricao, documento, fornecedor, emissao, vencimento, valor, operador].map(q).join(";"));

    count++;
    if (count >= 800) break;
  }

  // ✅ UTF-8 com BOM (Excel não zoa acento)
  const csv = "\uFEFF" + lines.join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "despesas.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
}


  btnCSV.onclick = exportCsv;

  // ======================
  // LOOP
  // ======================
  let inFlight = false;

  async function tickFetchAndInject(force = false) {
    if (!STATE.syncing) return;
    if (inFlight && !force) return;

    inFlight = true;
    try {
      const ok = await fetchMap();
      if (ok) scheduleInjectSoon();
    } catch (e) {
      STATE.lastError = e.message || String(e);
      setStatus(false, STATE.lastError);
    } finally {
      inFlight = false;
    }
  }

  // START
  setStatus(true, "iniciando…");
  attachObserver();
  tickFetchAndInject(true);

  setInterval(() => tickFetchAndInject(false), FETCH_MS);
})();

