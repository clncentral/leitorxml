// ==UserScript==
// @name         InfraDesk Despesas ↔ Planilha (AUTO Operador + Cores + Datas separadas)
// @namespace    clncentral/infradesk
// @version      1.2.1
// @description  Envia TODAS as páginas de /backend/despesas pra planilha e injeta Operador automaticamente com cores.
// @match        https://asp.infradesk.app/backend/despesas*
// @match        https://asp.infradesk.app/backend/despesas/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @updateURL    https://clncentral.github.io/leitorxml/script/tamperMonkey.js
// @downloadURL  https://clncentral.github.io/leitorxml/script/tamperMonkey.js
// ==/UserScript==


(function () {
  'use strict';

  // =========================
  // CONFIG (VOCÊ ALTERA AQUI)
  // =========================
  const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwhF1CxlY93-q_e2cl97mFZ1yFN79ztQpAeMVJeL8O0qGiLjwO7x2heOFLJBGG9qwxZZA/exec';
  const SECRET     = 'ksjddhasodiahsdlka';

  // a cada X ms ele busca os operadores desta página e injeta (automático)
  const FETCH_MS = 900;

  // limite de envio por POST (pra ficar rápido e estável)
  const MAX_BATCH_POST = 300;

  // não mostrar nada quando não tem operador (igual antigamente)
  const MOSTRAR_SEM_OPERADOR = false;

  // cores fixas (opcional). Se não bater aqui, ele gera uma cor automática pelo nome.
  const CORES_FIXAS_POR_OPERADOR = {
    "Elias Araujo": "#0324ff",
    "Camily": "#ed5ac1",
    "Elia Maria": "#962bcc",
    "Patricia": "#ff8e03",
  };

  // =========================
  // TOAST (mensagens)
  // =========================
  function toast(tipo, msg) {
    try {
      if (window.toastr && typeof window.toastr[tipo] === 'function') {
        window.toastr[tipo](msg);
        return;
      }
    } catch (_) {}
    console.log(`[Sigma] ${tipo.toUpperCase()}: ${msg}`);
  }
  const ok   = (m) => toast('success', m);
  const info = (m) => toast('info', m);
  const warn = (m) => toast('warning', m);
  const err  = (m) => toast('error', m);

  // =========================
  // HELPERS
  // =========================
  function clean(s) {
    return String(s ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function onlyDigits(s) {
    return (String(s ?? '').match(/\d+/g) || []).join('');
  }

  function normName(s) {
    return clean(s)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  const CORES_FIXAS_NORM = Object.fromEntries(
    Object.entries(CORES_FIXAS_POR_OPERADOR).map(([k, v]) => [normName(k), v])
  );

  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  function colorForOperator(op) {
    const key = normName(op);
    if (!key) return '#111827';
    if (CORES_FIXAS_NORM[key]) return CORES_FIXAS_NORM[key];
    const hue = hashHue(key);
    return `hsl(${hue} 70% 38%)`;
  }

  function absUrl(href) {
    try { return new URL(href, location.href).toString(); }
    catch (_) { return null; }
  }

  // =========================
  // GM REQUEST (JSON)
  // =========================
  function gmJson(method, url, bodyObj) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: bodyObj ? { 'Content-Type': 'application/json' } : {},
        data: bodyObj ? JSON.stringify(bodyObj) : null,
        onload: (res) => {
          try {
            const data = JSON.parse(res.responseText || '{}');
            resolve({ status: res.status, data });
          } catch (_) {
            reject(new Error('Resposta inválida (não é JSON).'));
          }
        },
        onerror: () => reject(new Error('Falha de rede ao falar com o WebApp.')),
      });
    });
  }

  async function fetchHtml(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`Falha ao abrir a página (${r.status}). Você está logado?`);
    return await r.text();
  }

  // =========================
  // UI: só o "⋯" no canto
  // =========================
  function injectCss() {
    const css = `
#sigmaDotsBtn{
  position:fixed; right:14px; bottom:14px; z-index:2147483647;
  width:38px; height:38px; border-radius:12px;
  display:flex; align-items:center; justify-content:center;
  background:rgba(17,24,39,.95);
  border:1px solid rgba(255,255,255,.12);
  box-shadow:0 10px 24px rgba(0,0,0,.28);
  cursor:pointer; user-select:none;
  font-size:20px; color:#e8ecf1;
}
#sigmaDotsPanel{
  position:fixed; right:14px; bottom:60px; z-index:2147483647;
  width:320px; border-radius:14px;
  background:rgba(17,24,39,.98);
  border:1px solid rgba(255,255,255,.12);
  box-shadow:0 14px 34px rgba(0,0,0,.35);
  padding:10px;
  display:none;
}
#sigmaDotsPanel .ttl{ font-size:12px; color:rgba(232,236,241,.85); margin:6px 8px 10px; }
#sigmaDotsPanel button{
  width:100%;
  text-align:left;
  margin:6px 0;
  border:1px solid rgba(255,255,255,.10);
  background:rgba(255,255,255,.05);
  color:#e8ecf1;
  border-radius:12px;
  padding:10px 12px;
  cursor:pointer;
  font-weight:700;
}
#sigmaDotsPanel button:hover{ background:rgba(255,255,255,.08); }

.tm-op-badge{
  display:inline-flex; align-items:center;
  margin-left:8px;
  padding:2px 8px;
  border-radius:999px;
  font-size:11px;
  font-weight:900;
  color:#fff;
  vertical-align:middle;
  box-shadow:0 8px 18px rgba(0,0,0,.20);
}
`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildMenu() {
    injectCss();

    const btn = document.createElement('div');
    btn.id = 'sigmaDotsBtn';
    btn.textContent = '⋯';

    const panel = document.createElement('div');
    panel.id = 'sigmaDotsPanel';
    panel.innerHTML = `
      <div class="ttl">Sigma • Despesas ↔ Planilha</div>
      <button data-act="sync">📥 Enviar TODAS as páginas para a planilha</button>
      <button data-act="ops">👤 Atualizar Operadores agora</button>
    `;

    btn.addEventListener('click', () => {
      panel.style.display = (panel.style.display === 'none' || !panel.style.display) ? 'block' : 'none';
    });

    panel.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.getAttribute('data-act');

      try {
        if (act === 'sync') await actionSyncAll();
        if (act === 'ops')  await atualizarOperadoresEInjetar(false, true);
      } catch (ex) {
        err(String(ex?.message || ex));
      }
    });

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    document.addEventListener('click', (e) => {
      const inside = e.target.closest('#sigmaDotsPanel') || e.target.closest('#sigmaDotsBtn');
      if (!inside) panel.style.display = 'none';
    });
  }

  // =========================
  // DOM: tabela e linhas
  // =========================
  function findTableIn(root) {
    return (
      root.querySelector('.ibox-content table.table.table-stripped') ||
      root.querySelector('table.table.table-stripped') ||
      root.querySelector('table')
    );
  }

  function getMainRows(root) {
    const table = findTableIn(root);
    if (!table) return [];
    let trs = [...table.querySelectorAll('tbody tr.tr-index:not(.expandir)')];
    if (!trs.length) trs = [...table.querySelectorAll('tbody tr')];
    return trs;
  }

  function getIdFromRow(tr) {
    // 1) padrão antigo: primeiro td -> p -> número
    const firstTd = tr.querySelector('td');
    const p = firstTd?.querySelector('p');
    const id1 = onlyDigits(p?.textContent || '');
    if (id1) return id1;

    // 2) fallback: onclick abrirSolicitacao(123)
    const any = tr.querySelectorAll('[onclick]');
    for (const el of any) {
      const oc = el.getAttribute('onclick') || '';
      const m = oc.match(/abrirSolicitacao\s*\(\s*(\d+)\s*\)/i);
      if (m) return m[1];
    }
    const m2 = (tr.innerHTML || '').match(/abrirSolicitacao\s*\(\s*(\d+)\s*\)/i);
    return m2 ? m2[1] : null;
  }

  // =========================
  // Datas: separa Emissão/Vencimento
  // =========================
  function extrairEmissaoVencimento(td) {
    if (!td) return { emissao: '', vencimento: '' };

    // tenta pegar pelos <b> (como seu script antigo)
    const bs = [...td.querySelectorAll('b')].map(b => clean(b.textContent)).filter(Boolean);
    const reData = /\b\d{2}\/\d{2}\/\d{4}\b/;

    if (bs.length >= 2 && reData.test(bs[0]) && reData.test(bs[1])) {
      return { emissao: bs[0], vencimento: bs[1] };
    }

    // tenta achar duas datas no texto
    const txt = clean(td.innerText || td.textContent || '');
    const matches = txt.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) || [];
    if (matches.length >= 2) return { emissao: matches[0], vencimento: matches[1] };
    if (matches.length === 1) return { emissao: matches[0], vencimento: '' };

    // fallback: duas linhas
    const parts = (td.innerText || '').split('\n').map(clean).filter(Boolean);
    if (parts.length >= 2) return { emissao: parts[0], vencimento: parts[1] };

    return { emissao: txt, vencimento: '' };
  }

  // =========================
  // Parse de uma linha -> objeto pra planilha
  // =========================
  function parseRow(tr) {
    const tds = [...tr.querySelectorAll('td')];
    const id = getIdFromRow(tr);
    if (!id) return null;

    // tentativa por posições (padrão InfraDesk)
    const descricaoTd = tds[1];
    const docTd      = tds[2];
    const fornTd     = tds[3];
    const datasTd    = tds[4];
    const valorTd    = tds[5];

    const descricao = clean(descricaoTd?.innerText);

    // documento + "Ativo" (se existir ícone)
    let documento = clean(docTd?.innerText);
    const isAtivo = !!docTd?.querySelector('i.fa-sitemap, i.fa.fa-sitemap');
    if (isAtivo) documento = documento ? `${documento}\nAtivo` : 'Ativo';

    // fornecedor + "Pgto Antecipado" (se existir badge)
    let fornecedor = clean(fornTd?.innerText);
    const badgesForn = [...(fornTd?.querySelectorAll('span.badge') || [])];
    const isPgtoAntecipado = badgesForn.some(b => /pgto\s*antecipado/i.test(clean(b.textContent)));
    if (isPgtoAntecipado) fornecedor = fornecedor ? `${fornecedor}\nPgto Antecipado` : 'Pgto Antecipado';

    // emissão/vencimento (separado)
    let emissao = '';
    let vencimento = '';
    if (datasTd) {
      const dv = extrairEmissaoVencimento(datasTd);
      emissao = dv.emissao;
      vencimento = dv.vencimento;
    }

    const valor = clean(valorTd?.innerText);

    return { id, descricao, documento, fornecedor, emissao, vencimento, valor };
  }

  // =========================
  // Paginação real (só as páginas que existem)
  // =========================
  function pageNumFromUrl(u) {
    try {
      const url = new URL(u);
      const qp = url.searchParams;
      const v = qp.get('page') || qp.get('pagina') || qp.get('p');
      if (v && /^\d+$/.test(v)) return parseInt(v, 10);
      const m = u.match(/(?:page|pagina)[:=](\d+)/i);
      return m ? parseInt(m[1], 10) : 1;
    } catch (_) {
      return 1;
    }
  }

  function getAllPageUrlsFromDocument(doc) {
    const urls = new Map();
    const here = location.href;
    urls.set(here, pageNumFromUrl(here));

    const pagers = doc.querySelectorAll('.pagination a[href], ul.pagination a[href], .paginator a[href], a[href*="page"], a[href*="pagina"]');
    pagers.forEach(a => {
      const u = absUrl(a.getAttribute('href'));
      if (!u) return;
      if (!u.includes('/backend/despesas')) return;
      urls.set(u, pageNumFromUrl(u));
    });

    return [...urls.entries()].sort((a,b) => a[1] - b[1]).map(([u]) => u);
  }

  // =========================
  // AÇÃO: enviar todas as páginas
  // =========================
  async function actionSyncAll() {
    if (!WEBAPP_URL.includes('/exec')) throw new Error('Cole a URL do WebApp (termina com /exec) no Tampermonkey.');

    const pageUrls = getAllPageUrlsFromDocument(document);
    if (!pageUrls.length) throw new Error('Não encontrei paginação aqui.');

    info(`Vou ler ${pageUrls.length} página(s) e mandar pra planilha...`);

    const all = [];
    const byId = new Set();

    for (let i = 0; i < pageUrls.length; i++) {
      info(`Lendo página ${i + 1} de ${pageUrls.length}...`);
      const html = await fetchHtml(pageUrls[i]);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const trs = getMainRows(doc);

      for (const tr of trs) {
        const r = parseRow(tr);
        if (!r) continue;
        if (byId.has(r.id)) continue;
        byId.add(r.id);
        all.push(r);
      }
    }

    if (!all.length) {
      warn('Não consegui capturar nenhum registro.');
      return;
    }

    info(`Coleta finalizada: ${all.length} registro(s). Enviando pra planilha...`);

    let insertedTotal = 0;
    let skippedTotal = 0;

    for (let i = 0; i < all.length; i += MAX_BATCH_POST) {
      const chunk = all.slice(i, i + MAX_BATCH_POST);
      const payload = { secret: SECRET, rows: chunk };

      const res = await gmJson('POST', WEBAPP_URL, payload);
      if (!res.data?.ok) throw new Error(res.data?.error || 'Erro ao inserir na planilha.');

      insertedTotal += (res.data.inserted || 0);
      skippedTotal += (res.data.skipped || 0);
    }

    ok(`Planilha atualizada! Inseridos: ${insertedTotal} | Ignorados: ${skippedTotal}`);

    // depois de enviar, já atualiza/injeta operadores (automaticamente)
    await atualizarOperadoresEInjetar(true, true);
  }

  // =========================
  // INJEÇÃO: operador + cores
  // =========================
  function ensureBadge(pEl) {
    let badge = pEl.parentNode.querySelector('.tm-op-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tm-op-badge';
      pEl.parentNode.appendChild(badge);
    }
    return badge;
  }

  function clearPaint(pEl) {
    const td = pEl?.closest('td');
    if (td) td.style.boxShadow = '';
  }

  function applyPaint(pEl, color) {
    const td = pEl?.closest('td');
    if (td) td.style.boxShadow = `inset 6px 0 0 ${color}`;
  }

  function injetarOperadores(map) {
    const trs = getMainRows(document);
    let injected = 0;

    for (const tr of trs) {
      const tds = tr.querySelectorAll('td');
      const firstTd = tds[0];
      const p = firstTd?.querySelector('p');
      const id = getIdFromRow(tr);
      if (!id || !p) continue;

      const op = map[id] || '';

      // remove quando não tem operador (igual antigamente)
      if (!op && !MOSTRAR_SEM_OPERADOR) {
        const old = p.parentNode.querySelector('.tm-op-badge');
        if (old) old.remove();
        clearPaint(p);
        continue;
      }

      const badge = ensureBadge(p);
      const cor = colorForOperator(op);

      badge.textContent = op || '—'; // só o nome, sem "Operador:"
      badge.style.background = cor;
      badge.style.color = '#fff';

      applyPaint(p, cor);
      injected++;
    }

    return injected;
  }

  // =========================
  // AUTO: busca operadores da página e injeta
  // =========================
  let inFlight = false;

  async function atualizarOperadoresEInjetar(silent, manual) {
    if (inFlight) return;
    inFlight = true;

    try {
      const trs = getMainRows(document);
      const ids = [];
      for (const tr of trs) {
        const id = getIdFromRow(tr);
        if (id) ids.push(id);
      }

      if (!ids.length) {
        if (!silent) warn('Não encontrei registros nesta página.');
        return;
      }

      const url = WEBAPP_URL + (WEBAPP_URL.includes('?') ? '&' : '?') + 'ids=' + encodeURIComponent(ids.join(','));
      const res = await gmJson('GET', url, null);

      if (!res.data?.ok) {
        throw new Error(res.data?.error || 'Erro ao buscar Operadores na planilha.');
      }

      const map = res.data.map || {};
      const inj = injetarOperadores(map);

      // não enche o saco com toast a cada 2 segundos
      if (manual) ok(`Operadores atualizados: ${inj} linha(s).`);

    } finally {
      inFlight = false;
    }
  }

  // re-injeta rápido quando a tabela muda (paginação, filtros, ajax)
  function attachObserver() {
    const table = findTableIn(document);
    const tbody = table?.querySelector('tbody');
    if (!tbody) return;

    const obs = new MutationObserver(() => {
      // injeta com o mapa mais recente (vai buscar no próximo tick também)
      atualizarOperadoresEInjetar(true, false);
    });

    obs.observe(tbody, { childList: true, subtree: true });
  }

  // =========================
  // START
  // =========================
  buildMenu();
  attachObserver();

  // injeta automaticamente quando abre a página
  setTimeout(() => atualizarOperadoresEInjetar(true, false), 900);
  setInterval(() => atualizarOperadoresEInjetar(true, false), FETCH_MS);

  // Turbo: quando você volta pra aba/janela, atualiza IMEDIATO
    window.addEventListener("focus", () => atualizarOperadoresEInjetar(true, false));
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) atualizarOperadoresEInjetar(true, false);
    });


})();



