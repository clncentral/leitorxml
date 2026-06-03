// ==UserScript==
// @name         InfraDesk Despesas ↔ Planilha Realtime Firebase
// @namespace    clncentral/infradesk
// @version      2.0.0
// @description  Operadores em tempo real via Firebase. Consulta inicial uma vez, mantém cache local e atualiza só a linha alterada.
// @match        https://asp.infradesk.app/backend/despesas*
// @match        https://asp.infradesk.app/backend/despesas/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      infradesk-operadores-default-rtdb.firebaseio.com
// @updateURL    https://clncentral.github.io/leitorxml/script/tamperMonkey.js
// @downloadURL  https://clncentral.github.io/leitorxml/script/tamperMonkey.js
// ==/UserScript==

(function () {
  'use strict';

  var InfraDeskDespesas = {};

  InfraDeskDespesas.WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbw0DAs66VxKu_X5A1s2bCaxbPC6hRSYEg-7EG2hhnD4aA23P3GkMTw6uAuFdbIFpdNPPg/exec';
  InfraDeskDespesas.SECRET = 'ksjddhasodiahsdlka';
  InfraDeskDespesas.FIREBASE_DB_URL = 'https://infradesk-operadores-default-rtdb.firebaseio.com';

  InfraDeskDespesas.MAX_BATCH_POST = 300;
  InfraDeskDespesas.MOSTRAR_SEM_OPERADOR = false;
  InfraDeskDespesas.DEBOUNCE_HTML_MS = 500;

  InfraDeskDespesas.CORES_FIXAS_POR_OPERADOR = {
    "Elias Araujo": "#0324ff",
    "Camily": "#e6cff2",
    "Elia Maria": "#962bcc",
    "Patricia": "#ff8e03"
  };

  InfraDeskDespesas.state = {
    started: false,
    inFlight: false,
    ownMutation: false,
    observer: null,
    debounceTimer: null,
    eventSource: null,
    operatorsCache: {},
    knownIds: new Set(),
    lastFirebaseTs: 0
  };

  InfraDeskDespesas.toast = function (tipo, msg) {
    try {
      if (window.toastr && typeof window.toastr[tipo] === 'function') {
        window.toastr[tipo](msg);
        return;
      }
    } catch (_) {}

    console.log(`[Sigma] ${String(tipo).toUpperCase()}: ${msg}`);
  };

  InfraDeskDespesas.ok = function (m) {
    InfraDeskDespesas.toast('success', m);
  };

  InfraDeskDespesas.info = function (m) {
    InfraDeskDespesas.toast('info', m);
  };

  InfraDeskDespesas.warn = function (m) {
    InfraDeskDespesas.toast('warning', m);
  };

  InfraDeskDespesas.err = function (m) {
    InfraDeskDespesas.toast('error', m);
  };

  InfraDeskDespesas.clean = function (s) {
    return String(s ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  InfraDeskDespesas.onlyDigits = function (s) {
    return (String(s ?? '').match(/\d+/g) || []).join('');
  };

  InfraDeskDespesas.normName = function (s) {
    return InfraDeskDespesas.clean(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  };

  InfraDeskDespesas.CORES_FIXAS_NORM = Object.fromEntries(
    Object.entries(InfraDeskDespesas.CORES_FIXAS_POR_OPERADOR).map(([k, v]) => [
      InfraDeskDespesas.normName(k),
      v
    ])
  );

  InfraDeskDespesas.hashHue = function (str) {
    let h = 0;

    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) | 0;
    }

    return Math.abs(h) % 360;
  };

  InfraDeskDespesas.colorForOperator = function (op) {
    const key = InfraDeskDespesas.normName(op);

    if (!key) return '#111827';
    if (InfraDeskDespesas.CORES_FIXAS_NORM[key]) return InfraDeskDespesas.CORES_FIXAS_NORM[key];

    const hue = InfraDeskDespesas.hashHue(key);
    return `hsl(${hue} 70% 38%)`;
  };

  InfraDeskDespesas.absUrl = function (href) {
    try {
      return new URL(href, location.href).toString();
    } catch (_) {
      return null;
    }
  };

  InfraDeskDespesas.gmJson = function (method, url, bodyObj) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: bodyObj ? { 'Content-Type': 'application/json' } : {},
        data: bodyObj ? JSON.stringify(bodyObj) : null,
        onload: function (res) {
          try {
            const data = JSON.parse(res.responseText || '{}');
            resolve({ status: res.status, data });
          } catch (_) {
            reject(new Error('Resposta inválida do WebApp.'));
          }
        },
        onerror: function () {
          reject(new Error('Falha de rede ao falar com o WebApp.'));
        }
      });
    });
  };

  InfraDeskDespesas.fetchHtml = async function (url) {
    const r = await fetch(url, {
      credentials: 'include',
      cache: 'no-store'
    });

    if (!r.ok) {
      throw new Error(`Falha ao abrir a página (${r.status}). Você está logado?`);
    }

    return await r.text();
  };

  InfraDeskDespesas.injectCss = function () {
    if (document.getElementById('sigmaDeskCss')) return;

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
  width:380px; border-radius:14px;
  background:rgba(17,24,39,.98);
  border:1px solid rgba(255,255,255,.12);
  box-shadow:0 14px 34px rgba(0,0,0,.35);
  padding:10px;
  display:none;
}
#sigmaDotsPanel .ttl{
  font-size:12px;
  color:rgba(232,236,241,.85);
  margin:6px 8px 10px;
}
#sigmaDotsPanel .sub{
  font-size:11px;
  line-height:1.35;
  color:rgba(232,236,241,.62);
  margin:0 8px 10px;
}
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
#sigmaDotsPanel button:hover{
  background:rgba(255,255,255,.08);
}
.tm-op-badge{
  display:inline-flex;
  align-items:center;
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
    style.id = 'sigmaDeskCss';
    style.textContent = css;
    document.head.appendChild(style);
  };

  InfraDeskDespesas.buildMenu = function () {
    if (document.getElementById('sigmaDotsBtn')) return;

    InfraDeskDespesas.injectCss();

    const btn = document.createElement('div');
    btn.id = 'sigmaDotsBtn';
    btn.textContent = '⋯';

    const panel = document.createElement('div');
    panel.id = 'sigmaDotsPanel';

    panel.innerHTML = `
      <div class="ttl">Sigma • Despesas ↔ Planilha Realtime</div>
      <div class="sub">Consulta inicial uma vez. Depois recebe alteração do Firebase e muda só a linha alterada.</div>
      <button data-act="sync">📥 Limpar H vazia + enviar páginas + ordenar vencimento</button>
      <button data-act="ops">👤 Recarregar operadores da planilha agora</button>
      <button data-act="realtime">⚡ Reconectar Firebase</button>
    `;

    btn.addEventListener('click', function () {
      panel.style.display = panel.style.display === 'none' || !panel.style.display ? 'block' : 'none';
    });

    panel.addEventListener('click', async function (e) {
      const b = e.target.closest('button[data-act]');
      if (!b) return;

      const act = b.getAttribute('data-act');

      try {
        if (act === 'sync') {
          await InfraDeskDespesas.actionSyncAll();
        }

        if (act === 'ops') {
          await InfraDeskDespesas.loadInitialOperators(true);
        }

        if (act === 'realtime') {
          InfraDeskDespesas.connectFirebaseRealtime(true);
        }
      } catch (ex) {
        InfraDeskDespesas.err(String(ex?.message || ex));
      }
    });

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    document.addEventListener('click', function (e) {
      const inside = e.target.closest('#sigmaDotsPanel') || e.target.closest('#sigmaDotsBtn');
      if (!inside) panel.style.display = 'none';
    });
  };

  InfraDeskDespesas.findTableIn = function (root) {
    return (
      root.querySelector('.ibox-content table.table.table-stripped') ||
      root.querySelector('table.table.table-stripped') ||
      root.querySelector('table')
    );
  };

  InfraDeskDespesas.getMainRows = function (root) {
    const table = InfraDeskDespesas.findTableIn(root);
    if (!table) return [];

    let trs = [...table.querySelectorAll('tbody tr.tr-index:not(.expandir)')];

    if (!trs.length) {
      trs = [...table.querySelectorAll('tbody tr')];
    }

    return trs;
  };

  InfraDeskDespesas.getIdFromRow = function (tr) {
    if (!tr) return null;

    const cached = tr.getAttribute('data-sigma-id');
    if (cached) return cached;

    const firstTd = tr.querySelector('td');
    const p = firstTd?.querySelector('p');
    const id1 = InfraDeskDespesas.onlyDigits(p?.textContent || '');

    if (id1) {
      tr.setAttribute('data-sigma-id', id1);
      return id1;
    }

    const any = tr.querySelectorAll('[onclick]');

    for (const el of any) {
      const oc = el.getAttribute('onclick') || '';
      const m = oc.match(/abrirSolicitacao\s*\(\s*(\d+)\s*\)/i);

      if (m) {
        tr.setAttribute('data-sigma-id', m[1]);
        return m[1];
      }
    }

    const m2 = (tr.innerHTML || '').match(/abrirSolicitacao\s*\(\s*(\d+)\s*\)/i);
    const id2 = m2 ? m2[1] : null;

    if (id2) {
      tr.setAttribute('data-sigma-id', id2);
    }

    return id2;
  };

  InfraDeskDespesas.extrairEmissaoVencimento = function (td) {
    if (!td) return { emissao: '', vencimento: '' };

    const bs = [...td.querySelectorAll('b')]
      .map(function (b) {
        return InfraDeskDespesas.clean(b.textContent);
      })
      .filter(Boolean);

    const reData = /\b\d{2}\/\d{2}\/\d{4}\b/;

    if (bs.length >= 2 && reData.test(bs[0]) && reData.test(bs[1])) {
      return {
        emissao: bs[0],
        vencimento: bs[1]
      };
    }

    const txt = InfraDeskDespesas.clean(td.innerText || td.textContent || '');
    const matches = txt.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) || [];

    if (matches.length >= 2) {
      return {
        emissao: matches[0],
        vencimento: matches[1]
      };
    }

    if (matches.length === 1) {
      return {
        emissao: matches[0],
        vencimento: ''
      };
    }

    const parts = (td.innerText || '')
      .split('\n')
      .map(InfraDeskDespesas.clean)
      .filter(Boolean);

    if (parts.length >= 2) {
      return {
        emissao: parts[0],
        vencimento: parts[1]
      };
    }

    return {
      emissao: txt,
      vencimento: ''
    };
  };

  InfraDeskDespesas.parseRow = function (tr) {
    const tds = [...tr.querySelectorAll('td')];
    const id = InfraDeskDespesas.getIdFromRow(tr);

    if (!id) return null;

    const descricaoTd = tds[1];
    const docTd = tds[2];
    const fornTd = tds[3];
    const datasTd = tds[4];
    const valorTd = tds[5];

    const descricao = InfraDeskDespesas.clean(descricaoTd?.innerText);

    let documento = InfraDeskDespesas.clean(docTd?.innerText);
    const isAtivo = !!docTd?.querySelector('i.fa-sitemap, i.fa.fa-sitemap');

    if (isAtivo) {
      documento = documento ? `${documento}\nAtivo` : 'Ativo';
    }

    let fornecedor = InfraDeskDespesas.clean(fornTd?.innerText);
    const badgesForn = [...(fornTd?.querySelectorAll('span.badge') || [])];
    const isPgtoAntecipado = badgesForn.some(function (b) {
      return /pgto\s*antecipado/i.test(InfraDeskDespesas.clean(b.textContent));
    });

    if (isPgtoAntecipado) {
      fornecedor = fornecedor ? `${fornecedor}\nPgto Antecipado` : 'Pgto Antecipado';
    }

    let emissao = '';
    let vencimento = '';

    if (datasTd) {
      const dv = InfraDeskDespesas.extrairEmissaoVencimento(datasTd);
      emissao = dv.emissao;
      vencimento = dv.vencimento;
    }

    const valor = InfraDeskDespesas.clean(valorTd?.innerText);

    return {
      id,
      descricao,
      documento,
      fornecedor,
      emissao,
      vencimento,
      valor
    };
  };

  InfraDeskDespesas.pageNumFromUrl = function (u) {
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
  };

  InfraDeskDespesas.getAllPageUrlsFromDocument = function (doc) {
    const urls = new Map();
    const here = location.href;

    urls.set(here, InfraDeskDespesas.pageNumFromUrl(here));

    const pagers = doc.querySelectorAll(
      '.pagination a[href], ul.pagination a[href], .paginator a[href], a[href*="page"], a[href*="pagina"]'
    );

    pagers.forEach(function (a) {
      const u = InfraDeskDespesas.absUrl(a.getAttribute('href'));

      if (!u) return;
      if (!u.includes('/backend/despesas')) return;

      urls.set(u, InfraDeskDespesas.pageNumFromUrl(u));
    });

    return [...urls.entries()]
      .sort(function (a, b) {
        return a[1] - b[1];
      })
      .map(function ([u]) {
        return u;
      });
  };

  InfraDeskDespesas.actionSyncAll = async function () {
    if (!InfraDeskDespesas.WEBAPP_URL.includes('/exec')) {
      throw new Error('Cole a URL do WebApp terminando com /exec.');
    }

    const pageUrls = InfraDeskDespesas.getAllPageUrlsFromDocument(document);

    if (!pageUrls.length) {
      throw new Error('Não encontrei paginação aqui.');
    }

    InfraDeskDespesas.info(`Vou ler ${pageUrls.length} página(s)...`);

    const all = [];
    const byId = new Set();

    for (let i = 0; i < pageUrls.length; i++) {
      InfraDeskDespesas.info(`Lendo página ${i + 1} de ${pageUrls.length}...`);

      const html = await InfraDeskDespesas.fetchHtml(pageUrls[i]);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const trs = InfraDeskDespesas.getMainRows(doc);

      for (const tr of trs) {
        const r = InfraDeskDespesas.parseRow(tr);

        if (!r) continue;
        if (byId.has(r.id)) continue;

        byId.add(r.id);
        all.push(r);
      }
    }

    if (!all.length) {
      InfraDeskDespesas.warn('Não consegui capturar nenhum registro.');
      return;
    }

    InfraDeskDespesas.info(`Coleta finalizada: ${all.length} registro(s).`);
    InfraDeskDespesas.info('Limpando da planilha as linhas com coluna H vazia...');

    const purgeRes = await InfraDeskDespesas.gmJson('POST', InfraDeskDespesas.WEBAPP_URL, {
      secret: InfraDeskDespesas.SECRET,
      action: 'purge_empty_h'
    });

    if (!purgeRes.data?.ok) {
      throw new Error(purgeRes.data?.error || 'Erro ao limpar linhas com coluna H vazia.');
    }

    const purgedTotal = Number(purgeRes.data.removed || 0);

    InfraDeskDespesas.info('Enviando registros em lotes para a planilha...');

    let insertedTotal = 0;
    let skippedTotal = 0;

    for (let i = 0; i < all.length; i += InfraDeskDespesas.MAX_BATCH_POST) {
      const chunk = all.slice(i, i + InfraDeskDespesas.MAX_BATCH_POST);

      const res = await InfraDeskDespesas.gmJson('POST', InfraDeskDespesas.WEBAPP_URL, {
        secret: InfraDeskDespesas.SECRET,
        rows: chunk
      });

      if (!res.data?.ok) {
        throw new Error(res.data?.error || 'Erro ao inserir na planilha.');
      }

      insertedTotal += Number(res.data.inserted || 0);
      skippedTotal += Number(res.data.skipped || 0);
    }

    InfraDeskDespesas.info('Organizando a planilha com vencimento()...');

    const sortRes = await InfraDeskDespesas.gmJson('POST', InfraDeskDespesas.WEBAPP_URL, {
      secret: InfraDeskDespesas.SECRET,
      action: 'run_vencimento'
    });

    if (!sortRes.data?.ok) {
      InfraDeskDespesas.warn(`Importação concluída, mas vencimento() falhou: ${sortRes.data?.error || 'erro desconhecido'}`);
    } else if (sortRes.data?.vencimento_ok === false) {
      InfraDeskDespesas.warn(`Importação concluída, mas vencimento() não rodou: ${sortRes.data?.vencimento_error || 'função não encontrada'}`);
    }

    InfraDeskDespesas.ok(`Planilha atualizada! Removidos H vazio: ${purgedTotal} | Inseridos: ${insertedTotal} | Ignorados: ${skippedTotal}`);

    await InfraDeskDespesas.loadInitialOperators(false);
  };

  InfraDeskDespesas.ensureBadge = function (pEl) {
    let badge = pEl.parentNode.querySelector('.tm-op-badge');

    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tm-op-badge';
      pEl.parentNode.appendChild(badge);
    }

    return badge;
  };

  InfraDeskDespesas.clearOperatorFromRow = function (tr) {
    if (!tr) return;

    const firstTd = tr.querySelector('td');
    const p = firstTd?.querySelector('p');

    if (!p) return;

    const old = p.parentNode.querySelector('.tm-op-badge');

    if (old) {
      old.remove();
    }

    const td = p.closest('td');

    if (td) {
      td.style.boxShadow = '';
    }
  };

  InfraDeskDespesas.paintOperatorOnRow = function (tr, operador) {
    if (!tr) return;

    const firstTd = tr.querySelector('td');
    const p = firstTd?.querySelector('p');

    if (!p) return;

    const op = InfraDeskDespesas.clean(operador);

    if (!op && !InfraDeskDespesas.MOSTRAR_SEM_OPERADOR) {
      InfraDeskDespesas.clearOperatorFromRow(tr);
      return;
    }

    const badge = InfraDeskDespesas.ensureBadge(p);
    const cor = InfraDeskDespesas.colorForOperator(op);
    const label = op || '—';

    if (badge.textContent !== label) {
      badge.textContent = label;
    }

    if (badge.style.background !== cor) {
      badge.style.background = cor;
    }

    if (badge.style.color !== 'rgb(255, 255, 255)') {
      badge.style.color = '#fff';
    }

    const td = p.closest('td');
    const next = `inset 6px 0 0 ${cor}`;

    if (td && td.style.boxShadow !== next) {
      td.style.boxShadow = next;
    }
  };

  InfraDeskDespesas.getRowsById = function (id) {
    id = InfraDeskDespesas.clean(id);
    if (!id) return [];

    const rows = InfraDeskDespesas.getMainRows(document);
    const found = [];

    for (const tr of rows) {
      const rowId = InfraDeskDespesas.getIdFromRow(tr);

      if (rowId === id) {
        found.push(tr);
      }
    }

    return found;
  };

  InfraDeskDespesas.updateSingleOperator = function (id, operador) {
    id = InfraDeskDespesas.clean(id);
    operador = InfraDeskDespesas.clean(operador);

    if (!id) return 0;

    if (operador) {
      InfraDeskDespesas.state.operatorsCache[id] = operador;
    } else {
      delete InfraDeskDespesas.state.operatorsCache[id];
    }

    const rows = InfraDeskDespesas.getRowsById(id);

    InfraDeskDespesas.state.ownMutation = true;

    try {
      for (const tr of rows) {
        InfraDeskDespesas.paintOperatorOnRow(tr, operador);
      }
    } finally {
      setTimeout(function () {
        InfraDeskDespesas.state.ownMutation = false;
      }, 100);
    }

    return rows.length;
  };

  InfraDeskDespesas.paintAllFromCache = function () {
    const trs = InfraDeskDespesas.getMainRows(document);
    let count = 0;

    InfraDeskDespesas.state.ownMutation = true;

    try {
      for (const tr of trs) {
        const id = InfraDeskDespesas.getIdFromRow(tr);

        if (!id) continue;

        InfraDeskDespesas.state.knownIds.add(id);

        const operador = InfraDeskDespesas.state.operatorsCache[id] || '';
        InfraDeskDespesas.paintOperatorOnRow(tr, operador);

        count++;
      }
    } finally {
      setTimeout(function () {
        InfraDeskDespesas.state.ownMutation = false;
      }, 100);
    }

    return count;
  };

  InfraDeskDespesas.getCurrentIds = function () {
    const trs = InfraDeskDespesas.getMainRows(document);
    const ids = [];

    for (const tr of trs) {
      const id = InfraDeskDespesas.getIdFromRow(tr);

      if (id) {
        ids.push(id);
      }
    }

    return [...new Set(ids)];
  };

  InfraDeskDespesas.getOperadoresUrl = function (ids) {
    const idsKey = ids.join(',');
    const params = [];

    params.push('ids=' + encodeURIComponent(idsKey));
    params.push('nocache=1');
    params.push('_tm=' + encodeURIComponent(String(Date.now())));

    return InfraDeskDespesas.WEBAPP_URL +
      (InfraDeskDespesas.WEBAPP_URL.includes('?') ? '&' : '?') +
      params.join('&');
  };

  InfraDeskDespesas.loadInitialOperators = async function (manual) {
    if (InfraDeskDespesas.state.inFlight) return;

    const ids = InfraDeskDespesas.getCurrentIds();

    if (!ids.length) {
      if (manual) {
        InfraDeskDespesas.warn('Não encontrei registros nesta página.');
      }

      return;
    }

    InfraDeskDespesas.state.inFlight = true;

    try {
      const url = InfraDeskDespesas.getOperadoresUrl(ids);
      const res = await InfraDeskDespesas.gmJson('GET', url, null);

      if (!res.data?.ok) {
        throw new Error(res.data?.error || 'Erro ao buscar Operadores na planilha.');
      }

      const map = res.data.map || {};
      Object.assign(InfraDeskDespesas.state.operatorsCache, map);

      for (const id of ids) {
        InfraDeskDespesas.state.knownIds.add(id);
        if (!map[id] && !InfraDeskDespesas.state.operatorsCache[id]) {
          delete InfraDeskDespesas.state.operatorsCache[id];
        }
      }

      const painted = InfraDeskDespesas.paintAllFromCache();

      if (manual) {
        InfraDeskDespesas.ok(`Operadores recarregados: ${painted} linha(s).`);
      }
    } catch (ex) {
      if (manual) {
        InfraDeskDespesas.err(String(ex?.message || ex));
      }
    } finally {
      InfraDeskDespesas.state.inFlight = false;
    }
  };

  InfraDeskDespesas.fetchMissingIdsOnly = async function (ids) {
    const missing = ids.filter(function (id) {
      return !Object.prototype.hasOwnProperty.call(InfraDeskDespesas.state.operatorsCache, id);
    });

    if (!missing.length) {
      InfraDeskDespesas.paintAllFromCache();
      return;
    }

    if (InfraDeskDespesas.state.inFlight) {
      InfraDeskDespesas.paintAllFromCache();
      return;
    }

    InfraDeskDespesas.state.inFlight = true;

    try {
      const url = InfraDeskDespesas.getOperadoresUrl(missing);
      const res = await InfraDeskDespesas.gmJson('GET', url, null);

      if (res.data?.ok) {
        const map = res.data.map || {};

        for (const id of missing) {
          if (map[id]) {
            InfraDeskDespesas.state.operatorsCache[id] = map[id];
          } else {
            InfraDeskDespesas.state.operatorsCache[id] = '';
          }
        }
      }

      InfraDeskDespesas.paintAllFromCache();
    } finally {
      InfraDeskDespesas.state.inFlight = false;
    }
  };

  InfraDeskDespesas.scheduleHtmlUpdate = function () {
    clearTimeout(InfraDeskDespesas.state.debounceTimer);

    InfraDeskDespesas.state.debounceTimer = setTimeout(function () {
      const ids = InfraDeskDespesas.getCurrentIds();

      for (const id of ids) {
        InfraDeskDespesas.state.knownIds.add(id);
      }

      InfraDeskDespesas.fetchMissingIdsOnly(ids);
    }, InfraDeskDespesas.DEBOUNCE_HTML_MS);
  };

  InfraDeskDespesas.attachObserver = function () {
    const table = InfraDeskDespesas.findTableIn(document);
    const tbody = table?.querySelector('tbody');

    if (!tbody) return;

    if (InfraDeskDespesas.state.observer) {
      InfraDeskDespesas.state.observer.disconnect();
      InfraDeskDespesas.state.observer = null;
    }

    InfraDeskDespesas.state.observer = new MutationObserver(function (mutations) {
      if (InfraDeskDespesas.state.ownMutation) return;

      const relevant = mutations.some(function (m) {
        if (m.type !== 'childList') return false;

        const added = [...m.addedNodes].some(function (n) {
          if (n.nodeType !== 1) return false;
          if (n.classList?.contains('tm-op-badge')) return false;
          return true;
        });

        const removed = [...m.removedNodes].some(function (n) {
          if (n.nodeType !== 1) return false;
          if (n.classList?.contains('tm-op-badge')) return false;
          return true;
        });

        return added || removed;
      });

      if (!relevant) return;

      InfraDeskDespesas.scheduleHtmlUpdate();
    });

    InfraDeskDespesas.state.observer.observe(tbody, {
      childList: true,
      subtree: false
    });
  };

  InfraDeskDespesas.firebaseStreamUrl = function () {
    return InfraDeskDespesas.FIREBASE_DB_URL.replace(/\/+$/, '') + '/despesas_updates/latest.json';
  };

  InfraDeskDespesas.handleFirebaseEvent = function (raw) {
    let parsed;

    try {
      parsed = JSON.parse(raw || '{}');
    } catch (_) {
      return;
    }

    const data = parsed && Object.prototype.hasOwnProperty.call(parsed, 'data')
      ? parsed.data
      : parsed;

    if (!data || typeof data !== 'object') return;

    const id = InfraDeskDespesas.clean(data.id);
    const operador = InfraDeskDespesas.clean(data.operador);
    const ts = Number(data.ts || 0);

    if (!id) return;

    if (ts && ts < InfraDeskDespesas.state.lastFirebaseTs) {
      return;
    }

    if (ts) {
      InfraDeskDespesas.state.lastFirebaseTs = ts;
    }

    InfraDeskDespesas.updateSingleOperator(id, operador);
  };

  InfraDeskDespesas.connectFirebaseRealtime = function (manual) {
    try {
      if (InfraDeskDespesas.state.eventSource) {
        InfraDeskDespesas.state.eventSource.close();
        InfraDeskDespesas.state.eventSource = null;
      }

      const es = new EventSource(InfraDeskDespesas.firebaseStreamUrl());

      es.addEventListener('put', function (event) {
        InfraDeskDespesas.handleFirebaseEvent(event.data);
      });

      es.addEventListener('patch', function (event) {
        InfraDeskDespesas.handleFirebaseEvent(event.data);
      });

      es.onerror = function () {
        console.warn('[Sigma] Firebase realtime desconectou. O navegador tentará reconectar automaticamente.');
      };

      InfraDeskDespesas.state.eventSource = es;

      if (manual) {
        InfraDeskDespesas.ok('Firebase realtime reconectado.');
      }
    } catch (ex) {
      if (manual) {
        InfraDeskDespesas.err('Erro ao conectar Firebase realtime.');
      }
    }
  };

  InfraDeskDespesas.start = function () {
    if (InfraDeskDespesas.state.started) return;

    InfraDeskDespesas.state.started = true;

    InfraDeskDespesas.buildMenu();
    InfraDeskDespesas.attachObserver();
    InfraDeskDespesas.connectFirebaseRealtime(false);

    setTimeout(function () {
      InfraDeskDespesas.loadInitialOperators(false);
    }, 700);
  };

  if (window.Sahin && typeof window.Sahin.injectFunctionsToPage === 'function') {
    window.Sahin.injectFunctionsToPage(InfraDeskDespesas);
  } else if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.InfraDeskDespesas = InfraDeskDespesas;
  } else {
    window.InfraDeskDespesas = InfraDeskDespesas;
  }

  InfraDeskDespesas.start();

})();
