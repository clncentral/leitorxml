// ==UserScript==
// @name         InfraDesk Doca • Captura + Status Real + Firebase + Ordem Lojas
// @namespace    clncentral/infradesk-doca
// @version      4.0.0
// @description  Painel operacional e Kanban unificados, com reservas em tempo real e baixo consumo do Firebase.
// @author       CLN Central
// @match        https://asp.infradesk.app/backend/chamados*
// @match        https://asp.infradesk.app/backend/chamados/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      infra-doca-default-rtdb.firebaseio.com
// @connect      *.firebasedatabase.app
// @connect      firebasedatabase.app
// @connect      asp.infradesk.app
// @updateURL    https://clncentral.github.io/leitorxml/script/doca.user.js
// @downloadURL  https://clncentral.github.io/leitorxml/script/doca.user.js
// ==/UserScript==

(function () {
  "use strict";

  // Não monta o painel dentro de iframes usados como motor do InfraDesk.
  if (window.top !== window.self) return;

  // =========================================================
  // CONFIGURACAO_PRINCIPAL
  // Para localizar depois, use CTRL + F e procure por:
  // CONFIGURACAO_PRINCIPAL
  // =========================================================
  const CONFIG = {
    versao: "4.0.0",
    parametroPainel: "sigma_painel_doca",
    urlPainel: "/backend/chamados/lista?sigma_painel_doca=1",
    urlFonte: "/backend/chamados/lista",

    // Em trâmites já reúne os status ativos abaixo sem duplicar chamados.
    statusIds: ["2", "3", "5", "6"],
    statusNomes: {
      "2": "Aberto",
      "3": "Em liberação",
      "4": "Finalizado",
      "5": "Reaberto",
      "6": "Em Análise Terceiro",
    },

    // STATUS_DISPONIVEIS_NO_FEEDBACK
    // Para localizar depois, use CTRL + F e procure por:
    // STATUS_DISPONIVEIS_NO_FEEDBACK
    // O painel lista somente chamados ativos, mas o formulário precisa
    // permitir finalizar a solicitação com o status 4.
    feedbackStatusIds: ["5", "2", "3", "6", "4"],

    paginasSimultaneas: 3,
    grupoAtendimentoPadrao: 118,

    // COMPLETAR_NF_E_CHAVE_EM_SEGUNDO_PLANO
    // Quando a lista resumida não entrega os atributos, o painel consulta
    // somente o chamado incompleto e recupera os dados da aba Tags.
    completarDadosNfAusentes: true,
    // Uma consulta complementar por vez evita picos de DOMParser e rede.
    consultasComplementaresSimultaneas: 1,
    cacheComplementoNfMs: 7 * 24 * 60 * 60 * 1000,
    atrasoComplementoNfMs: 1400,
    complementoLoteTamanho: 18,

    firebaseBase: "https://infra-doca-default-rtdb.firebaseio.com",
    firebaseRoot: "doca_capturas",
    // RESERVAS_ATIVAS_ECONOMICAS
    // Para localizar depois, use CTRL + F e procure por:
    // RESERVAS_ATIVAS_ECONOMICAS
    // O histórico completo continua em by_id. O painel escuta somente este
    // caminho pequeno, formado por travas mínimas que expiram após 1 hora.
    firebaseReservasAtivas: "reservas_ativas",
    reservaValidadeMs: 60 * 60 * 1000,

    // INTEGRACOES_XABUIA_COMERCIAL
    // Os loaders oficiais continuam sendo a fonte de autenticação, cache,
    // Firebase e modais. O painel fornece cards-ponte invisíveis e apenas
    // espelha os ícones e as últimas mensagens na tabela.
    xabuiaIcone: "https://chamadossicofe-design.github.io/xabuia/xabuia.png",
    comercialIcone: "https://unix-page.github.io/comercial/comercial.png",

    // INTEGRACOES_LAZY_VIEWPORT
    // Xabuia e Comercial recebem somente os chamados próximos da área visível.
    // Isso evita centenas de cartões ocultos, observers e listeners simultâneos.
    integracoesMaxAtivas: 18,
    integracoesMargemPx: 650,
    integracoesScrollDebounceMs: 140,

    // Atualização automática leve. Zero desativa.
    atualizarAutomaticamenteMs: 2 * 60 * 1000,

    // A empresa informada pelo InfraDesk nem sempre representa a loja real.
    // A organização opcional usa o representante: Recebimento 03, 01 e 05.
    // Dentro de cada loja, SLA mais urgente e chamados mais antigos vêm primeiro.
  };

  const PREFIXO = "[Painel Doca]";
  const urlAtual = new URL(window.location.href);
  const modoPainel = urlAtual.searchParams.get(CONFIG.parametroPainel) === "1";

  if (!modoPainel) {
    instalarBotaoAbrirPainel();
    return;
  }

  ocultarPaginaOriginal();

  const state = {
    chamados: [],
    reservas: {},
    usuario: { nome: "", id: "", login: "" },
    carregando: false,
    renderTimer: null,
    eventSource: null,
    autoTimer: null,
    motorIframe: null,
    motorPromise: null,
    capturandoIds: {},
    filtroStatus: "todos",
    filtroSituacao: "todas",
    ultimaAtualizacao: 0,
    buscaTocada: false,
    filtrosObserver: null,
    modalFeedbackItem: null,
    modalFeedbackPares: [],
    modalFeedbackPreUrl: "",
    modalFeedbackSalvando: false,
    modalModo: "",
    modalItem: null,
    modalUrl: "",
    modalCarregandoDetalhes: false,
    enriquecendoDadosNf: false,
    complementoNfTentado: {},
    mapaComplementoKanban: null,
    mapaComplementoKanbanEm: 0,
    mapaComplementoKanbanPromise: null,

    // MENSAGENS_PREDEFINIDAS_SEM_AUTOFILL
    // Mantém a lista em cache e controla abertura/fechamento sem deixar
    // uma camada invisível bloqueando o formulário de feedback.
    mensagensPredefinidas: [],
    mensagensPredefinidasUrl: "",
    premsgBuscaTocada: false,
    premsgAbrindo: false,
    premsgAbortController: null,

    // COLUNAS_OCULTAS_E_INTEGRACOES
    mostrarColunasOpcionais: false,
    integracaoObserver: null,
    integracaoRenderTimer: null,
    integracaoBridgeAssinatura: "",
    selecionados: {},
    modalFeedbackLoteIds: [],

    // RESPONSAVEL_NOME_EXATO
    // Relação de atendentes válidos encontrada nos próprios selects do InfraDesk.
    atendentesConhecidos: [],

    // PAINEL_SEM_PISCAR
    // Atualizações de NF, reserva e integrações são agrupadas e aplicadas
    // somente nas células realmente alteradas.
    linhasPendentes: new Set(),
    linhasPendentesTimer: null,
    linhasAdiadasTimers: {},
    integracaoIdsPendentes: new Set(),
    integracaoEspelharTudo: false,

    // DESEMPENHO_LAZY_SEM_TRAVAR
    integracaoViewportTimer: null,
    integracaoViewportIdsPendentes: new Set(),
    integracaoScrollHandler: null,
    integracaoResizeHandler: null,
    integracaoAtivos: new Set(),
    complementoNfTimer: null,
  };

  prepararPainel().catch(function (falha) {
    console.error(PREFIXO, falha);
    revelarDocumento();
    mostrarErroFatal(falha);
  });

  // =========================================================
  // ABRIR_PAINEL
  // =========================================================
  function instalarBotaoAbrirPainel() {
    const instalar = function () {
      if (!document.body || document.getElementById("sigma-abrir-painel-doca")) return;

      const link = document.createElement("a");
      link.id = "sigma-abrir-painel-doca";
      link.href = CONFIG.urlPainel;
      link.target = "_blank";
      link.rel = "noopener";
      link.innerHTML = '<i class="fa-solid fa-warehouse"></i><span>Painel Doca</span>';
      link.title = "Abrir o Painel Operacional da Doca";
      link.style.cssText = [
        "position:fixed",
        "right:18px",
        "bottom:18px",
        "z-index:999999",
        "display:inline-flex",
        "align-items:center",
        "gap:8px",
        "height:42px",
        "padding:0 15px",
        "border-radius:12px",
        "background:#102238",
        "color:#fff",
        "font:800 13px Arial,sans-serif",
        "text-decoration:none",
        "box-shadow:0 10px 28px rgba(15,23,42,.32)",
      ].join(";");

      document.body.appendChild(link);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", instalar, { once: true });
    } else {
      instalar();
    }
  }

  // =========================================================
  // PREPARAR_DOCUMENTO
  // =========================================================
  function ocultarPaginaOriginal() {
    try {
      document.documentElement.style.setProperty("visibility", "hidden", "important");
      document.documentElement.style.setProperty("background", "#edf2f7", "important");
    } catch (_) {}
  }

  function revelarDocumento() {
    try {
      document.documentElement.style.removeProperty("visibility");
      document.documentElement.style.setProperty("background", "#edf2f7", "important");
    } catch (_) {}
  }

  function esperarDocumentoDisponivel() {
    if (document.body && document.readyState !== "loading") return Promise.resolve();

    return new Promise(function (resolve) {
      const concluir = function () {
        if (document.body) {
          resolve();
          return;
        }
        setTimeout(concluir, 20);
      };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", concluir, { once: true });
      } else {
        concluir();
      }
    });
  }

  async function prepararPainel() {
    await esperarDocumentoDisponivel();

    // Identifica o usuário enquanto o HTML original ainda existe.
    state.usuario = detectarUsuario(document);

    montarDocumentoIndependente();
    instalarCampoBuscaSeguro();
    revelarDocumento();
    configurarEventos();
    protegerFiltrosNativos();
    restaurarPreferencias();
    aplicarVisibilidadeColunas();
    iniciarEspelhoIntegracoes();
    limparBuscaInicial();

    atualizarStatus("Carregando reservas e chamados da Doca...");

    await Promise.all([
      carregarReservas(),
      carregarTodosChamados(),
    ]);

    aplicarCacheComplementosAntesDaPrimeiraRenderizacao();
    reconstruirFiltros();
    renderizar();
    configurarIntegracoesLazy();
    agendarComplementoNfEmOciosidade();
    conectarRealtimeReservas();
    configurarAtualizacaoAutomatica();
  }

  // =========================================================
  // DOCUMENTO_INDEPENDENTE
  // =========================================================
  function montarDocumentoIndependente() {
    const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Painel Operacional da Doca • InfraDesk</title>
  <link rel="icon" href="https://cdn.infradesk.app/favicon.ico">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
  <style id="sigma-painel-doca-css">
    :root {
      --bg:#edf2f7;
      --card:#ffffff;
      --dark:#102238;
      --dark2:#17314e;
      --border:#d8e1ec;
      --text:#182235;
      --muted:#65748a;
      --blue:#2563eb;
      --green:#12865d;
      --red:#dc2626;
      --yellow:#d97706;
      --purple:#7c3aed;
    }

    * { box-sizing:border-box; }
    html,body { width:100%;height:100%;margin:0; }
    body { overflow:hidden;background:var(--bg);color:var(--text);font-family:Arial,Helvetica,sans-serif; }
    button,input,select { font:inherit; }

    /* Os scripts originais do InfraDesk podem terminar de carregar depois que
       o painel já foi montado e tentar recolocar listas/modais antigos no BODY.
       Esta barreira mantém visíveis somente os elementos pertencentes ao painel. */
    body > *:not(#sigma-doca-app):not(#sigma-modal):not(#sigma-feedback-modal):not(#sigma-premsg-modal):not(#sigma-toast):not(#sigma-motor-infradesk):not(#xabuia-overlay):not(#xabuia-toast):not(#xabuia-force-update-overlay):not(#xabuia-loader-error):not(#comercial-overlay):not(#comercial-toast):not(#comercial-loader-error) {
      display:none !important;
    }

    #sigma-doca-app {
      display:flex;
      flex-direction:column;
      width:100%;
      height:100vh;
      padding:8px;
      gap:7px;
    }

    .sigma-topo {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:14px;
      min-height:55px;
      padding:8px 12px;
      border-radius:12px;
      background:var(--dark);
      color:#fff;
      box-shadow:0 8px 24px rgba(15,23,42,.18);
    }

    .sigma-marca { display:flex;align-items:center;min-width:0;gap:10px; }
    .sigma-marca-icone {
      display:inline-flex;align-items:center;justify-content:center;
      width:38px;height:38px;flex:0 0 auto;border-radius:11px;
      background:rgba(34,197,94,.16);color:#86efac;font-size:18px;
    }
    .sigma-marca strong { display:block;font-size:15px;line-height:18px; }
    .sigma-marca small {
      display:block;overflow:hidden;max-width:720px;color:#b9c7d9;
      font-size:10px;line-height:15px;white-space:nowrap;text-overflow:ellipsis;
    }

    .sigma-topo-acoes { display:flex;align-items:center;gap:7px;flex:0 0 auto; }
    .sigma-usuario {
      display:inline-flex;align-items:center;gap:7px;min-height:31px;padding:0 10px;
      border-radius:999px;background:rgba(255,255,255,.09);color:#e5edf8;
      font-size:10px;font-weight:900;
    }
    .sigma-btn {
      display:inline-flex;align-items:center;justify-content:center;gap:7px;height:32px;
      padding:0 11px;border:1px solid rgba(255,255,255,.15);border-radius:8px;
      background:rgba(255,255,255,.09);color:#fff;font-size:10px;font-weight:900;
      text-decoration:none;cursor:pointer;
    }
    .sigma-btn:hover { background:rgba(255,255,255,.17);color:#fff;text-decoration:none; }
    .sigma-btn:disabled { opacity:.48;cursor:wait; }

    .sigma-status-cards {
      display:grid;
      grid-template-columns:repeat(5,minmax(130px,1fr));
      gap:7px;
    }
    .sigma-status-card {
      position:relative;display:flex;align-items:center;justify-content:space-between;
      min-height:48px;padding:8px 11px;border:1px solid var(--border);border-radius:11px;
      background:#fff;color:#334155;cursor:pointer;box-shadow:0 4px 14px rgba(15,23,42,.045);
    }
    .sigma-status-card:hover { border-color:#94a3b8;transform:translateY(-1px); }
    .sigma-status-card.ativo { border-color:#2563eb;background:#eff6ff;box-shadow:0 0 0 2px rgba(37,99,235,.10); }
    .sigma-status-card span { display:block;font-size:10px;font-weight:900; }
    .sigma-status-card small { display:block;margin-top:2px;color:#7b8a9f;font-size:8px;font-weight:800; }
    .sigma-status-card b { font-size:21px;color:#0f172a; }
    .sigma-status-card[data-status="5"] { border-left:5px solid #ef4444; }
    .sigma-status-card[data-status="2"] { border-left:5px solid #10b981; }
    .sigma-status-card[data-status="3"] { border-left:5px solid #3b82f6; }
    .sigma-status-card[data-status="6"] { border-left:5px solid #8b5cf6; }
    .sigma-status-card[data-status="todos"] { border-left:5px solid #334155; }

    /* FILTROS_COM_ALTURA_PROTEGIDA
       O painel é uma coluna flexível. Sem flex-shrink:0, o navegador podia
       sacrificar a altura dos filtros para entregar mais espaço à tabela. */
    .sigma-topo,.sigma-filtros,.sigma-resumo { flex-shrink:0; }
    .sigma-filtros {
      flex:0 0 auto;min-height:61px;padding:8px 10px 9px;
      border:1px solid var(--border);border-radius:11px;background:#fff;
      box-shadow:0 5px 18px rgba(15,23,42,.055);
      overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;
    }
    .sigma-filtros-linha {
      display:grid;
      grid-template-columns:minmax(250px,1.55fr) repeat(5,minmax(145px,1fr));
      gap:8px;align-items:end;min-width:1080px;min-height:43px;
    }
    .sigma-campo { min-width:0; }
    .sigma-campo-busca { min-width:250px; }
    .sigma-campo label {
      display:block;margin:0 0 3px;color:#475569;font-size:9px;font-weight:900;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .sigma-campo input,.sigma-campo select,.sigma-busca-segura {
      width:100%;height:36px;min-height:36px;padding:0 10px;
      border:1px solid #cbd5e1;border-radius:7px;
      background:#fff;color:#1e293b;outline:none;font-size:10px;
    }
    .sigma-busca-segura {
      display:flex;align-items:center;overflow:hidden;white-space:nowrap;cursor:text;
    }
    .sigma-busca-segura:empty::before {
      content:attr(data-placeholder);color:#94a3b8;pointer-events:none;
    }
    .sigma-campo input:focus,.sigma-campo select:focus,.sigma-busca-segura:focus {
      border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.12);
    }

    /* O InfraDesk tenta converter SELECTs novos em Select2. Nos filtros do
       painel usamos somente os campos nativos para não duplicar opções fora
       da caixa nem desalinhá-las. */
    #sigma-doca-app .sigma-filtros .select2-container,
    #sigma-doca-app .sigma-filtros .select2-dropdown { display:none!important; }
    #sigma-doca-app .sigma-filtros select,
    #sigma-doca-app .sigma-filtros select.select2-hidden-accessible {
      position:static!important;display:block!important;clip:auto!important;
      width:100%!important;height:36px!important;min-height:36px!important;margin:0!important;
      overflow:visible!important;opacity:1!important;pointer-events:auto!important;
    }

    .sigma-resumo {
      display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:36px;
      padding:4px 8px;border:1px solid var(--border);border-radius:10px;background:#fff;
    }
    .sigma-chips { display:flex;align-items:center;gap:6px;flex-wrap:wrap; }
    .sigma-chip {
      display:inline-flex;align-items:center;gap:5px;min-height:26px;padding:0 9px;
      border:1px solid #dbe3ec;border-radius:999px;background:#f8fafc;color:#475569;
      font-size:9px;font-weight:900;cursor:pointer;
    }
    .sigma-chip:hover,.sigma-chip.ativo { border-color:#2563eb;background:#eff6ff;color:#1d4ed8; }
    .sigma-chip b { color:#0f172a; }
    #sigma-status-carregamento { display:none!important; }

    .sigma-grade-wrap {
      flex:1 1 0;min-height:0;overflow:auto;border:1px solid var(--border);border-radius:11px;
      background:#fff;box-shadow:0 7px 22px rgba(15,23,42,.07);
    }
    .sigma-grade { width:100%;min-width:1120px;table-layout:fixed;border-collapse:separate;border-spacing:0; }
    #sigma-doca-app.sigma-mostrar-colunas-opcionais .sigma-grade { min-width:1580px; }
    .sigma-grade thead th {
      position:sticky;top:0;z-index:20;padding:10px 8px;border:0;background:var(--dark);
      color:#fff;font-size:10.5px;text-align:left;white-space:nowrap;
    }
    .sigma-grade tbody td {
      min-width:0;padding:9px 8px;overflow:hidden;border-top:1px solid #e7edf4;color:#475569;
      font-size:12px;vertical-align:middle;text-overflow:ellipsis;
    }
    .sigma-grade tbody td > * { max-width:100%; }
    /* PAINEL_SEM_PISCAR
       Sem animação de deslocamento: ela parecia uma piscada quando vários
       operadores reservavam chamados ao mesmo tempo. */
    .sigma-grade tbody tr { transition:background .10s ease; }
    .sigma-grade tbody tr.sigma-removendo { display:none; }
    .sigma-grade tbody tr:hover td { background:#f3f8ff; }
    .sigma-grade tbody tr.sigma-reservado-outro td { background:#fff8f1; }
    #sigma-doca-app:not(.sigma-mostrar-colunas-opcionais) .sigma-col-opcional { display:none!important; }

    .sigma-id a { color:#172033;font-weight:900;text-decoration:none;font-size:12px; }
    .sigma-id small { display:block;margin-top:2px;color:#7c8ba1;font-size:9px; }
    .sigma-status-badge {
      display:inline-flex;align-items:center;min-height:25px;padding:0 9px;border-radius:999px;
      font-size:9px;font-weight:900;white-space:nowrap;
    }
    .status-2 { background:#dcfce7;color:#166534; }
    .status-3 { background:#dbeafe;color:#1d4ed8; }
    .status-5 { background:#fee2e2;color:#991b1b; }
    .status-6 { background:#ede9fe;color:#5b21b6; }

    .sigma-representante { color:#243247;font-weight:900; }
    .sigma-representante strong,.sigma-representante small { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
    .sigma-tipo strong { display:block;color:#172033;font-size:12px; }
    .sigma-tipo small { display:block;margin-top:2px;color:#64748b;font-size:9.5px; }
    .sigma-nf-integracoes { color:#243247;font-weight:700; }
    .sigma-nf-integracoes > strong { display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px; }
    .sigma-chave-linha {
      display:flex;align-items:center;gap:5px;min-width:0;margin-top:4px;color:#475569;
      font-family:Consolas,monospace;font-size:9px;font-weight:800;
    }
    .sigma-chave-texto { min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
    .sigma-chave-copiar {
      flex:0 0 auto;width:20px;height:20px;padding:0;border:1px solid #cbd5e1;border-radius:5px;
      background:#fff;color:#475569;cursor:pointer;font-size:8px;
    }
    .sigma-chave-copiar:hover { border-color:#2563eb;color:#1d4ed8;background:#eff6ff; }
    .sigma-fornecedor { max-width:220px;font-size:12px;font-weight:900;line-height:1.3; }
    .sigma-pessoa { max-width:150px; }
    .sigma-pessoa strong { display:block;color:#334155;font-size:11px; }
    .sigma-pessoa small { display:block;color:#7c8ba1;font-size:9px; }
    .sigma-data { white-space:nowrap;font-weight:800; }
    .sigma-data small { display:block;margin-top:2px;color:#7c8ba1;font-size:9px; }

    .sigma-owner {
      display:inline-flex;align-items:center;gap:5px;max-width:145px;min-height:23px;padding:0 7px;
      border:1px solid #cbd5e1;border-radius:999px;background:#fff;color:#475569;
      font-size:9px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .sigma-owner.livre { color:#64748b;background:#f8fafc; }
    .sigma-owner.outro { color:#9a3412;background:#fff7ed;border-color:#fed7aa; }
    .sigma-owner.minha { color:#166534;background:#f0fdf4;border-color:#bbf7d0; }

    .sigma-sla { min-width:92px; }
    .sigma-sla-barra { width:82px;height:7px;overflow:hidden;border-radius:999px;background:#e2e8f0; }
    .sigma-sla-barra span { display:block;height:100%;background:#3b82f6; }
    .sigma-sla-barra span.alerta { background:#f59e0b; }
    .sigma-sla-barra span.critico { background:#ef4444; }
    .sigma-sla small { display:block;margin-top:3px;color:#64748b;font-size:9px;font-weight:800; }

    .sigma-integracoes-resumo { display:grid;gap:4px;margin-top:5px; }
    .sigma-integracoes-resumo.aguardando { min-height:42px; }
    .sigma-integracao-mini {
      display:flex;align-items:flex-start;gap:6px;min-width:0;padding:5px 7px;border:1px solid #dbeafe;
      border-radius:8px;background:#f8fafc;color:#334155;font-size:9.5px;line-height:1.25;
    }
    .sigma-integracao-mini img { width:18px;height:18px;flex:0 0 auto;border-radius:5px; }
    .sigma-integracao-mini > span { min-width:0;display:block; }
    .sigma-integracao-mini strong { display:block;margin-bottom:1px;font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
    .sigma-integracao-mini em { display:-webkit-box;overflow:hidden;color:#475569;font-style:normal;-webkit-line-clamp:2;-webkit-box-orient:vertical; }
    .sigma-integracao-mini.xabuia { border-color:#c7d2fe;background:#eef2ff; }
    .sigma-integracao-mini.xabuia strong { color:#1d4ed8; }
    .sigma-integracao-mini.comercial { border-color:#fbcfe8;background:#fff7fb; }
    .sigma-integracao-mini.comercial strong { color:#be185d; }
    .sigma-acao-integracao img { width:19px;height:19px;border-radius:5px;display:block; }

    .sigma-resumo-direita { display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0; }
    .sigma-colunas-btn {
      display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:0 9px;border:1px solid #cbd5e1;
      border-radius:8px;background:#f8fafc;color:#334155;font-size:9px;font-weight:900;cursor:pointer;white-space:nowrap;
    }
    .sigma-colunas-btn:hover,.sigma-colunas-btn.ativo { border-color:#2563eb;background:#eff6ff;color:#1d4ed8; }
    .sigma-colunas-btn b { display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:999px;background:#e2e8f0;color:#334155;font-size:8px; }

    #sigma-integracao-bridge {
      position:fixed!important;left:-100000px!important;top:0!important;width:420px!important;height:auto!important;
      overflow:visible!important;opacity:.01!important;pointer-events:none!important;z-index:-1!important;
    }

    .sigma-acoes { display:flex;align-items:center;justify-content:flex-end;gap:4px;white-space:nowrap; }
    .sigma-acao {
      display:inline-flex;align-items:center;justify-content:center;width:31px;height:31px;padding:0;
      border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#334155;cursor:pointer;
      text-decoration:none;font-size:11px;
    }
    .sigma-acao:hover { border-color:#2563eb;background:#eff6ff;color:#1d4ed8; }
    .sigma-acao.destaque { border-color:#0f8a5f;background:#12865d;color:#fff; }
    .sigma-acao.destaque:hover { background:#0b6b49;color:#fff; }
    .sigma-acao:disabled { opacity:.35;cursor:not-allowed;filter:grayscale(1); }
    .sigma-check-lote { width:18px;height:18px;cursor:pointer;accent-color:#2563eb; }
    .sigma-selecao-celula { text-align:center;vertical-align:middle; }
    .sigma-lote-btn[disabled] { opacity:.55;cursor:not-allowed; }
    tr.sigma-selecionado { background:#eef6ff !important; box-shadow: inset 3px 0 0 #2563eb; }
    .sigma-feedback-resumo-lote { display:grid;gap:6px;padding:12px 14px;border:1px solid #dbeafe;background:#eff6ff;border-radius:12px;color:#1e3a8a;margin-bottom:4px; }
    .sigma-feedback-resumo-lote strong { font-size:14px; }
    .sigma-feedback-resumo-lote small { color:#335c9f; }

    .sigma-vazio,.sigma-loading { padding:60px 20px!important;color:#64748b!important;text-align:center!important;font-size:12px!important; }
    .sigma-loading i { margin-right:8px;color:#12865d; }

    #sigma-modal {
      position:fixed;inset:0;z-index:2000000;display:none;align-items:center;justify-content:center;
      padding:16px;background:rgba(15,23,42,.76);backdrop-filter:blur(2px);
    }
    #sigma-modal.ativo { display:flex; }
    .sigma-modal-caixa {
      display:flex;flex-direction:column;width:min(1500px,calc(100vw - 28px));height:calc(100vh - 28px);
      overflow:hidden;border-radius:14px;background:#fff;box-shadow:0 30px 90px rgba(0,0,0,.38);
    }
    .sigma-modal-topo {
      display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:48px;
      padding:7px 10px;background:var(--dark);color:#fff;
    }
    .sigma-modal-topo strong { font-size:11px; }
    .sigma-modal-topo div { display:flex;align-items:center;gap:6px; }
    .sigma-modal-topo button,.sigma-modal-topo a {
      display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.18);
      border-radius:8px;background:rgba(255,255,255,.10);color:#fff;text-decoration:none;font-size:10px;font-weight:900;cursor:pointer;
    }
    .sigma-modal-topo button:hover,.sigma-modal-topo a:hover { background:rgba(255,255,255,.18); }
    #sigma-modal-corpo {
      position:relative;display:flex;flex:1 1 auto;min-height:0;overflow:hidden;background:#fff;
    }
    #sigma-modal-frame { flex:1 1 auto;min-width:0;width:100%;height:100%;border:0;background:#fff; }
    #sigma-modal-carregando {
      position:absolute;inset:0;z-index:30;display:none;align-items:center;justify-content:center;
      padding:30px;background:#f8fafc;color:#475569;text-align:center;font-size:12px;font-weight:900;
    }
    #sigma-modal-carregando.ativo { display:flex; }
    #sigma-modal-carregando div {
      display:flex;flex-direction:column;align-items:center;gap:10px;max-width:520px;
    }
    #sigma-modal-carregando i { color:#12865d;font-size:28px; }
    #sigma-modal-carregando small { color:#64748b;font-size:10px;line-height:1.45; }

    /* FEEDBACK_MODAL_PROPRIO
       O feedback não abre mais uma página inteira dentro de iframe. */
    #sigma-feedback-modal,#sigma-premsg-modal {
      position:fixed;inset:0;display:none;align-items:center;justify-content:center;
      padding:16px;background:rgba(15,23,42,.76);backdrop-filter:blur(2px);
    }
    #sigma-feedback-modal { z-index:2200000; }
    #sigma-premsg-modal { z-index:2300000;background:rgba(15,23,42,.82); }
    #sigma-feedback-modal.ativo,#sigma-premsg-modal.ativo { display:flex; }
    .sigma-feedback-caixa {
      display:flex;flex-direction:column;width:min(980px,calc(100vw - 30px));
      max-height:calc(100vh - 30px);overflow:hidden;border-radius:14px;background:#fff;
      box-shadow:0 30px 90px rgba(0,0,0,.40);
    }
    .sigma-feedback-topo {
      display:flex;align-items:center;justify-content:space-between;gap:12px;
      min-height:49px;padding:8px 12px;background:var(--dark);color:#fff;
    }
    .sigma-feedback-topo strong { font-size:12px; }
    .sigma-feedback-topo button {
      display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;
      padding:0 11px;border:1px solid rgba(255,255,255,.18);border-radius:8px;
      background:rgba(255,255,255,.10);color:#fff;font-size:10px;font-weight:900;cursor:pointer;
    }
    .sigma-feedback-corpo { overflow:auto;padding:14px;background:#f7f9fc; }
    .sigma-feedback-campo { margin-bottom:12px; }
    .sigma-feedback-campo label { display:block;margin-bottom:5px;color:#334155;font-size:10px;font-weight:900; }
    .sigma-feedback-campo select {
      width:100%;height:36px;padding:0 10px;border:1px solid #cbd5e1;border-radius:8px;
      background:#fff;color:#172033;font-size:11px;
    }
    #sigma-feedback-editor {
      min-height:210px;padding:12px;border:1px solid #cbd5e1;border-radius:9px;
      background:#fff;color:#172033;font-size:12px;line-height:1.5;outline:none;
      overflow:auto;white-space:normal;
    }
    #sigma-feedback-editor:focus { border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.12); }
    #sigma-feedback-editor:empty:before { content:'Digite a interação...';color:#94a3b8; }
    .sigma-feedback-acoes {
      display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:13px;
    }
    .sigma-feedback-acoes div { display:flex;align-items:center;gap:7px; }
    .sigma-feedback-btn {
      display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:35px;
      padding:0 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;
      color:#334155;font-size:10px;font-weight:900;cursor:pointer;
    }
    .sigma-feedback-btn:hover { border-color:#2563eb;background:#eff6ff;color:#1d4ed8; }
    .sigma-feedback-btn.primario { border-color:#2563eb;background:#2563eb;color:#fff; }
    .sigma-feedback-btn.primario:hover { background:#1d4ed8;color:#fff; }
    .sigma-feedback-btn:disabled { opacity:.45;cursor:wait; }
    .sigma-premsg-lista { display:grid;gap:8px; }
    .sigma-premsg-item {
      display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:10px;
      border:1px solid #dbe3ec;border-radius:9px;background:#fff;
    }
    .sigma-premsg-item strong { display:block;margin-bottom:4px;color:#172033;font-size:11px; }
    .sigma-premsg-preview { max-height:64px;overflow:hidden;color:#64748b;font-size:10px;line-height:1.35; }
    .sigma-premsg-busca { width:100%;height:35px;margin-bottom:10px;padding:0 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:11px; }
    .sigma-premsg-busca[readonly] { background:#fff;color:#172033;cursor:text; }
    .sigma-autofill-armadilha {
      position:fixed!important;left:-10000px!important;top:-10000px!important;width:1px!important;height:1px!important;
      overflow:hidden!important;opacity:0!important;pointer-events:none!important;
    }

    #sigma-toast {
      position:fixed;right:18px;bottom:18px;z-index:3000000;display:none;max-width:440px;
      padding:11px 14px;border-radius:10px;background:#0f172a;color:#fff;
      box-shadow:0 14px 35px rgba(0,0,0,.27);font-size:10px;font-weight:800;
    }
    #sigma-toast.erro { background:#991b1b; }
    #sigma-toast.sucesso { background:#166534; }
    #sigma-toast.aviso { background:#92400e; }

    @media (max-width:1200px) {
      .sigma-filtros-linha {
        grid-template-columns:250px repeat(5,145px);
        min-width:1015px;
      }
    }
    @media (max-height:700px) {
      .sigma-filtros { min-height:57px;padding-top:6px;padding-bottom:7px; }
      .sigma-filtros-linha { min-height:41px; }
    }
  </style>
</head>
<body>
  <div id="sigma-doca-app">
    <header class="sigma-topo">
      <div class="sigma-marca">
        <span class="sigma-marca-icone"><i class="fa-solid fa-warehouse"></i></span>
        <span>
          <strong>Painel Operacional da Doca</strong>
          <small>Fila independente do Kanban • Status ativos, última movimentação e captura protegida • v${CONFIG.versao}</small>
        </span>
      </div>
      <div class="sigma-topo-acoes">
        <span class="sigma-usuario" id="sigma-usuario"><i class="fa-solid fa-user"></i> ${escaparHtml(state.usuario.nome || "Usuário não identificado")}</span>
        <button class="sigma-btn" id="sigma-atualizar" type="button"><i class="fa-solid fa-rotate"></i> Atualizar</button>
        <a class="sigma-btn" href="/backend/chamados/painel?changeView=1" target="_blank" rel="noopener"><i class="fa-solid fa-columns"></i> Kanban original</a>
      </div>
    </header>


    <section class="sigma-filtros">
      <div class="sigma-filtros-linha">
        <div class="sigma-campo sigma-campo-busca">
          <label>Buscar chamado, nota, chave, fornecedor ou representante</label>
          <div id="sigma-busca" class="sigma-busca-segura" contenteditable="plaintext-only" role="searchbox" aria-label="Buscar chamado, nota, chave, fornecedor ou representante" data-placeholder="Digite para filtrar instantaneamente..." spellcheck="false"></div>
        </div>
        <div class="sigma-campo">
          <label>Representante</label>
          <select id="sigma-filtro-representante" data-noselect="1"><option value="">Todos</option></select>
        </div>
        <div class="sigma-campo">
          <label>Tipo / prioridade</label>
          <select id="sigma-filtro-prioridade" data-noselect="1"><option value="">Todos</option></select>
        </div>
        <div class="sigma-campo">
          <label>Fornecedor</label>
          <select id="sigma-filtro-fornecedor" data-noselect="1"><option value="">Todos</option></select>
        </div>
        <div class="sigma-campo">
          <label>Atendente</label>
          <select id="sigma-filtro-atendente" data-noselect="1"><option value="">Todos</option></select>
        </div>
        <div class="sigma-campo">
          <label>Organizar por</label>
          <select id="sigma-organizacao" data-noselect="1">
            <option value="original">Padrão do InfraDesk (sem reorganizar)</option>
            <option value="representante_030105">Recebimento 03 → 01 → 05 • SLA • antigos primeiro</option>
          </select>
        </div>
      </div>
    </section>

    <section class="sigma-resumo">
      <div class="sigma-chips">
        <button class="sigma-chip ativo" type="button" data-situacao="todas">Todas <b id="sigma-sit-todas">0</b></button>
        <button class="sigma-chip" type="button" data-situacao="livres">Livres + minhas <b id="sigma-sit-livres">0</b></button>
        <button class="sigma-chip" type="button" data-situacao="minhas">Minhas <b id="sigma-sit-minhas">0</b></button>
        <button class="sigma-chip" type="button" data-situacao="reservadas">Reservadas por outros <b id="sigma-sit-reservadas">0</b></button>
      </div>
      <div class="sigma-resumo-direita">
        <button class="sigma-colunas-btn sigma-lote-btn" id="sigma-abrir-lote" type="button" title="Selecionar vários chamados e gravar a mesma ocorrência em lote" disabled>
          <i class="fa-solid fa-layer-group"></i><span>Ação em lote</span><b id="sigma-lote-count">0</b>
        </button>
        <button class="sigma-colunas-btn" id="sigma-toggle-colunas" type="button" title="Mostrar ou ocultar as quatro colunas secundárias">
          <i class="fa-solid fa-table-columns"></i><span>Exibir colunas ocultas</span><b>4</b>
        </button>
        <span id="sigma-status-carregamento" aria-hidden="true"></span>
      </div>
    </section>

    <main class="sigma-grade-wrap">
      <table class="sigma-grade">
        <thead>
          <tr>
            <th style="width:42px;text-align:center"><input id="sigma-selecao-todos" class="sigma-check-lote" type="checkbox" title="Selecionar os chamados visíveis"></th>
            <th class="sigma-col-opcional" style="width:88px">Chamado</th>
            <th style="width:120px">Status</th>
            <th style="width:150px">Tipo</th>
            <th style="width:420px">NF / chave / Xabuia e Comercial</th>
            <th style="width:225px">Fornecedor</th>
            <th class="sigma-col-opcional" style="width:175px">Representante</th>
            <th class="sigma-col-opcional" style="width:155px">Última movimentação</th>
            <th style="width:175px">Responsável</th>
            <th class="sigma-col-opcional" style="width:120px">SLA</th>
            <th style="width:175px;text-align:right">Ações</th>
          </tr>
        </thead>
        <tbody id="sigma-corpo-tabela">
          <tr><td colspan="11" class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Carregando chamados...</td></tr>
        </tbody>
      </table>
    </main>

    <!-- PONTE_XABUIA_COMERCIAL
         Cards invisíveis com a estrutura esperada pelos loaders oficiais.
         Os modais, autenticação e Firebase continuam pertencendo aos scripts externos. -->
    <div id="sigma-integracao-bridge" aria-hidden="true"></div>
  </div>

  <div id="sigma-modal" aria-hidden="true">
    <div class="sigma-modal-caixa">
      <div class="sigma-modal-topo">
        <strong id="sigma-modal-titulo">Chamado</strong>
        <div>
          <a id="sigma-modal-nova-aba" href="#" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i> Nova aba</a>
          <button id="sigma-modal-recarregar" type="button"><i class="fa-solid fa-rotate"></i> Recarregar</button>
          <button id="sigma-modal-fechar" type="button"><i class="fa-solid fa-xmark"></i> Fechar</button>
        </div>
      </div>
      <div id="sigma-modal-corpo">
        <div id="sigma-modal-carregando" aria-live="polite">
          <div>
            <i class="fa-solid fa-circle-notch fa-spin"></i>
            <strong id="sigma-modal-carregando-titulo">Carregando...</strong>
            <small id="sigma-modal-carregando-detalhe">Preparando o conteúdo sem sair do painel.</small>
          </div>
        </div>
        <iframe id="sigma-modal-frame" title="Conteúdo do chamado"></iframe>
      </div>
    </div>
  </div>

  <div id="sigma-feedback-modal" aria-hidden="true">
    <div class="sigma-feedback-caixa">
      <div class="sigma-feedback-topo">
        <strong id="sigma-feedback-titulo">Adicionar feedback</strong>
        <button id="sigma-feedback-fechar" type="button"><i class="fa-solid fa-xmark"></i> Fechar</button>
      </div>
      <div class="sigma-feedback-corpo" id="sigma-feedback-corpo">
        <div class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Preparando formulário...</div>
      </div>
    </div>
  </div>

  <div id="sigma-premsg-modal" aria-hidden="true">
    <div class="sigma-feedback-caixa">
      <div class="sigma-feedback-topo">
        <strong>Mensagens pré-definidas</strong>
        <button id="sigma-premsg-fechar" type="button"><i class="fa-solid fa-xmark"></i> Fechar</button>
      </div>
      <div class="sigma-feedback-corpo" id="sigma-premsg-corpo">
        <div class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Carregando mensagens...</div>
      </div>
    </div>
  </div>

  <div id="sigma-toast"></div>
</body>
</html>`;

    const novoDocumento = new DOMParser().parseFromString(html, "text/html");
    document.documentElement.lang = "pt-BR";
    document.title = "Painel Operacional da Doca • InfraDesk";
    document.head.innerHTML = novoDocumento.head.innerHTML;
    document.body.className = "";
    document.body.removeAttribute("style");
    document.body.innerHTML = novoDocumento.body.innerHTML;
  }

  // =========================================================
  // BUSCA_SEGURA_SEM_GERENCIADOR_DE_SENHAS
  // Para localizar depois, use CTRL + F e procure por:
  // BUSCA_SEGURA_SEM_GERENCIADOR_DE_SENHAS
  //
  // O campo é um contenteditable, não um INPUT. Assim Chrome, Edge e
  // gerenciadores de senha não o confundem com usuário/login. A propriedade
  // value abaixo mantém compatibilidade com o restante do painel.
  // =========================================================
  function instalarCampoBuscaSeguro() {
    const busca = document.getElementById("sigma-busca");
    if (!busca || busca.dataset.sigmaBuscaSegura === "1") return;

    busca.dataset.sigmaBuscaSegura = "1";
    Object.defineProperty(busca, "value", {
      configurable: true,
      get: function () { return texto(this.textContent || ""); },
      set: function (valor) { this.textContent = String(valor == null ? "" : valor); },
    });

    busca.addEventListener("paste", function (event) {
      event.preventDefault();
      const colado = event.clipboardData?.getData("text/plain") || "";
      document.execCommand("insertText", false, colado);
    });
  }

  // =========================================================
  // UTILITARIOS
  // =========================================================
  // =========================================================
  // LIMPEZA_TEXTO_INFRADESK
  // Para localizar depois, use CTRL + F e procure por:
  // LIMPEZA_TEXTO_INFRADESK
  //
  // Algumas descrições do InfraDesk chegam com a entidade escapada como
  // texto literal: &nbsp; ou até &amp;nbsp;. Isso não é informação do
  // chamado e não deve aparecer na grade nem participar da busca.
  // =========================================================
  function texto(valor) {
    let saida = String(valor == null ? "" : valor);

    // Repete para limpar casos duplamente escapados, como &amp;nbsp;.
    for (let i = 0; i < 3; i++) {
      const anterior = saida;
      saida = saida
        .replace(/&amp;nbsp;|&#0*160;|&#x0*a0;|&nbsp;/gi, " ")
        .replace(/\u00a0/g, " ");
      if (saida === anterior) break;
    }

    return saida
      .replace(/\u00a0/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizar(valor) {
    return texto(valor)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function somenteDigitos(valor) {
    return String(valor == null ? "" : valor).replace(/\D+/g, "");
  }

  function escaparHtml(valor) {
    return String(valor == null ? "" : valor)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function paginaWindow() {
    return typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  }

  function chaveUsuario(valor) {
    return normalizar(valor).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "sem_usuario";
  }

  function mesmaPessoa(a, b) {
    return !!texto(a) && chaveUsuario(a) === chaveUsuario(b);
  }

  function toast(mensagem, tipo = "") {
    const el = document.getElementById("sigma-toast");
    if (!el) return;
    el.textContent = mensagem;
    el.className = tipo;
    el.style.display = "block";
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.style.display = "none"; }, 4400);
  }

  function atualizarStatus(mensagem) {
    const el = document.getElementById("sigma-status-carregamento");
    if (el) el.textContent = mensagem;
  }

  async function copiarTexto(valor, mensagem) {
    valor = texto(valor);
    if (!valor) return;
    try {
      await navigator.clipboard.writeText(valor);
    } catch (_) {
      const temp = document.createElement("textarea");
      temp.value = valor;
      temp.style.cssText = "position:fixed;left:-10000px;top:-10000px";
      (document.getElementById("sigma-doca-app") || document.body).appendChild(temp);
      temp.select();
      document.execCommand("copy");
      temp.remove();
    }
    toast(mensagem || "Copiado.", "sucesso");
  }

  function parseDataHoraBr(valor) {
    const match = texto(valor).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) return null;
    return new Date(
      Number(match[3]),
      Number(match[2]) - 1,
      Number(match[1]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0)
    );
  }

  function dataMs(valor) {
    const data = valor instanceof Date ? valor : parseDataHoraBr(valor);
    return data && !Number.isNaN(data.getTime()) ? data.getTime() : 0;
  }

  function formatarDataHora(data) {
    if (!(data instanceof Date) || Number.isNaN(data.getTime())) return "---";
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(data).replace(",", "");
  }

  function detectarUsuario(doc) {
    const out = { nome: "", id: "", login: "" };
    const selectors = [
      ".profile-element strong.font-bold",
      ".profile-element .font-bold",
      ".nav-header .font-bold",
      ".nav-header big",
      ".logo-element .dropdown-menu big",
    ];

    for (const selector of selectors) {
      const el = doc.querySelector(selector);
      if (!el) continue;
      let nome = texto(el.textContent).replace(/\bSair\b.*$/i, "").replace(/\bMeus dados\b.*$/i, "");
      nome = texto(nome);
      if (nome && nome.length >= 3 && !/central|libera/i.test(nome)) {
        out.nome = nome;
        break;
      }
    }

    const html = doc.documentElement ? doc.documentElement.innerHTML : "";
    const idMatch = html.match(/avatar_usuario_(\d+)/i) || html.match(/atendente_id=(\d+)/i);
    if (idMatch) out.id = idMatch[1];

    const selecionado = doc.querySelector('#atendente-id option[selected], #atendente-id option:checked');
    if (selecionado) out.login = texto(selecionado.textContent);

    return out;
  }

  // =========================================================
  // EVENTOS E PREFERENCIAS
  // =========================================================
  function configurarEventos() {
    document.getElementById("sigma-atualizar").addEventListener("click", async function () {
      await atualizarTudo();
    });
    document.getElementById("sigma-abrir-lote")?.addEventListener("click", abrirModalFeedbackLote);
    document.getElementById("sigma-selecao-todos")?.addEventListener("change", function (event) {
      selecionarTodosVisiveis(!!event.target.checked);
    });

    document.getElementById("sigma-toggle-colunas").addEventListener("click", function () {
      state.mostrarColunasOpcionais = !state.mostrarColunasOpcionais;
      aplicarVisibilidadeColunas();
    });

    document.querySelectorAll(".sigma-chip[data-situacao]").forEach(function (botao) {
      botao.addEventListener("click", function () {
        state.filtroSituacao = botao.dataset.situacao || "todas";

        // O botão Todas significa realmente toda a fila: limpa status, busca e
        // filtros auxiliares, mantendo somente a escolha de organização.
        if (state.filtroSituacao === "todas") {
          state.filtroStatus = "todos";
          ["sigma-busca", "sigma-filtro-representante", "sigma-filtro-prioridade", "sigma-filtro-fornecedor", "sigma-filtro-atendente"].forEach(function (id) {
            const campo = document.getElementById(id);
            if (campo) campo.value = "";
          });
        }

        document.querySelectorAll(".sigma-chip[data-situacao]").forEach(function (b) {
          b.classList.toggle("ativo", b === botao);
        });
        salvarPreferencias();
        renderizar();
      });
    });

    ["sigma-busca", "sigma-filtro-representante", "sigma-filtro-prioridade", "sigma-filtro-fornecedor", "sigma-filtro-atendente", "sigma-organizacao"]
      .forEach(function (id) {
        const el = document.getElementById(id);
        el.addEventListener(id === "sigma-busca" ? "input" : "change", function (event) {
          if (id === "sigma-busca" && event && event.isTrusted) state.buscaTocada = true;
          salvarPreferencias();
          agendarRender();
        });
      });

    document.getElementById("sigma-corpo-tabela").addEventListener("change", function (event) {
      const check = event.target.closest(".sigma-check-item");
      if (!check) return;
      alternarSelecaoChamado(texto(check.dataset.id), !!check.checked);
    });

    document.getElementById("sigma-corpo-tabela").addEventListener("click", function (event) {
      const acao = event.target.closest("[data-acao]");
      if (!acao) return;

      const id = texto(acao.dataset.id);
      const item = state.chamados.find(function (chamado) { return chamado.id === id; });
      if (!item) return;

      const tipo = acao.dataset.acao;
      if (tipo === "detalhes") abrirModalDetalhes(item);
      if (tipo === "anexos") abrirModal(item.anexosUrl, `Chamado #${item.id} • Anexos`);
      if (tipo === "feedback") abrirModalFeedback(item);
      if (tipo === "xabuia") acionarIntegracaoExterna(item, "xabuia");
      if (tipo === "comercial") acionarIntegracaoExterna(item, "comercial");
      if (tipo === "copiar-chave") copiarTexto(acao.dataset.valor || item.chaveNf || item.chaveNfTexto || "", "Chave/referência copiada.");
      if (tipo === "capturar") capturarChamado(item);
    });

    document.getElementById("sigma-modal-fechar").addEventListener("click", fecharModal);
    document.getElementById("sigma-modal").addEventListener("click", function (event) {
      if (event.target.id === "sigma-modal") fecharModal();
    });
    document.getElementById("sigma-modal-recarregar").addEventListener("click", function () {
      if (state.modalModo === "detalhes" && state.modalItem) {
        abrirModalDetalhes(state.modalItem, true);
        return;
      }
      const frame = document.getElementById("sigma-modal-frame");
      if (frame && frame.src) {
        mostrarCarregamentoModal("Recarregando conteúdo...", "Aguarde a resposta do InfraDesk.");
        frame.style.visibility = "hidden";
        frame.src = frame.src;
      }
    });
    document.getElementById("sigma-modal-frame").addEventListener("load", prepararFrameModal);

    const busca = document.getElementById("sigma-busca");
    if (busca) {
      busca.addEventListener("focus", function () {
        if (!state.buscaTocada) busca.value = "";
      });
    }

    document.getElementById("sigma-feedback-fechar").addEventListener("click", fecharModalFeedback);
    document.getElementById("sigma-feedback-modal").addEventListener("click", function (event) {
      if (event.target.id === "sigma-feedback-modal") fecharModalFeedback();
    });
    document.getElementById("sigma-premsg-fechar").addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      fecharMensagensPredefinidas();
    });
    document.getElementById("sigma-premsg-modal").addEventListener("click", function (event) {
      if (event.target.id !== "sigma-premsg-modal") return;
      event.preventDefault();
      event.stopPropagation();
      fecharMensagensPredefinidas();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (document.getElementById("sigma-premsg-modal")?.classList.contains("ativo")) {
        fecharMensagensPredefinidas();
      } else if (document.getElementById("sigma-feedback-modal")?.classList.contains("ativo")) {
        fecharModalFeedback();
      } else {
        fecharModal();
      }
    });
  }

  function chavePreferencias() {
    return `sigma_painel_doca_preferencias_${chaveUsuario(state.usuario.nome || state.usuario.login || "usuario")}`;
  }

  function salvarPreferencias() {
    try {
      localStorage.setItem(chavePreferencias(), JSON.stringify({
        status: "todos",
        situacao: state.filtroSituacao,
        representante: document.getElementById("sigma-filtro-representante")?.value || "",
        prioridade: document.getElementById("sigma-filtro-prioridade")?.value || "",
        fornecedor: document.getElementById("sigma-filtro-fornecedor")?.value || "",
        atendente: document.getElementById("sigma-filtro-atendente")?.value || "",
        organizacao: document.getElementById("sigma-organizacao")?.value || "original",
      }));
    } catch (_) {}
  }

  function restaurarPreferencias() {
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem(chavePreferencias()) || "{}"); } catch (_) {}

    state.filtroStatus = "todos";
    state.filtroSituacao = ["todas", "livres", "minhas", "reservadas"].includes(prefs.situacao) ? prefs.situacao : "todas";

    // A busca nunca é restaurada: o painel sempre inicia mostrando toda a fila.
    if (document.getElementById("sigma-busca")) document.getElementById("sigma-busca").value = "";
    if (document.getElementById("sigma-organizacao")) document.getElementById("sigma-organizacao").value = ["original", "representante_030105"].includes(prefs.organizacao) ? prefs.organizacao : "original";

    document.querySelectorAll(".sigma-chip[data-situacao]").forEach(function (b) {
      b.classList.toggle("ativo", b.dataset.situacao === state.filtroSituacao);
    });

    state._prefsPendentes = prefs;
  }

  function aplicarPreferenciasPendentes() {
    const prefs = state._prefsPendentes || {};
    [
      ["sigma-filtro-representante", prefs.representante],
      ["sigma-filtro-prioridade", prefs.prioridade],
      ["sigma-filtro-fornecedor", prefs.fornecedor],
      ["sigma-filtro-atendente", prefs.atendente],
    ].forEach(function ([id, valor]) {
      const el = document.getElementById(id);
      if (el && Array.from(el.options).some(function (o) { return o.value === valor; })) el.value = valor || "";
    });
    delete state._prefsPendentes;
  }

  // =========================================================
  // FILTROS_NATIVOS_E_BUSCA_VAZIA
  // Para localizar depois, use CTRL + F e procure por:
  // FILTROS_NATIVOS_E_BUSCA_VAZIA
  // =========================================================
  function limparSelect2DosFiltros() {
    const filtros = document.querySelector("#sigma-doca-app .sigma-filtros");
    if (!filtros) return;

    filtros.querySelectorAll(".select2-container,.select2-dropdown").forEach(function (el) { el.remove(); });
    filtros.querySelectorAll("select").forEach(function (select) {
      select.setAttribute("data-noselect", "1");
      select.classList.remove("select2-hidden-accessible");
      select.removeAttribute("aria-hidden");
      select.removeAttribute("data-select2-id");
      select.tabIndex = 0;
      select.style.setProperty("display", "block", "important");
      select.style.setProperty("position", "static", "important");
      select.style.setProperty("opacity", "1", "important");
    });
  }

  function protegerFiltrosNativos() {
    limparSelect2DosFiltros();
    const filtros = document.querySelector("#sigma-doca-app .sigma-filtros");
    if (!filtros) return;
    if (state.filtrosObserver) state.filtrosObserver.disconnect();
    state.filtrosObserver = new MutationObserver(function () {
      clearTimeout(protegerFiltrosNativos.timer);
      protegerFiltrosNativos.timer = setTimeout(limparSelect2DosFiltros, 20);
    });
    state.filtrosObserver.observe(filtros, { childList:true, subtree:true });
  }

  function limparBuscaInicial() {
    [0, 60, 250, 700, 1400, 2600].forEach(function (tempo) {
      setTimeout(function () {
        if (state.buscaTocada) return;
        const busca = document.getElementById("sigma-busca");
        if (!busca) return;
        if (busca.value) {
          busca.value = "";
          agendarRender();
        }
      }, tempo);
    });
  }

  function agendarRender() {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(renderizar, 80);
  }

  // =========================================================
  // DESEMPENHO_LAZY_SEM_TRAVAR
  // Para localizar depois, use CTRL + F e procure por:
  // DESEMPENHO_LAZY_SEM_TRAVAR
  // =========================================================
  function executarQuandoOcioso(funcao, timeout = 900) {
    if (typeof window.requestIdleCallback === "function") {
      return window.requestIdleCallback(function () { funcao(); }, { timeout });
    }
    return window.setTimeout(funcao, Math.min(timeout, 120));
  }

  function cederAoNavegador() {
    return new Promise(function (resolve) {
      executarQuandoOcioso(resolve, 120);
    });
  }

  function agendarComplementoNfEmOciosidade() {
    clearTimeout(state.complementoNfTimer);
    state.complementoNfTimer = setTimeout(function () {
      executarQuandoOcioso(function () {
        if (document.hidden || state.carregando) {
          agendarComplementoNfEmOciosidade();
          return;
        }
        completarDadosNfAusentesEmSegundoPlano();
      }, 1200);
    }, CONFIG.atrasoComplementoNfMs || 1200);
  }

  // =========================================================
  // CARREGAR CHAMADOS PAGINADOS
  // =========================================================
  function montarUrlFonte(pagina) {
    const url = new URL(CONFIG.urlFonte, window.location.origin);
    url.searchParams.set("is_active", "1");
    url.searchParams.set("is_inativo", "0");
    url.searchParams.set("status_id[0]", "-1");
    url.searchParams.set("categoria_ignorar", "0");
    url.searchParams.set("show_descricao_curta", "0");
    url.searchParams.set("is_interacao_solicitante", "0");
    url.searchParams.set("tempo_excedido", "0");
    url.searchParams.set("sort", "id");
    url.searchParams.set("direction", "desc");
    if (pagina > 1) url.searchParams.set("page", String(pagina));
    return url.toString();
  }

  async function carregarTodosChamados() {
    if (state.carregando) return;
    state.carregando = true;

    const botao = document.getElementById("sigma-atualizar");
    if (botao) botao.disabled = true;
    atualizarStatus("Consultando a fila Em trâmites do InfraDesk...");

    const corpo = document.getElementById("sigma-corpo-tabela");
    if (corpo && !state.chamados.length) {
      corpo.innerHTML = '<tr><td colspan="11" class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Consultando o InfraDesk sem desenhar as páginas...</td></tr>';
    }

    try {
      const primeira = await buscarPagina(1);
      if (!state.usuario.nome) {
        state.usuario = detectarUsuario(primeira.doc);
        const usuarioEl = document.getElementById("sigma-usuario");
        if (usuarioEl) usuarioEl.innerHTML = `<i class="fa-solid fa-user"></i> ${escaparHtml(state.usuario.nome || state.usuario.login || "Usuário")}`;
      }

      const totalPaginas = obterTotalPaginas(primeira.doc);
      const mapa = new Map();
      primeira.itens.forEach(function (item) { mapa.set(item.id, item); });
      atualizarStatus(`Página 1 de ${totalPaginas} • ${mapa.size} chamados`);

      let proxima = 2;
      let concluidas = 1;
      const workers = [];
      const quantidade = Math.min(CONFIG.paginasSimultaneas, Math.max(0, totalPaginas - 1));

      for (let w = 0; w < quantidade; w++) {
        workers.push((async function () {
          while (true) {
            const pagina = proxima++;
            if (pagina > totalPaginas) return;
            const resultado = await buscarPagina(pagina);
            resultado.itens.forEach(function (item) { mapa.set(item.id, item); });
            concluidas++;
            atualizarStatus(`Carregando ${concluidas} de ${totalPaginas} páginas • ${mapa.size} chamados`);
          }
        })());
      }

      await Promise.all(workers);
      state.chamados = Array.from(mapa.values()).filter(function (item) {
        return CONFIG.statusIds.includes(item.statusId);
      });
      state.ultimaAtualizacao = Date.now();
      atualizarStatus(`${state.chamados.length} chamados ativos • ${totalPaginas} página(s) consultada(s)`);
    } catch (falha) {
      console.error(PREFIXO, falha);
      atualizarStatus("Erro ao carregar a fila");
      toast("Não consegui carregar a fila do InfraDesk: " + texto(falha.message || falha), "erro");
    } finally {
      state.carregando = false;
      if (botao) botao.disabled = false;
    }
  }

  async function buscarPagina(pagina) {
    const resposta = await fetch(montarUrlFonte(pagina), {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Requested-With": "SigmaPainelDoca" },
    });

    if (!resposta.ok) throw new Error(`InfraDesk retornou HTTP ${resposta.status} na página ${pagina}.`);
    const html = await resposta.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const itens = extrairChamados(doc);
    itens.forEach(function (item, indice) {
      item._paginaFonte = pagina;
      item._indiceFonte = indice;
      item._ordemFonte = ((pagina - 1) * 100000) + indice;
    });
    return { doc: doc, itens: itens };
  }

  function localizarTabelaChamados(doc) {
    return doc.querySelector("table.table-chamados") || doc.querySelector('table tr[data-chamado-id]')?.closest("table") || null;
  }

  function obterTotalPaginas(doc) {
    const tabela = localizarTabelaChamados(doc);
    const textoPagina = texto(tabela?.querySelector(".paginator")?.textContent || "");
    const match = textoPagina.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
    if (match) return Math.max(1, Number(match[1]) || 1);

    let maior = 1;
    (tabela ? tabela.querySelectorAll('.pagination a[href*="page="]') : []).forEach(function (a) {
      try {
        const pagina = Number(new URL(a.href, window.location.origin).searchParams.get("page") || 0);
        if (pagina > maior) maior = pagina;
      } catch (_) {}
    });
    return maior;
  }

  // =========================================================
  // RESPONSAVEL_NOME_EXATO
  // Para localizar depois, use CTRL + F e procure por:
  // RESPONSAVEL_NOME_EXATO
  //
  // A célula de atendente contém nome, setor, cargo e tooltip do avatar.
  // Ler textContent da célula inteira juntava tudo, criando nomes falsos como
  // "Elias Araujo Adm - Liberação de NF". Agora buscamos somente o SPAN
  // visível do nome e usamos a lista real de atendentes como validação.
  // =========================================================
  function registrarAtendentesConhecidos(doc) {
    const encontrados = new Map();
    const seletores = [
      '#atendente-id option',
      'select[name="atendente_usuario_id"] option',
      'select[name*="atendente"] option',
    ];

    seletores.forEach(function (seletor) {
      doc.querySelectorAll(seletor).forEach(function (option) {
        const valor = texto(option.value || "");
        const nome = texto(option.textContent || "");
        if (!nome || !valor || valor === "null" || /^(todos|nenhum atendente|selecione)$/i.test(nome)) return;
        encontrados.set(chaveUsuario(nome), nome);
      });
    });

    (state.atendentesConhecidos || []).forEach(function (nome) {
      encontrados.set(chaveUsuario(nome), nome);
    });

    state.atendentesConhecidos = Array.from(encontrados.values()).sort(function (a, b) {
      return b.length - a.length;
    });
  }

  function decodificarHtml(valor) {
    const area = document.createElement('textarea');
    area.innerHTML = String(valor || '');
    return area.value;
  }

  function limparNomeAtendente(valor) {
    let bruto = texto(valor);
    if (!bruto || /nao capturado/i.test(normalizar(bruto))) return "";

    // Primeiro procura um nome conhecido dentro do texto contaminado.
    const brutoNorm = normalizar(bruto);
    const conhecido = (state.atendentesConhecidos || []).find(function (nome) {
      const alvo = normalizar(nome);
      return alvo && (brutoNorm === alvo || brutoNorm.includes(alvo));
    });
    if (conhecido) return conhecido;

    // Fallback defensivo para páginas que não trouxeram o select de atendentes.
    bruto = bruto
      .replace(/\s+(?:Central\s*-\s*)?Adm\s*-\s*Libera[cç][aã]o\s+de\s+NF\b.*$/i, "")
      .replace(/\s+Op\.\s*-\s*Recebimento\b.*$/i, "")
      .replace(/\s+Último acesso\b.*$/i, "")
      .trim();

    return texto(bruto);
  }

  function extrairNomeAtendente(celula) {
    if (!celula) return "";

    // Estrutura real da lista: td-atendente > div > [avatar, blocoNome] > span.
    const direto = celula.querySelector(':scope > div > div:last-child > span')
      || celula.querySelector('div[style*="line-height"] > span');
    let nome = limparNomeAtendente(direto?.textContent || "");
    if (nome) return nome;

    // Segunda fonte confiável: H6 dentro do tooltip HTML do avatar.
    const tooltipEl = celula.querySelector('[data-original-title*="user-info"], [data-original-title*="<h6"], [data-original-title*="&lt;h6"]');
    const tooltip = tooltipEl?.getAttribute('data-original-title') || "";
    if (tooltip) {
      const docTooltip = new DOMParser().parseFromString(decodificarHtml(tooltip), 'text/html');
      nome = limparNomeAtendente(docTooltip.querySelector('h6')?.textContent || "");
      if (nome) return nome;
    }

    return limparNomeAtendente(celula.textContent || "");
  }

  function extrairChamados(doc) {
    registrarAtendentesConhecidos(doc);
    const tabela = localizarTabelaChamados(doc);
    if (!tabela || !tabela.tBodies.length) return [];

    const grupos = new Map();
    Array.from(tabela.tBodies[0].children).forEach(function (tr) {
      const id = texto(tr.getAttribute("data-chamado-id") || extrairIdClasse(tr.className));
      if (!/^\d+$/.test(id)) return;
      if (!grupos.has(id)) grupos.set(id, []);
      grupos.get(id).push(tr);
    });

    const itens = [];
    grupos.forEach(function (rows, id) {
      const item = extrairUmChamado(id, rows);
      if (item) itens.push(item);
    });
    return itens;
  }

  function extrairIdClasse(classes) {
    const match = String(classes || "").match(/list-chamado-(\d+)/i);
    return match ? match[1] : "";
  }

  function extrairUmChamado(id, rows) {
    const principal = rows.find(function (tr) { return !!tr.querySelector(".btn-lista-status"); });
    if (!principal) return null;

    const celulas = Array.from(principal.children).filter(function (el) { return el.tagName === "TD"; });
    if (celulas.length < 6) return null;

    const linhaDatas = rows.find(function (tr) { return normalizar(tr.textContent).includes("atualizado em"); });
    const linhaAcoes = rows.find(function (tr) { return !!tr.querySelector(`.chamado-item[data-chamado-id="${id}"]`); });
    const linhaDetalhes = rows.find(function (tr) { return !!tr.querySelector(".chamado-format, .chamado-tags"); });
    const resumo = linhaAcoes?.querySelector(".copy-resumo-hidden");

    const statusBtn = principal.querySelector(".btn-lista-status");
    const statusId = texto(statusBtn?.getAttribute("data-chamado-status-id") || "");
    const statusNome = texto(statusBtn?.querySelector("span")?.textContent || CONFIG.statusNomes[statusId] || "");
    const prioridade = texto(principal.querySelector(".btn-lista-prioridade span")?.textContent || celulas[5]?.textContent || "");

    const categoria = texto(resumo?.querySelector(".item-categoria:not(.item-subcategoria)")?.textContent || celulas[1]?.querySelector("b")?.textContent || "");
    const subcategoria = texto(resumo?.querySelector(".item-subcategoria")?.textContent || removerPrimeiroTexto(celulas[1]?.textContent || "", categoria));
    const loja = texto(resumo?.querySelector(".item-data-empresa")?.textContent || extrairEmpresaLinha(linhaAcoes));
    const fornecedor = texto(resumo?.querySelector(".item-data-fornecedor")?.textContent || extrairFornecedorLinha(linhaAcoes));
    const descricaoResumo = texto(resumo?.querySelector(".item-ultima-descricao-copy")?.textContent || "");

    const solicitanteInfo = extrairSolicitante(principal, celulas[2]);
    const celulaAtendente = principal.querySelector('.td-atendente') || celulas[3];
    const atendenteExtraido = extrairNomeAtendente(celulaAtendente);
    const capturado = statusBtn?.getAttribute("data-is-capturado") === "1" || !!atendenteExtraido;
    const atendente = capturado ? atendenteExtraido : "";

    const datas = extrairDatas(linhaDatas);

    // DATA_HORA_REAL_DA_ABERTURA
    // A linha de datas do InfraDesk costuma trazer somente DD/MM/AAAA, enquanto
    // o resumo oculto entrega DD/MM/AAAA HH:mm. A hora completa precisa ter
    // prioridade para a fila FIFO não colocar chamados novos na frente.
    const aberturaResumoTexto = texto(resumo?.querySelector(".item-data-abertura")?.textContent || "");
    const aberturaTexto = aberturaResumoTexto || datas.abertura || "";
    const atualizadoTexto = datas.atualizado || aberturaTexto;
    const atualizadoPor = datas.atualizadoPor || solicitanteInfo.nome;

    const tagsInfo = extrairTags(linhaDetalhes);
    const nota = extrairNota(descricaoResumo, tagsInfo, linhaDetalhes);
    const chaveInfo = extrairChaveNf(tagsInfo, linhaDetalhes, rows);
    const descricaoCompleta = texto(linhaDetalhes?.querySelector(".chamado-format")?.textContent || descricaoResumo);

    const sla = extrairSla(principal, rows);
    const capturaEl = linhaAcoes?.querySelector('.capturar-btn, a[_onclick*="capturarChamadoNew"], a[onclick*="capturarChamadoNew"]');
    const capturaCodigo = texto(
      capturaEl?.getAttribute("data-tm-doca-native-onclick") ||
      capturaEl?.getAttribute("_onclick") ||
      capturaEl?.getAttribute("onclick") || ""
    );
    const grupoMatch = capturaCodigo.match(/capturarChamadoNew\s*\(\s*\d+\s*,\s*(\d+)/i);
    const grupoId = grupoMatch ? grupoMatch[1] : String(CONFIG.grupoAtendimentoPadrao);

    const anexosUrl = linhaAcoes?.querySelector('a[href*="/backend/chamados/anexos/"]')?.getAttribute("href") || `/backend/chamados/anexos/${id}`;
    const feedbackUrl = linhaAcoes?.querySelector('a[href*="/backend/chamados/enviarEmail/"]')?.getAttribute("href") || `/backend/chamados/enviarEmail/${id}?ocultar=false`;
    const detalhesLink = principal.querySelector('a[href*="/backend/chamados/detalhes/"][data-target="#Modalv"]')
      || principal.querySelector('a[href*="/backend/chamados/detalhes/"]');
    const detalhesUrl = detalhesLink?.getAttribute("href") || `/backend/chamados/detalhes/${id}?action=lista`;

    const item = {
      id,
      statusId,
      statusNome: statusNome || CONFIG.statusNomes[statusId] || `Status ${statusId}`,
      categoria,
      subcategoria,
      prioridade,
      loja,
      fornecedor,
      solicitante: solicitanteInfo.nome,
      representante: solicitanteInfo.nome,
      solicitanteSetor: solicitanteInfo.setor,
      atendente,
      capturado,
      aberturaTexto,
      abertura: parseDataHoraBr(aberturaTexto),
      atualizadoTexto,
      atualizado: parseDataHoraBr(atualizadoTexto),
      atualizadoPor,
      descricaoResumo: descricaoResumo || descricaoCompleta,
      descricaoCompleta,
      nota,
      chaveNf: chaveInfo.chaveAcesso,
      chaveNfTexto: chaveInfo.texto,
      chaveNfEhAcesso: chaveInfo.ehAcesso,
      tags: tagsInfo.tags,
      tagsLista: tagsInfo.lista,
      slaPercentual: sla.percentual,
      slaTexto: sla.texto,
      grupoId,
      podeCapturar: !!capturaEl && ["2", "5"].includes(statusId),
      detalhesUrl,
      anexosUrl,
      feedbackUrl,
    };

    item.busca = normalizar([
      item.id, item.statusNome, item.categoria, item.subcategoria, item.prioridade,
      item.fornecedor, item.representante, item.solicitante, item.solicitanteSetor,
      item.atendente, item.atualizadoPor, item.descricaoResumo, item.descricaoCompleta,
      item.nota, item.chaveNf, item.chaveNfTexto, item.tagsLista.map(function (t) { return `${t.label} ${t.valor}`; }).join(" "),
    ].join(" "));

    return item;
  }

  function removerPrimeiroTexto(valor, remover) {
    const v = texto(valor);
    if (!remover) return v;
    return texto(v.replace(new RegExp(escaparRegex(remover), "i"), ""));
  }

  function escaparRegex(valor) {
    return String(valor || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extrairEmpresaLinha(linha) {
    const div = linha?.querySelector(".row > div:first-child");
    return texto(div?.textContent || "").replace(/^\s*$/, "");
  }

  function extrairFornecedorLinha(linha) {
    const link = linha?.querySelector('a[href*="/backend/fornecedores/contato/"]');
    return texto(link?.textContent || "");
  }

  function extrairSolicitante(principal, celula) {
    const out = { nome: "", setor: "" };
    const tooltip = principal.querySelector(".avatar-user-card .img-circle")?.getAttribute("data-original-title") || "";

    if (tooltip) {
      const temp = new DOMParser().parseFromString(`<body>${tooltip}</body>`, "text/html");
      out.nome = texto(temp.querySelector("h6")?.textContent || "");
      out.setor = texto(temp.querySelector("p")?.textContent || "");
    }

    if (!out.nome && celula) {
      const span = celula.querySelector("span");
      out.nome = texto(span?.textContent || celula.textContent || "");
      out.setor = texto(celula.querySelector("small")?.textContent || "");
    }

    return out;
  }

  function extrairDatas(linha) {
    const out = { abertura: "", captura: "", desenvolvimento: "", finalizado: "", atualizado: "", atualizadoPor: "" };
    if (!linha) return out;

    linha.querySelectorAll(".row > div").forEach(function (bloco) {
      const label = normalizar(bloco.querySelector("strong")?.textContent || "");
      const clone = bloco.cloneNode(true);
      clone.querySelectorAll("strong").forEach(function (el) { el.remove(); });
      const valor = texto(clone.textContent);

      if (label.includes("abertura")) out.abertura = valor;
      else if (label.includes("captura")) out.captura = valor;
      else if (label.includes("desenvolvimento")) out.desenvolvimento = valor;
      else if (label.includes("finalizado")) out.finalizado = valor;
      else if (label.includes("atualizado em")) out.atualizado = valor;
      else if (label.includes("atualizado por")) out.atualizadoPor = valor;
    });

    return out;
  }

  // =========================================================
  // TAGS_OCULTAS_DA_LISTA
  // Para localizar depois, use CTRL + F e procure por:
  // TAGS_OCULTAS_DA_LISTA
  //
  // No Kanban as tags usam .chamado-tag-item, porém na visão em lista o
  // InfraDesk usa .item-chamado-tag. A versão anterior lia apenas a primeira
  // classe e ignorava justamente o número da NF existente na linha oculta.
  // =========================================================
  function extrairTags(linha) {
    const tags = {};
    const lista = [];
    if (!linha) return { tags, lista };

    linha.querySelectorAll(
      ".chamado-tag-item, .item-chamado-tag, [data-tag-id][data-tag-atributo]"
    ).forEach(function (el) {
      const label = texto(el.querySelector("b")?.textContent || "")
        .replace(/^['"`]+/, "")
        .replace(/[:：]\s*$/, "");
      const valor = texto(el.querySelector("span")?.textContent || "");
      if (!label || !valor) return;
      const key = normalizar(label).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      if (!key) return;
      tags[key] = valor;
      lista.push({ label, key, valor });
    });

    return { tags, lista };
  }

  function extrairNota(resumo, tagsInfo, linha) {
    const candidatos = [
      resumo,
      tagsInfo.tags.chave_da_nf,
      tagsInfo.tags.numero_da_nf,
      tagsInfo.tags.nf,
      texto(linha?.querySelector(".chamado-format")?.textContent || ""),
    ].filter(Boolean);

    for (const candidato of candidatos) {
      const bruto = String(candidato);
      const antesDaChave = bruto.match(/^\s*([\d.\-\/]{5,12})\s*\(\s*\d{44}\s*\)/);
      if (antesDaChave) return texto(antesDaChave[1]);

      const match = bruto.match(/\bNF\s*[º°o#:]?\s*([\d.\-\/]+)/i) || bruto.match(/^\s*(\d{5,12})\s*$/);
      if (match) return texto(match[1]);

      const chave = (bruto.match(/\b(\d{44})\b/) || [])[1];
      if (chave) return numeroNfDaChave(chave);
    }
    return "";
  }

  function numeroNfDaChave(chave) {
    const digitos = String(chave || "").replace(/\D+/g, "");
    if (digitos.length !== 44) return "";
    const numeroComZeros = digitos.slice(25, 34);
    return String(Number(numeroComZeros) || numeroComZeros);
  }

  function extrairChaveNf(tagsInfo, linha, rows) {
    // CHAVE_DIRETA_DO_KANBAN
    // O Kanban pode usar duas classes diferentes, mas o valor permanece no
    // atributo 1 do grupo de Liberação de NF. Também aceitamos o marcador
    // data-copy-liberado-fornecedor usado em outra versão do HTML.
    const blocosDiretos = Array.from(linha?.querySelectorAll?.(
      '[data-tag-atributo="1"], [data-copy-liberado-fornecedor="1"]'
    ) || []);
    const blocoChaveDireto = blocosDiretos.find(function (el) {
      return normalizar(el.querySelector("b")?.textContent || el.textContent || "").includes("chave");
    });
    const valorChaveDireto = texto(blocoChaveDireto?.querySelector("span")?.textContent || "");

    const aliases = [
      valorChaveDireto,
      tagsInfo.tags.chave_da_nf,
      tagsInfo.tags.chave_nf,
      tagsInfo.tags.chave_nfe,
      tagsInfo.tags.chave_de_acesso,
      tagsInfo.tags.chave_acesso,
      tagsInfo.tags.chave_da_nfe,
    ].map(texto).filter(Boolean);

    const textoTodasLinhas = (rows || []).map(function (tr) {
      return texto(tr?.textContent || "");
    }).join(" ");

    const textoGeral = [
      ...aliases,
      ...Object.values(tagsInfo.tags),
      texto(linha?.textContent || ""),
      textoTodasLinhas,
    ].join(" ");

    const match44 = textoGeral.match(/\b(\d{44})\b/);
    const bruto = aliases[0] || (match44 ? match44[1] : "");

    return {
      texto: bruto,
      chaveAcesso: match44 ? match44[1] : "",
      ehAcesso: !!match44,
    };
  }

  function extrairSla(principal, rows) {
    const pie = texto(principal.querySelector("span.pie")?.textContent || "");
    const percentualTexto = texto(principal.querySelector('td:last-child b')?.textContent || "");
    let percentual = Number((percentualTexto.match(/\d+/) || [0])[0]) || 0;

    if (!percentual && pie.includes("/")) {
      const [atual, total] = pie.split("/").map(Number);
      if (total > 0) percentual = Math.round((atual / total) * 100);
    }

    const linhaSla = rows.find(function (tr) { return normalizar(tr.textContent).includes("restante sla"); });
    const textoLinhaSla = texto(linhaSla?.textContent || "");
    const textoSla = /\d/.test(textoLinhaSla) ? textoLinhaSla : (pie || percentualTexto);
    return { percentual: Math.max(0, Math.min(100, percentual)), texto: textoSla || percentualTexto || pie };
  }

  // =========================================================
  // COMPLETAR_NF_E_CHAVE_EM_SEGUNDO_PLANO
  // Para localizar depois, use CTRL + F e procure por:
  // COMPLETAR_NF_E_CHAVE_EM_SEGUNDO_PLANO
  //
  // Algumas solicitações novas chegam na lista apenas com prioridade "Média"
  // e sem os atributos expandidos. Nesses casos o painel consulta somente os
  // chamados incompletos, tenta primeiro o fragmento leve /card/{id}/lista e,
  // se necessário, lê a aba Tags dos detalhes. O resultado fica em cache pela
  // data da última movimentação para não repetir dezenas de consultas.
  // =========================================================
  function ehPrioridadeGenerica(valor) {
    return /^(baixa|media|média|alta|urgente|critica|crítica|normal|sem prioridade)$/i.test(texto(valor));
  }

  function precisaCompletarDadosNf(item) {
    if (!item) return false;
    return !item.nota || !item.chaveNf || !item.subcategoria || ehPrioridadeGenerica(item.prioridade);
  }

  function chaveCacheComplementoNf(item) {
    return `sigma_doca_complemento_nf_v4_estavel_${item.id}`;
  }

  function lerCacheComplementoNf(item) {
    try {
      const chave = chaveCacheComplementoNf(item);
      const chaveAntiga = `sigma_doca_complemento_nf_v3_kanban_${item.id}`;
      const raw = localStorage.getItem(chave)
        || sessionStorage.getItem(chave)
        || sessionStorage.getItem(chaveAntiga)
        || localStorage.getItem(chaveAntiga);
      if (!raw) return null;
      const cache = JSON.parse(raw);
      if (!cache || !cache.salvoEm || Date.now() - cache.salvoEm > CONFIG.cacheComplementoNfMs) return null;
      const dados = cache.dados || null;
      if (!dados || !Object.keys(dados).some(function (campo) {
        const valor = dados[campo];
        if (Array.isArray(valor)) return valor.length > 0;
        if (valor && typeof valor === "object") return Object.keys(valor).length > 0;
        return !!texto(valor);
      })) return null;
      return dados;
    } catch (_) {
      return null;
    }
  }

  function salvarCacheComplementoNf(item, dados) {
    try {
      const conteudo = JSON.stringify({
        salvoEm: Date.now(),
        dados: dados || {},
      });
      localStorage.setItem(chaveCacheComplementoNf(item), conteudo);
    } catch (_) {
      try {
        sessionStorage.setItem(chaveCacheComplementoNf(item), JSON.stringify({ salvoEm: Date.now(), dados: dados || {} }));
      } catch (_) {}
    }
  }

  function aplicarCacheComplementosAntesDaPrimeiraRenderizacao() {
    state.chamados.forEach(function (item) {
      if (!precisaCompletarDadosNf(item)) return;
      const cache = lerCacheComplementoNf(item);
      if (cache) aplicarComplementoNf(item, cache);
    });
  }

  function montarBuscaItem(item) {
    item.busca = normalizar([
      item.id, item.statusNome, item.categoria, item.subcategoria, item.prioridade,
      item.fornecedor, item.representante, item.solicitante, item.solicitanteSetor,
      item.atendente, item.atualizadoPor, item.descricaoResumo, item.descricaoCompleta,
      item.nota, item.chaveNf, item.chaveNfTexto,
      (item.tagsLista || []).map(function (t) { return `${t.label} ${t.valor}`; }).join(" "),
    ].join(" "));
  }

  function aplicarComplementoNf(item, dados) {
    if (!item || !dados) return false;
    let mudou = false;

    const atribuir = function (campo, valor, sobrescrever) {
      valor = texto(valor);
      if (!valor) return;
      if (!sobrescrever && texto(item[campo])) return;
      if (texto(item[campo]) === valor) return;
      item[campo] = valor;
      mudou = true;
    };

    // A Lista costuma trazer somente o número da NF. Quando o Kanban devolver
    // os 44 dígitos, essa informação mais completa deve substituir o valor
    // parcial que já estava no item ou no cache.
    const chaveNova = texto(dados.chaveNf).replace(/\D+/g, "");
    const chaveAtual = texto(item.chaveNf).replace(/\D+/g, "");
    if (chaveNova.length === 44 && chaveAtual.length !== 44) {
      item.chaveNf = chaveNova;
      mudou = true;
    } else {
      atribuir("chaveNf", dados.chaveNf, false);
    }

    const chaveTextoNova = texto(dados.chaveNfTexto || dados.chaveNf);
    const textoAtualTem44 = /\b\d{44}\b/.test(texto(item.chaveNfTexto));
    const textoNovoTem44 = /\b\d{44}\b/.test(chaveTextoNova);
    atribuir("chaveNfTexto", chaveTextoNova, textoNovoTem44 && !textoAtualTem44);

    if (chaveNova.length === 44 || textoNovoTem44) item.chaveNfEhAcesso = true;

    atribuir("nota", dados.nota || numeroNfDaChave(dados.chaveNf), false);
    atribuir("categoria", dados.categoria, false);
    atribuir("subcategoria", dados.subcategoria, false);

    if (dados.prioridade && (!item.prioridade || ehPrioridadeGenerica(item.prioridade))) {
      atribuir("prioridade", dados.prioridade, true);
    }

    if (dados.tags && Object.keys(dados.tags).length) {
      item.tags = Object.assign({}, item.tags || {}, dados.tags);
      mudou = true;
    }
    if (Array.isArray(dados.tagsLista) && dados.tagsLista.length) {
      item.tagsLista = dados.tagsLista;
      mudou = true;
    }

    if (mudou) montarBuscaItem(item);
    return mudou;
  }

  function extrairCategoriaDosDetalhes(doc) {
    const textoCategoria = texto(
      doc.querySelector(".categoria-container .dados-description")?.textContent
      || doc.querySelector('select[name="categoria_id"] option[selected]')?.textContent
      || doc.querySelector('select[name="categoria_id"] option:checked')?.textContent
      || ""
    );

    if (!textoCategoria) return { categoria: "", subcategoria: "" };
    const partes = textoCategoria.split(/\s+-\s+/).map(texto).filter(Boolean);
    if (partes.length >= 2) {
      return { categoria: partes.shift(), subcategoria: partes.join(" - ") };
    }
    return { categoria: textoCategoria, subcategoria: "" };
  }

  function extrairComplementoDeDocumento(doc) {
    if (!doc) return {};
    const tagsInfo = extrairTags(doc);
    const chaveInfo = extrairChaveNf(tagsInfo, doc.body || doc.documentElement, []);
    const categoria = extrairCategoriaDosDetalhes(doc);
    const prioridade = texto(doc.querySelector(".dados-prioridade-description")?.textContent || "");
    const nota = extrairNota("", tagsInfo, doc.body || doc.documentElement) || numeroNfDaChave(chaveInfo.chaveAcesso);

    return {
      nota,
      chaveNf: chaveInfo.chaveAcesso,
      chaveNfTexto: chaveInfo.texto,
      categoria: categoria.categoria,
      subcategoria: categoria.subcategoria,
      prioridade: ehPrioridadeGenerica(prioridade) ? "" : prioridade,
      tags: tagsInfo.tags,
      tagsLista: tagsInfo.lista,
    };
  }

  function documentoDeFragmentoTabela(html) {
    return new DOMParser().parseFromString(`<table><tbody>${html}</tbody></table>`, "text/html");
  }


  // =========================================================
  // CHAVE_VINDA_DO_CARD_KANBAN
  // Para localizar depois, use CTRL + F e procure por:
  // CHAVE_VINDA_DO_CARD_KANBAN
  //
  // /card/{id}/lista devolve a versão resumida e frequentemente contém apenas
  // o número da NF. /card/{id}, sem "/lista", devolve o cartão do Kanban, onde
  // o InfraDesk inclui número e chave de acesso no mesmo SPAN.
  // =========================================================
  function documentoDeCardKanban(html) {
    return new DOMParser().parseFromString(`<ul>${html}</ul>`, "text/html");
  }

  function extrairComplementoDeCardKanban(card) {
    if (!card) return {};
    const tagsInfo = extrairTags(card);
    const chaveInfo = extrairChaveNf(tagsInfo, card, []);
    const categoria = texto(card.querySelector(".item-categoria:not(.item-subcategoria)")?.textContent || "");
    const subcategoria = texto(card.querySelector(".item-subcategoria")?.textContent || "");
    const nota = extrairNota("", tagsInfo, card) || numeroNfDaChave(chaveInfo.chaveAcesso);

    return {
      nota,
      chaveNf: chaveInfo.chaveAcesso,
      chaveNfTexto: chaveInfo.texto,
      categoria,
      subcategoria,
      tags: tagsInfo.tags,
      tagsLista: tagsInfo.lista,
    };
  }

  function montarUrlFonteKanbanCompleto() {
    const url = new URL("/backend/chamados/painel", window.location.origin);
    url.searchParams.set("is_active", "1");
    url.searchParams.set("is_inativo", "0");
    url.searchParams.set("status_id[0]", "-1");
    url.searchParams.set("categoria_ignorar", "0");
    url.searchParams.set("sort", "id");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("sigma_fonte_chaves", String(Date.now()));
    return url.toString();
  }

  async function carregarMapaComplementoKanban() {
    if (state.mapaComplementoKanbanPromise) return state.mapaComplementoKanbanPromise;
    if (state.mapaComplementoKanban && Date.now() - state.mapaComplementoKanbanEm < 90 * 1000) {
      return state.mapaComplementoKanban;
    }

    state.mapaComplementoKanbanPromise = (async function () {
      const resposta = await fetch(montarUrlFonteKanbanCompleto(), {
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Requested-With": "SigmaPainelDocaChaves" },
      });
      if (!resposta.ok) throw new Error(`Kanban retornou HTTP ${resposta.status}.`);

      const html = await resposta.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const mapa = new Map();
      doc.querySelectorAll('li.chamado-item[data-chamado-id]').forEach(function (card) {
        const id = texto(card.getAttribute("data-chamado-id") || "");
        if (!id) return;
        mapa.set(id, extrairComplementoDeCardKanban(card));
      });

      state.mapaComplementoKanban = mapa;
      state.mapaComplementoKanbanEm = Date.now();
      return mapa;
    })();

    try {
      return await state.mapaComplementoKanbanPromise;
    } finally {
      state.mapaComplementoKanbanPromise = null;
    }
  }

  async function buscarComplementoNoCardKanban(item) {
    const resposta = await fetch(`/backend/chamados/card/${encodeURIComponent(item.id)}?_=${Date.now()}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (!resposta.ok) return null;
    const html = await resposta.text();
    const doc = documentoDeCardKanban(html);
    const card = doc.querySelector(`li.chamado-item[data-chamado-id="${item.id}"]`)
      || doc.querySelector("li.chamado-item")
      || doc.body;
    return extrairComplementoDeCardKanban(card);
  }

  async function buscarComplementoNoCard(item) {
    const resposta = await fetch(`/backend/chamados/card/${encodeURIComponent(item.id)}/lista?_=${Date.now()}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (!resposta.ok) return null;
    const html = await resposta.text();
    const doc = documentoDeFragmentoTabela(html);
    const rows = Array.from(doc.querySelectorAll(`tr[data-chamado-id="${item.id}"], tr.list-chamado-${item.id}`));
    if (!rows.length) return extrairComplementoDeDocumento(doc);

    const completo = extrairUmChamado(item.id, rows);
    if (!completo) return extrairComplementoDeDocumento(doc);
    return {
      nota: completo.nota,
      chaveNf: completo.chaveNf,
      chaveNfTexto: completo.chaveNfTexto,
      categoria: completo.categoria,
      subcategoria: completo.subcategoria,
      prioridade: completo.prioridade,
      tags: completo.tags,
      tagsLista: completo.tagsLista,
    };
  }

  async function buscarComplementoNosDetalhes(item) {
    const url = new URL(item.detalhesUrl || `/backend/chamados/detalhes/${encodeURIComponent(item.id)}?action=lista`, window.location.origin);
    url.searchParams.set("tab", "tab-tags");
    url.searchParams.set("sigma_complemento_nf", String(Date.now()));

    const resposta = await fetch(url.toString(), {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (!resposta.ok) return null;
    const html = await resposta.text();
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    return extrairComplementoDeDocumento(doc);
  }

  async function buscarComplementoNf(item) {
    let combinado = {};

    const mesclar = function (dados) {
      if (!dados) return;
      ["nota", "chaveNf", "chaveNfTexto", "categoria", "subcategoria", "prioridade"].forEach(function (campo) {
        const novo = texto(dados[campo]);
        if (!novo) return;
        const atual = texto(combinado[campo]);
        const novoTem44 = /\b\d{44}\b/.test(novo) || (campo === "chaveNf" && novo.replace(/\D+/g, "").length === 44);
        const atualTem44 = /\b\d{44}\b/.test(atual) || (campo === "chaveNf" && atual.replace(/\D+/g, "").length === 44);
        if (!atual || (novoTem44 && !atualTem44)) combinado[campo] = novo;
      });
      if (dados.tags) combinado.tags = Object.assign({}, combinado.tags || {}, dados.tags);
      if (Array.isArray(dados.tagsLista) && dados.tagsLista.length) combinado.tagsLista = dados.tagsLista;
    };

    // 1) Fonte correta da chave: cartão do Kanban, sem o sufixo /lista.
    try {
      const kanban = await buscarComplementoNoCardKanban(item);
      mesclar(kanban);
      if (texto(combinado.chaveNf).replace(/\D+/g, "").length === 44) return combinado;
    } catch (falha) {
      console.debug(PREFIXO, `Card Kanban #${item.id} não trouxe a chave.`, falha);
    }

    // 2) A lista continua útil para número, categoria e demais informações.
    try {
      mesclar(await buscarComplementoNoCard(item));
    } catch (falha) {
      console.debug(PREFIXO, `Card da lista #${item.id} não trouxe os dados.`, falha);
    }

    // 3) Último fallback: detalhes do chamado.
    try {
      mesclar(await buscarComplementoNosDetalhes(item));
    } catch (falha) {
      console.debug(PREFIXO, `Detalhes complementares #${item.id} não trouxeram os dados.`, falha);
    }

    return Object.keys(combinado).length ? combinado : null;
  }

  async function completarDadosNfAusentesEmSegundoPlano() {
    if (!CONFIG.completarDadosNfAusentes || state.enriquecendoDadosNf || state.carregando) return;

    const pendentes = state.chamados.filter(function (item) {
      if (!precisaCompletarDadosNf(item)) return false;
      if (texto(state.complementoNfTentado[item.id]) === texto(item.atualizadoTexto || "sem-data")) return false;
      return true;
    });
    if (!pendentes.length) return;

    state.enriquecendoDadosNf = true;
    let restantes = pendentes.slice();
    const tamanhoLote = Math.max(5, Number(CONFIG.complementoLoteTamanho) || 18);

    try {
      // Uma leitura do Kanban continua sendo mais barata que centenas de
      // requisições, porém a aplicação dos resultados é dividida em lotes.
      if (pendentes.length >= 8) {
        const mapaKanban = await carregarMapaComplementoKanban();
        const semChave = [];
        let alterados = [];

        for (let i = 0; i < pendentes.length; i++) {
          const item = pendentes[i];
          const dados = mapaKanban?.get(item.id);
          if (!dados) {
            semChave.push(item);
          } else {
            if (aplicarComplementoNf(item, dados)) alterados.push(item.id);
            salvarCacheComplementoNf(item, dados);
            if (!item.chaveNf || String(item.chaveNf).replace(/\D+/g, "").length !== 44) semChave.push(item);
          }

          if (alterados.length >= tamanhoLote) {
            agendarAtualizacaoLinhasParciais(alterados);
            alterados = [];
          }
          if ((i + 1) % tamanhoLote === 0) await cederAoNavegador();
        }

        if (alterados.length) agendarAtualizacaoLinhasParciais(alterados);
        restantes = semChave;
      }
    } catch (falha) {
      console.debug(PREFIXO, "Não foi possível ler o Kanban completo; usando cards individuais.", falha);
    }

    let proximo = 0;
    const total = restantes.length;
    const quantidade = Math.max(1, Math.min(CONFIG.consultasComplementaresSimultaneas || 1, total || 1));
    const workers = Array.from({ length: quantidade }, function () {
      return (async function () {
        while (true) {
          const indice = proximo++;
          if (indice >= total) return;
          const item = restantes[indice];
          state.complementoNfTentado[item.id] = item.atualizadoTexto || "sem-data";

          try {
            const dados = await buscarComplementoNf(item);
            if (dados) {
              const mudou = aplicarComplementoNf(item, dados);
              salvarCacheComplementoNf(item, dados);
              if (mudou) agendarAtualizacaoLinhasParciais([item.id]);
            }
          } catch (falha) {
            console.debug(PREFIXO, `Não consegui complementar o chamado #${item.id}.`, falha);
          }

          // Mesmo com uma única consulta, entrega o controle ao navegador
          // entre os chamados para rolagem, seleção e Ctrl+C continuarem vivos.
          await cederAoNavegador();
        }
      })();
    });

    try {
      await Promise.all(workers);
      executarQuandoOcioso(reconstruirFiltros, 500);
      agendarSincronizacaoPonteVisivel();
    } finally {
      state.enriquecendoDadosNf = false;
    }
  }

  // =========================================================
  // FIREBASE
  // =========================================================
  function firebaseUrl(caminho) {
    const base = CONFIG.firebaseBase.replace(/\/+$/, "");
    return `${base}/${String(caminho || "").replace(/^\/+/, "")}.json`;
  }

  function gmRequest(opcoes) {
    return new Promise(function (resolve, reject) {
      const req = {
        method: opcoes.method || "GET",
        url: opcoes.url,
        headers: opcoes.headers || {},
        data: opcoes.data == null ? null : opcoes.data,
        timeout: opcoes.timeout || 20000,
        onload: resolve,
        onerror: function (erro) { reject(erro || new Error("Erro de rede")); },
        ontimeout: function () { reject(new Error("Tempo esgotado no Firebase")); },
      };

      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest(req);
        return;
      }
      if (typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function") {
        Promise.resolve(GM.xmlHttpRequest(req)).then(resolve).catch(reject);
        return;
      }
      reject(new Error("Tampermonkey não disponibilizou GM_xmlhttpRequest."));
    });
  }

  async function carregarReservas() {
    try {
      const res = await gmRequest({
        method: "GET",
        // Baixa somente as travas mínimas. Nunca mais baixa o histórico by_id.
        url: firebaseUrl(`${CONFIG.firebaseRoot}/${CONFIG.firebaseReservasAtivas}`) + `?_=${Date.now()}`,
      });
      if (res.status >= 200 && res.status < 300) {
        state.reservas = JSON.parse(res.responseText || "{}") || {};
        limparReservasExpiradasDoCache();
      }
    } catch (falha) {
      console.warn(PREFIXO, "Não consegui carregar reservas", falha);
    }
  }

  function timestampReserva(reserva) {
    return Number(reserva?.reservadoEm || reserva?.capturadoEm || reserva?.atualizadoEm || reserva?.ts || 0) || 0;
  }

  function reservaExpirada(reserva) {
    const ts = timestampReserva(reserva);
    return !!ts && Date.now() - ts > CONFIG.reservaValidadeMs;
  }

  function limparReservasExpiradasDoCache() {
    const expiradas = [];
    Object.keys(state.reservas || {}).forEach(function (id) {
      if (!reservaExpirada(state.reservas[id])) return;
      delete state.reservas[id];
      expiradas.push(id);
    });

    if (!expiradas.length || limparReservasExpiradasDoCache.executando) return;
    limparReservasExpiradasDoCache.executando = true;

    const patch = {};
    expiradas.forEach(function (id) { patch[id] = null; });
    gmRequest({
      method: "PATCH",
      url: firebaseUrl(`${CONFIG.firebaseRoot}/${CONFIG.firebaseReservasAtivas}`) + `?print=silent&_=${Date.now()}`,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(patch),
      timeout: 12000,
    }).catch(function (falha) {
      console.warn(PREFIXO, "Não consegui limpar travas antigas", falha);
    }).finally(function () {
      limparReservasExpiradasDoCache.executando = false;
    });
  }

  function donoReserva(item) {
    const reserva = state.reservas[item.id];
    if (!reserva || reservaExpirada(reserva)) return "";
    return limparNomeAtendente(reserva.usuario || reserva.operador || reserva.nome || "");
  }

  function reservaMinha(item) {
    const dono = donoReserva(item);
    return dono && mesmaPessoa(dono, state.usuario.nome || state.usuario.login);
  }

  // =========================================================
  // RESPONSAVEL_EFETIVO_FIREBASE_OU_INFRADESK
  // Para localizar depois, use CTRL + F e procure por:
  // RESPONSAVEL_EFETIVO_FIREBASE_OU_INFRADESK
  //
  // A reserva do Firebase tem prioridade. Quando ela não existe,
  // o atendente informado pelo próprio InfraDesk passa a definir
  // se o chamado é meu, livre ou pertencente a outro operador.
  // Isso impede chamados de outros atendentes de entrarem em
  // "Livres + minhas" apenas porque não possuem trava no Firebase.
  // =========================================================
  function responsavelEfetivo(item) {
    const usuarioAtual = state.usuario.nome || state.usuario.login;
    const reserva = donoReserva(item);

    if (reserva) {
      return {
        nome: reserva,
        minha: mesmaPessoa(reserva, usuarioAtual),
        origem: "firebase",
      };
    }

    const atendente = limparNomeAtendente(item && item.atendente || "");
    if (atendente) {
      item.atendente = atendente;
      return {
        nome: atendente,
        minha: mesmaPessoa(atendente, usuarioAtual),
        origem: "infradesk",
      };
    }

    return {
      nome: "",
      minha: false,
      origem: "livre",
    };
  }

  async function tentarReservar(item) {
    const usuario = texto(state.usuario.nome || state.usuario.login);
    if (!usuario) throw new Error("Não consegui identificar o usuário logado.");

    const caminho = `${CONFIG.firebaseRoot}/by_id/${encodeURIComponent(item.id)}`;
    const leitura = await gmRequest({ method: "GET", url: firebaseUrl(caminho) + `?_=${Date.now()}`, timeout: 12000 });
    if (leitura.status < 200 || leitura.status >= 300) throw new Error(`Firebase GET ${leitura.status}`);

    const existente = JSON.parse(leitura.responseText || "null");
    if (existente && !reservaExpirada(existente)) {
      const dono = texto(existente.usuario || existente.operador || existente.nome || "");
      if (dono && !mesmaPessoa(dono, usuario)) {
        return { ok: false, dono, reserva: existente };
      }
    }

    const ts = Date.now();
    const payload = {
      chamadoId: item.id,
      operador: usuario,
      usuario,
      usuarioNorm: chaveUsuario(usuario),
      ts,
      reservadoEm: ts,
      expiraEm: ts + CONFIG.reservaValidadeMs,
      origem: "tampermonkey-painel-doca-lock",
    };

    const patchReserva = {};
    patchReserva[`by_id/${item.id}`] = payload;
    patchReserva[`${CONFIG.firebaseReservasAtivas}/${item.id}`] = payload;

    const gravacao = await gmRequest({
      method: "PATCH",
      url: firebaseUrl(CONFIG.firebaseRoot) + `?print=silent&_=${Date.now()}`,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(patchReserva),
      timeout: 12000,
    });
    if (gravacao.status < 200 || gravacao.status >= 300) throw new Error(`Firebase PATCH ${gravacao.status}`);

    state.reservas[item.id] = payload;
    return { ok: true, reserva: payload };
  }

  async function liberarReserva(id) {
    try {
      const patch = {};
      patch[`by_id/${id}`] = null;
      patch[`${CONFIG.firebaseReservasAtivas}/${id}`] = null;
      const res = await gmRequest({
        method: "PATCH",
        url: firebaseUrl(CONFIG.firebaseRoot) + `?print=silent&_=${Date.now()}`,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(patch),
      });
      if (res.status >= 200 && res.status < 300) {
        delete state.reservas[id];
        return true;
      }
    } catch (falha) {
      console.warn(PREFIXO, "Falha ao liberar reserva", falha);
    }
    return false;
  }

  async function salvarCapturaCompleta(item) {
    const usuario = texto(state.usuario.nome || state.usuario.login);
    const ts = Date.now();
    const expiraEm = ts + CONFIG.reservaValidadeMs;
    const payload = {
      chamadoId: item.id,
      operador: usuario,
      usuario,
      usuarioNorm: chaveUsuario(usuario),
      usuarioId: texto(state.usuario.id),
      statusId: "3",
      statusNome: CONFIG.statusNomes["3"],
      capturadoEm: ts,
      atualizadoEm: ts,
      reservadoEm: ts,
      expiraEm,
      origem: "tampermonkey-painel-doca",
      categoria: item.categoria,
      subcategoria: item.subcategoria,
      prioridade: item.prioridade,
      representante: item.representante || item.solicitante,
      fornecedorNome: item.fornecedor,
      solicitanteNome: item.solicitante,
      aberturaTexto: item.aberturaTexto,
      descricaoResumo: item.descricaoResumo,
      nfNumeroTexto: item.nota,
      chaveAcesso: item.chaveNf || "",
      chaveNfTexto: item.chaveNfTexto || "",
      tags: item.tags,
      tagsLista: item.tagsLista,
    };

    const userKey = chaveUsuario(usuario);
    const patch = {};
    patch[`by_id/${item.id}`] = payload;
    patch[`by_usuario/${userKey}/${item.id}`] = true;
    patch[`${CONFIG.firebaseReservasAtivas}/${item.id}`] = {
      chamadoId: item.id,
      operador: usuario,
      usuario,
      usuarioNorm: chaveUsuario(usuario),
      usuarioId: texto(state.usuario.id),
      statusId: "3",
      reservadoEm: ts,
      atualizadoEm: ts,
      expiraEm,
      origem: "tampermonkey-doca-reserva-ativa",
    };

    const res = await gmRequest({
      method: "PATCH",
      url: firebaseUrl(CONFIG.firebaseRoot) + `?print=silent&_=${Date.now()}`,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(patch),
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`Firebase PATCH ${res.status}`);
    state.reservas[item.id] = payload;
  }

  // =========================================================
  // PAINEL_SEM_PISCAR
  // Para localizar depois, use CTRL + F e procure por:
  // PAINEL_SEM_PISCAR
  // =========================================================
  function reservaJsonIgual(a, b) {
    const assinatura = function (reserva) {
      if (!reserva) return "";
      return [
        limparNomeAtendente(reserva.usuario || reserva.operador || reserva.nome || ""),
        texto(reserva.usuarioId || ""),
        texto(reserva.statusId || ""),
        Number(reserva.expiraEm || 0),
        Number(reserva.capturadoEm || reserva.reservadoEm || reserva.ts || 0),
      ].join("|");
    };
    return assinatura(a) === assinatura(b);
  }

  function assinaturaLinhaItem(item) {
    const responsavel = responsavelEfetivo(item);
    return [
      item.id, item.statusId, item.statusNome, item.categoria, item.subcategoria, item.prioridade,
      item.nota, item.chaveNf, item.chaveNfTexto, item.fornecedor, item.representante,
      item.solicitante, item.atualizadoTexto, item.atualizadoPor, item.slaPercentual, item.slaTexto,
      responsavel.nome, responsavel.minha ? "1" : "0", responsavel.origem,
      state.capturandoIds[item.id] ? "1" : "0", item.podeCapturar ? "1" : "0",
    ].map(texto).join("|");
  }

  function selecaoAtivaDentro(elemento) {
    try {
      const selecao = window.getSelection();
      if (!selecao || selecao.isCollapsed || !elemento) return false;
      return elemento.contains(selecao.anchorNode) || elemento.contains(selecao.focusNode);
    } catch (_) {
      return false;
    }
  }

  function criarLinhaChamado(item) {
    const temp = document.createElement("tbody");
    temp.innerHTML = htmlChamado(item);
    return temp.firstElementChild;
  }

  function ajustarTabelaVaziaSemRedesenhar() {
    const corpo = document.getElementById("sigma-corpo-tabela");
    if (!corpo) return;
    const linhas = corpo.querySelectorAll("tr[data-sigma-chamado-id]");
    const vazio = corpo.querySelector("tr .sigma-vazio")?.closest("tr");

    if (!linhas.length && !vazio) {
      corpo.innerHTML = '<tr><td colspan="11" class="sigma-vazio"><i class="fa-regular fa-folder-open"></i><br><br>Nenhum chamado encontrado com estes filtros.</td></tr>';
    } else if (linhas.length && vazio) {
      vazio.remove();
    }
  }

  function inserirLinhaNaPosicaoAtual(item, linhaNova) {
    const corpo = document.getElementById("sigma-corpo-tabela");
    if (!corpo || !linhaNova) return;
    const lista = ordenarLista(chamadosVisiveis());
    const indice = lista.findIndex(function (atual) { return atual.id === item.id; });
    let referencia = null;

    for (let i = indice + 1; i < lista.length; i++) {
      referencia = corpo.querySelector(`tr[data-sigma-chamado-id="${CSS.escape(String(lista[i].id))}"]`);
      if (referencia) break;
    }

    const vazio = corpo.querySelector("tr .sigma-vazio")?.closest("tr");
    if (vazio) vazio.remove();
    if (referencia) corpo.insertBefore(linhaNova, referencia);
    else corpo.appendChild(linhaNova);
  }

  function atualizarLinhaCompletaSemSubstituir(item) {
    if (!item || !item.id) return;
    const corpo = document.getElementById("sigma-corpo-tabela");
    if (!corpo) return;
    const id = String(item.id);
    const linhaAtual = corpo.querySelector(`tr[data-sigma-chamado-id="${CSS.escape(id)}"]`);

    if (!linhaAtual) {
      const deveExibir = chamadosVisiveis().some(function (atual) { return atual.id === id; });
      if (deveExibir) inserirLinhaNaPosicaoAtual(item, criarLinhaChamado(item));
      return;
    }

    if (selecaoAtivaDentro(linhaAtual)) {
      clearTimeout(state.linhasAdiadasTimers[id]);
      state.linhasAdiadasTimers[id] = setTimeout(function () {
        delete state.linhasAdiadasTimers[id];
        atualizarLinhaCompletaSemSubstituir(item);
      }, 700);
      return;
    }

    const assinaturaNova = assinaturaLinhaItem(item);
    if (linhaAtual.dataset.sigmaAssinatura === assinaturaNova) return;

    const linhaNova = criarLinhaChamado(item);
    if (!linhaNova) return;

    const resumoAtual = linhaAtual.querySelector(".sigma-integracoes-resumo");
    const resumoNovo = linhaNova.querySelector(".sigma-integracoes-resumo");
    if (resumoAtual && resumoNovo) {
      resumoNovo.innerHTML = resumoAtual.innerHTML;
      resumoNovo.__sigmaResumoHtml = resumoAtual.__sigmaResumoHtml || resumoAtual.innerHTML;
    }

    const celulasAtuais = Array.from(linhaAtual.children);
    const celulasNovas = Array.from(linhaNova.children);
    celulasAtuais.forEach(function (celula, indice) {
      const nova = celulasNovas[indice];
      if (!nova) return;
      if (indice === 0) {
        const checkAtual = celula.querySelector(".sigma-check-item");
        const checkNovo = nova.querySelector(".sigma-check-item");
        if (checkAtual && checkNovo) checkAtual.checked = checkNovo.checked;
        return;
      }
      if (celula.innerHTML !== nova.innerHTML) celula.innerHTML = nova.innerHTML;
      celula.className = nova.className;
      Array.from(nova.attributes).forEach(function (attr) {
        if (attr.name !== "class") celula.setAttribute(attr.name, attr.value);
      });
    });

    linhaAtual.className = linhaNova.className;
    linhaAtual.dataset.sigmaAssinatura = assinaturaNova;
  }

  function agendarAtualizacaoLinhasParciais(ids) {
    (ids || []).forEach(function (id) { if (id) state.linhasPendentes.add(String(id)); });
    clearTimeout(state.linhasPendentesTimer);
    state.linhasPendentesTimer = setTimeout(function () {
      const pendentes = Array.from(state.linhasPendentes);
      state.linhasPendentes.clear();
      requestAnimationFrame(function () {
        pendentes.forEach(function (id) {
          const item = state.chamados.find(function (chamado) { return chamado.id === id; });
          if (item) atualizarLinhaCompletaSemSubstituir(item);
        });
        atualizarContadores();
        atualizarSelecaoVisual();
        agendarSincronizacaoPonteVisivel();
      });
    }, 90);
  }

  function atualizarLinhaReservaRealtime(id, idsVisiveisProntos) {
    id = texto(id);
    if (!id) return;

    const corpo = document.getElementById("sigma-corpo-tabela");
    const item = state.chamados.find(function (chamado) { return chamado.id === id; });
    if (!corpo || !item) return;

    const deveExibir = idsVisiveisProntos
      ? idsVisiveisProntos.has(id)
      : chamadosVisiveis().some(function (chamado) { return chamado.id === id; });
    const linhaAtual = corpo.querySelector(`tr[data-sigma-chamado-id="${CSS.escape(id)}"]`);

    if (!deveExibir) {
      if (linhaAtual) linhaAtual.remove();
      ajustarTabelaVaziaSemRedesenhar();
      atualizarSelecaoVisual();
      return;
    }

    if (linhaAtual) atualizarLinhaCompletaSemSubstituir(item);
    else inserirLinhaNaPosicaoAtual(item, criarLinhaChamado(item));

    ajustarTabelaVaziaSemRedesenhar();
    atualizarSelecaoVisual();
  }

  function atualizarReservasRealtimeEmLote(ids) {
    const unicos = Array.from(new Set((ids || []).map(String).filter(Boolean)));
    if (!unicos.length) return;

    clearTimeout(atualizarReservasRealtimeEmLote.timer);
    atualizarReservasRealtimeEmLote.pendentes = new Set([
      ...Array.from(atualizarReservasRealtimeEmLote.pendentes || []),
      ...unicos,
    ]);

    atualizarReservasRealtimeEmLote.timer = setTimeout(function () {
      const pendentes = Array.from(atualizarReservasRealtimeEmLote.pendentes || []);
      atualizarReservasRealtimeEmLote.pendentes = new Set();

      requestAnimationFrame(function () {
        // Antes havia uma varredura dos ~300 chamados para cada ID alterado.
        // Agora o filtro e os contadores são calculados uma única vez por lote.
        const idsVisiveis = new Set(chamadosVisiveis().map(function (item) { return String(item.id); }));
        pendentes.forEach(function (id) { atualizarLinhaReservaRealtime(id, idsVisiveis); });
        atualizarContadores();
        atualizarSelecaoVisual();
        agendarSincronizacaoPonteVisivel();
      });
    }, 140);
  }

  function conectarRealtimeReservas() {
    try {
      if (state.eventSource) state.eventSource.close();
      // Escuta somente as travas pequenas. O histórico completo fica fora do stream.
      const es = new EventSource(firebaseUrl(`${CONFIG.firebaseRoot}/${CONFIG.firebaseReservasAtivas}`));
      es.addEventListener("put", function (event) { aplicarEventoReserva(event.data, "put"); });
      es.addEventListener("patch", function (event) { aplicarEventoReserva(event.data, "patch"); });
      es.onerror = function () { console.warn(PREFIXO, "Firebase realtime reconectando..."); };
      state.eventSource = es;
    } catch (falha) {
      console.warn(PREFIXO, "Não consegui iniciar realtime", falha);
    }
  }

  function aplicarEventoReserva(raw, tipoEvento) {
    let evento;
    try { evento = JSON.parse(raw || "{}"); } catch (_) { return; }
    const path = String(evento.path || "/");
    const data = evento.data;

    if (path === "/" || path === "") {
      const anteriores = state.reservas || {};
      let novas;

      if (tipoEvento === "patch") {
        novas = Object.assign({}, anteriores);
        Object.keys(data || {}).forEach(function (id) {
          if (data[id] === null) delete novas[id];
          else novas[id] = data[id];
        });
      } else {
        novas = data || {};
      }

      const ids = new Set([...Object.keys(anteriores), ...Object.keys(novas)]);
      const alterados = Array.from(ids).filter(function (id) {
        return !reservaJsonIgual(anteriores[id], novas[id]);
      });
      state.reservas = novas;
      limparReservasExpiradasDoCache();
      atualizarReservasRealtimeEmLote(alterados);
      return;
    }

    const partes = path.replace(/^\/+/, "").split("/").filter(Boolean);
    const id = partes[0];
    if (!id) return;

    const anterior = state.reservas[id] ? Object.assign({}, state.reservas[id]) : null;
    if (data === null) {
      delete state.reservas[id];
    } else if (partes.length === 1) {
      state.reservas[id] = data;
    } else {
      state.reservas[id] = state.reservas[id] || {};
      state.reservas[id][partes[1]] = data;
    }

    if (state.reservas[id] && reservaExpirada(state.reservas[id])) {
      delete state.reservas[id];
    }

    if (!reservaJsonIgual(anterior, state.reservas[id])) atualizarReservasRealtimeEmLote([id]);
  }

  // =========================================================
  // CAPTURA SEGURA
  // =========================================================
  async function capturarChamado(item) {
    if (state.capturandoIds[item.id]) return;
    if (!["2", "5"].includes(item.statusId)) {
      toast("Este chamado não está em uma etapa de captura.", "aviso");
      return;
    }

    const donoAtual = donoReserva(item);
    if (donoAtual && !mesmaPessoa(donoAtual, state.usuario.nome || state.usuario.login)) {
      toast(`Este chamado já está reservado por ${donoAtual}.`, "aviso");
      return;
    }

    state.capturandoIds[item.id] = true;
    atualizarLinhaCompletaSemSubstituir(item);
    atualizarStatus(`Reservando e capturando o chamado #${item.id}...`);

    try {
      const lock = await tentarReservar(item);
      if (!lock.ok) {
        toast(`Este chamado já está reservado por ${lock.dono}.`, "aviso");
        return;
      }

      const executou = await executarCapturaNativa(item);
      if (!executou) {
        await liberarReserva(item.id);
        throw new Error("A função original de captura do InfraDesk não ficou disponível.");
      }

      await esperar(900);
      const persistiu = await persistirStatusEmLiberacao(item.id);
      if (!persistiu) {
        await liberarReserva(item.id);
        throw new Error("O InfraDesk não confirmou a mudança para Em liberação.");
      }

      await salvarCapturaCompleta(item);

      item.statusId = "3";
      item.statusNome = CONFIG.statusNomes["3"];
      item.atendente = state.usuario.nome || state.usuario.login;
      item.capturado = true;
      item.podeCapturar = false;
      item.atualizado = new Date();
      item.atualizadoTexto = formatarDataHora(item.atualizado);
      item.atualizadoPor = item.atendente;

      reconstruirFiltros();
      atualizarLinhaCompletaSemSubstituir(item);
      atualizarContadores();
      atualizarStatus(`Chamado #${item.id} capturado e movido para Em liberação.`);
      toast(`Chamado #${item.id} capturado com sucesso!`, "sucesso");
    } catch (falha) {
      console.error(PREFIXO, "Erro na captura", falha);
      toast(`Não consegui capturar o chamado #${item.id}: ${texto(falha.message || falha)}`, "erro");
      atualizarStatus("Falha na captura. A fila continua disponível.");
    } finally {
      delete state.capturandoIds[item.id];
      atualizarLinhaCompletaSemSubstituir(item);
    }
  }

  function esperar(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function executarCapturaNativa(item) {
    const motor = await obterMotorCaptura();
    if (!motor || typeof motor.capturarChamadoNew !== "function") return false;

    try {
      const docMotor = motor.document;
      const dummy = docMotor.createElement("a");
      dummy.href = "javascript:void(0);";
      dummy.style.display = "none";
      dummy.dataset.chamadoId = item.id;
      docMotor.body.appendChild(dummy);

      motor.capturarChamadoNew(
        Number(item.id),
        Number(item.grupoId || CONFIG.grupoAtendimentoPadrao),
        dummy,
        undefined
      );

      setTimeout(function () { try { dummy.remove(); } catch (_) {} }, 5000);
      return true;
    } catch (falha) {
      console.warn(PREFIXO, "capturarChamadoNew falhou", falha);
      return false;
    }
  }

  async function obterMotorCaptura() {
    const root = paginaWindow();
    if (root && typeof root.capturarChamadoNew === "function") return root;
    if (state.motorIframe?.contentWindow && typeof state.motorIframe.contentWindow.capturarChamadoNew === "function") {
      return state.motorIframe.contentWindow;
    }
    if (state.motorPromise) return state.motorPromise;

    state.motorPromise = new Promise(function (resolve) {
      const iframe = document.createElement("iframe");
      iframe.id = "sigma-motor-infradesk";
      iframe.style.cssText = "position:fixed;left:-100000px;top:-100000px;width:1200px;height:800px;opacity:0;pointer-events:none;";
      iframe.src = montarUrlFonte(1);
      state.motorIframe = iframe;

      const limite = setTimeout(function () { resolve(null); }, 20000);
      iframe.addEventListener("load", function () {
        let tentativas = 0;
        const verificar = function () {
          tentativas++;
          try {
            const win = iframe.contentWindow;
            if (win && typeof win.capturarChamadoNew === "function") {
              clearTimeout(limite);
              resolve(win);
              return;
            }
          } catch (_) {}
          if (tentativas >= 80) {
            clearTimeout(limite);
            resolve(null);
            return;
          }
          setTimeout(verificar, 100);
        };
        verificar();
      }, { once: true });

      document.body.appendChild(iframe);
    }).finally(function () { state.motorPromise = null; });

    return state.motorPromise;
  }

  async function persistirStatusEmLiberacao(id) {
    const tentativas = [
      { status_chamado_id: "3" },
      { chamado_status_id: "3" },
      { status_id: "3" },
      { status_chamado_id: "3", is_capturado: "1" },
    ];

    for (const dados of tentativas) {
      try {
        const body = new URLSearchParams(dados).toString();
        const resposta = await fetch(`/backend/chamados/editar/${encodeURIComponent(id)}.json`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body,
        });

        if (!resposta.ok) continue;
        const txt = await resposta.text();
        let json = null;
        try { json = JSON.parse(txt); } catch (_) {}
        if (json && json.success === false) continue;
        return true;
      } catch (_) {}
    }
    return false;
  }

  // =========================================================
  // FILTROS, ORDENACAO E RENDER
  // =========================================================
  function reconstruirFiltros() {
    preencherSelect("sigma-filtro-representante", state.chamados.map(function (i) { return i.representante || i.solicitante; }).filter(Boolean), "Todos");
    preencherSelect("sigma-filtro-prioridade", state.chamados.map(function (i) { return i.prioridade || i.subcategoria; }).filter(Boolean), "Todos");
    preencherSelect("sigma-filtro-fornecedor", state.chamados.map(function (i) { return i.fornecedor; }).filter(Boolean), "Todos");
    preencherSelect("sigma-filtro-atendente", state.chamados.map(function (i) { return i.atendente; }).filter(Boolean), "Todos");
    aplicarPreferenciasPendentes();
  }

  function preencherSelect(id, valores, todos) {
    const el = document.getElementById(id);
    if (!el) return;
    const atual = el.value;
    const contagem = new Map();
    valores.forEach(function (valor) {
      const v = texto(valor);
      if (v) contagem.set(v, (contagem.get(v) || 0) + 1);
    });

    const ordenados = Array.from(contagem.keys()).sort(function (a, b) {
      return a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" });
    });

    el.innerHTML = `<option value="">${escaparHtml(todos)}</option>` + ordenados.map(function (valor) {
      return `<option value="${escaparHtml(valor)}">${escaparHtml(valor)} (${contagem.get(valor)})</option>`;
    }).join("");

    if (ordenados.includes(atual)) el.value = atual;
  }

  function chamadosVisiveis() {
    const busca = normalizar(document.getElementById("sigma-busca")?.value || "");
    const representante = texto(document.getElementById("sigma-filtro-representante")?.value || "");
    const prioridade = texto(document.getElementById("sigma-filtro-prioridade")?.value || "");
    const fornecedor = texto(document.getElementById("sigma-filtro-fornecedor")?.value || "");
    const atendente = texto(document.getElementById("sigma-filtro-atendente")?.value || "");

    return state.chamados.filter(function (item) {
      if (state.filtroStatus !== "todos" && item.statusId !== state.filtroStatus) return false;
      if (busca && !item.busca.includes(busca)) return false;
      if (representante && (item.representante || item.solicitante) !== representante) return false;
      if (prioridade && (item.prioridade || item.subcategoria) !== prioridade) return false;
      if (fornecedor && item.fornecedor !== fornecedor) return false;
      if (atendente && item.atendente !== atendente) return false;

      const responsavel = responsavelEfetivo(item);
      if (state.filtroSituacao === "livres" && responsavel.nome && !responsavel.minha) return false;
      if (state.filtroSituacao === "minhas" && !responsavel.minha) return false;
      if (state.filtroSituacao === "reservadas" && (!responsavel.nome || responsavel.minha)) return false;
      return true;
    });
  }

  function prioridadeRepresentante(item) {
    const representante = normalizar(item.representante || item.solicitante || "");
    const match = representante.match(/\brecebimento\s+0*(\d{1,3})\b/i);
    const numero = match ? Number(match[1]) : 9999;
    if (numero === 3) return 0;
    if (numero === 1) return 1;
    if (numero === 5) return 2;
    return 999;
  }

  // =========================================================
  // FILA_FIFO_SLA_DATA_HORA
  // Para localizar depois, use CTRL + F e procure por:
  // FILA_FIFO_SLA_DATA_HORA
  //
  // Na organização Recebimento 03 → 01 → 05, a fila respeita:
  // 1. prioridade da loja pelo representante;
  // 2. SLA excedido ou com menor tempo restante;
  // 3. abertura mais antiga;
  // 4. menor ID como segurança quando a hora não estiver disponível.
  // Status, reserva e responsável não entram no cálculo, portanto capturar uma
  // nota não muda sua posição. Chamados novos ficam no final da mesma fila.
  // =========================================================
  function dadosOrdemSla(item) {
    const valor = normalizar(item?.slaTexto || "");

    if (/restante sla[^a-z0-9]*(excedido|vencido|estourado)/i.test(valor) || /sla[^a-z0-9]*(excedido|vencido|estourado)/i.test(valor)) {
      return { grupo: 0, valor: 0 };
    }

    const match = valor.match(/restante sla[^0-9]*(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
    if (match && match.slice(1).some(Boolean)) {
      const dias = Number(match[1] || 0);
      const horas = Number(match[2] || 0);
      const minutos = Number(match[3] || 0);
      const segundos = Number(match[4] || 0);
      return {
        grupo: 1,
        valor: (dias * 86400) + (horas * 3600) + (minutos * 60) + segundos,
      };
    }

    const percentual = Number(item?.slaPercentual);
    if (Number.isFinite(percentual) && percentual > 0) {
      // Quando o InfraDesk não informa o tempo restante, maior consumo é mais urgente.
      return { grupo: 2, valor: -percentual };
    }

    return { grupo: 3, valor: 0 };
  }

  function compararSla(a, b) {
    const slaA = dadosOrdemSla(a);
    const slaB = dadosOrdemSla(b);
    return (slaA.grupo - slaB.grupo) || (slaA.valor - slaB.valor);
  }

  function compararAberturaAntigaPrimeiro(a, b) {
    const dataA = dataMs(a?.abertura || a?.aberturaTexto);
    const dataB = dataMs(b?.abertura || b?.aberturaTexto);

    if (dataA && dataB && dataA !== dataB) return dataA - dataB;
    if (dataA && !dataB) return -1;
    if (!dataA && dataB) return 1;

    const idA = Number(a?.id || 0);
    const idB = Number(b?.id || 0);
    if (idA && idB && idA !== idB) return idA - idB;
    return 0;
  }

  function ordenarLista(lista) {
    const modo = document.getElementById("sigma-organizacao")?.value || "original";
    const out = lista.slice();

    out.sort(function (a, b) {
      const ordemA = Number.isFinite(Number(a._ordemFonte)) ? Number(a._ordemFonte) : 999999999;
      const ordemB = Number.isFinite(Number(b._ordemFonte)) ? Number(b._ordemFonte) : 999999999;

      // PADRAO_INFRA_DESK: preserva exatamente a ordem recebida do sistema.
      if (modo === "original") return ordemA - ordemB;

      if (modo === "representante_030105") {
        return (
          prioridadeRepresentante(a) - prioridadeRepresentante(b) ||
          compararSla(a, b) ||
          compararAberturaAntigaPrimeiro(a, b) ||
          ordemA - ordemB
        );
      }

      return ordemA - ordemB;
    });

    return out;
  }

  function sincronizarTabelaIncremental(assinaturasAntes) {
    const corpo = document.getElementById("sigma-corpo-tabela");
    if (!corpo) return;

    atualizarContadores();
    const lista = ordenarLista(chamadosVisiveis());
    const desejados = new Set(lista.map(function (item) { return String(item.id); }));

    corpo.querySelectorAll("tr[data-sigma-chamado-id]").forEach(function (linha) {
      const id = texto(linha.getAttribute("data-sigma-chamado-id") || "");
      if (!desejados.has(id) && !selecaoAtivaDentro(linha)) linha.remove();
    });

    const idsNovos = [];
    lista.forEach(function (item) {
      const id = String(item.id);
      const linha = corpo.querySelector(`tr[data-sigma-chamado-id="${CSS.escape(id)}"]`);
      const assinaturaNova = assinaturaLinhaItem(item);
      const assinaturaAntiga = assinaturasAntes?.get?.(id);
      if (!linha) {
        inserirLinhaNaPosicaoAtual(item, criarLinhaChamado(item));
        idsNovos.push(id);
      } else if (assinaturaAntiga !== assinaturaNova || linha.dataset.sigmaAssinatura !== assinaturaNova) {
        atualizarLinhaCompletaSemSubstituir(item);
      }
    });

    ajustarTabelaVaziaSemRedesenhar();
    atualizarSelecaoVisual();
    agendarSincronizacaoPonteVisivel();
    if (idsNovos.length) agendarEspelhoIntegracoes(idsNovos);
  }

  function renderizar() {
    const corpo = document.getElementById("sigma-corpo-tabela");
    if (!corpo) return;

    atualizarContadores();
    const lista = ordenarLista(chamadosVisiveis());

    if (!lista.length) {
      corpo.innerHTML = '<tr><td colspan="11" class="sigma-vazio"><i class="fa-regular fa-folder-open"></i><br><br>Nenhum chamado encontrado com estes filtros.</td></tr>';
      agendarSincronizacaoPonteVisivel();
      atualizarSelecaoVisual();
      return;
    }

    corpo.innerHTML = lista.map(htmlChamado).join("");
    atualizarSelecaoVisual();
    agendarSincronizacaoPonteVisivel();
  }

  function atualizarContadores() {
    const counts = { todos: state.chamados.length, "2": 0, "3": 0, "5": 0, "6": 0 };
    const sit = { todas: state.chamados.length, livres: 0, minhas: 0, reservadas: 0 };

    state.chamados.forEach(function (item) {
      if (counts[item.statusId] != null) counts[item.statusId]++;
      const responsavel = responsavelEfetivo(item);
      if (!responsavel.nome || responsavel.minha) sit.livres++;
      if (responsavel.minha) sit.minhas++;
      if (responsavel.nome && !responsavel.minha) sit.reservadas++;
    });

    Object.keys(counts).forEach(function (key) {
      const el = document.getElementById(`sigma-count-${key}`);
      if (el) el.textContent = String(counts[key]);
    });
    Object.keys(sit).forEach(function (key) {
      const el = document.getElementById(`sigma-sit-${key}`);
      if (el) el.textContent = String(sit[key]);
    });
  }

  function htmlChamado(item) {
    const responsavel = responsavelEfetivo(item);
    const dono = responsavel.nome;
    const minha = responsavel.minha;
    const reservadaOutro = dono && !minha;
    const capturando = !!state.capturandoIds[item.id];
    const notaOuId = item.nota ? `NF ${item.nota}` : "Sem número de NF identificado";
    const chaveExibida = item.chaveNf || item.chaveNfTexto || "";
    const rotuloChave = item.chaveNf ? "Chave de acesso" : "Referência informada";
    const chaveValida = /^\d{44}$/.test(String(item.chaveNf || ""));
    const mostrarIntegracoes = item.statusId === "6";

    let ownerHtml = '<span class="sigma-owner livre"><i class="fa-regular fa-circle"></i> Livre</span>';
    if (dono) {
      const tituloResponsavel = responsavel.origem === "firebase" ? "Reserva Firebase" : "Atendente no InfraDesk";
      const iconeResponsavel = responsavel.origem === "firebase" ? "fa-user-lock" : "fa-user-check";
      ownerHtml = `<span class="sigma-owner ${minha ? "minha" : "outro"}" title="${tituloResponsavel}"><i class="fa-solid ${iconeResponsavel}"></i> ${escaparHtml(dono)}</span>`;
    }

    const pct = Math.max(0, Math.min(100, Number(item.slaPercentual) || 0));
    const classeSla = pct >= 85 ? "critico" : pct >= 65 ? "alerta" : "";
    const podeCapturar = item.podeCapturar && !reservadaOutro && !capturando;
    const selecionado = !!state.selecionados[item.id];
    const assinatura = assinaturaLinhaItem(item);

    return `<tr class="${reservadaOutro ? "sigma-reservado-outro" : ""} ${selecionado ? "sigma-selecionado" : ""}" data-sigma-chamado-id="${item.id}" data-sigma-assinatura="${escaparHtml(assinatura)}">
      <td class="sigma-selecao-celula"><input class="sigma-check-lote sigma-check-item" type="checkbox" data-id="${item.id}" ${selecionado ? "checked" : ""} title="Selecionar chamado #${item.id}"></td>
      <td class="sigma-id sigma-col-opcional">
        <a href="javascript:void(0)" data-acao="detalhes" data-id="${item.id}">#${item.id}</a>
        <small>${escaparHtml(item.aberturaTexto || "")}</small>
      </td>
      <td class="sigma-status-celula"><span class="sigma-status-badge status-${item.statusId}">${escaparHtml(item.statusNome)}</span></td>
      <td class="sigma-tipo"><strong>${escaparHtml(item.subcategoria || (!ehPrioridadeGenerica(item.prioridade) ? item.prioridade : "") || item.categoria || "Sem tipo")}</strong><small>${escaparHtml(ehPrioridadeGenerica(item.prioridade) ? `${item.categoria || "Fornecedor"} • prioridade ${item.prioridade}` : (item.categoria || ""))}</small></td>
      <td class="sigma-nf-integracoes">
        <div class="sigma-nf-base">
          <strong>${escaparHtml(notaOuId)}</strong>
          ${chaveExibida ? `<span class="sigma-chave-linha" title="${escaparHtml(rotuloChave + ": " + chaveExibida)}"><span class="sigma-chave-texto">${escaparHtml(rotuloChave)}: ${escaparHtml(chaveExibida)}</span><button class="sigma-chave-copiar" type="button" data-acao="copiar-chave" data-id="${item.id}" data-valor="${escaparHtml(chaveExibida)}" title="Copiar"><i class="fa-regular fa-copy"></i></button></span>` : `<span class="sigma-chave-linha"><span class="sigma-chave-texto">Chave ainda não disponível</span></span>`}
        </div>
        <div class="sigma-integracoes-resumo ${mostrarIntegracoes ? "aguardando" : ""}" data-integracoes-id="${item.id}"></div>
      </td>
      <td class="sigma-fornecedor" title="${escaparHtml(item.fornecedor)}">${escaparHtml(item.fornecedor || "Não identificado")}</td>
      <td class="sigma-pessoa sigma-representante sigma-col-opcional" title="${escaparHtml(item.representante || item.solicitante)}"><strong>${escaparHtml(item.representante || item.solicitante || "Não identificado")}</strong><small>${escaparHtml(item.solicitanteSetor || "")}</small></td>
      <td class="sigma-data sigma-col-opcional">${escaparHtml(item.atualizadoTexto || item.aberturaTexto || "---")}<small>${escaparHtml(item.atualizadoPor || "")}</small></td>
      <td class="sigma-responsavel-celula">${ownerHtml}</td>
      <td class="sigma-sla sigma-col-opcional"><div class="sigma-sla-barra"><span class="${classeSla}" style="width:${pct}%"></span></div><small>${pct}% ${escaparHtml(item.slaTexto || "")}</small></td>
      <td class="sigma-acoes-celula">
        <div class="sigma-acoes">
          <button class="sigma-acao" type="button" data-acao="detalhes" data-id="${item.id}" title="Abrir detalhes"><i class="fa-solid fa-eye"></i></button>
          ${mostrarIntegracoes ? `<button class="sigma-acao sigma-acao-integracao" type="button" data-acao="xabuia" data-id="${item.id}" title="Abrir Xabuia" ${chaveValida ? "" : "disabled"}><img src="${CONFIG.xabuiaIcone}" alt="Xabuia"></button><button class="sigma-acao sigma-acao-integracao" type="button" data-acao="comercial" data-id="${item.id}" title="Abrir Comercial" ${chaveValida ? "" : "disabled"}><img src="${CONFIG.comercialIcone}" alt="Comercial"></button>` : ""}
          <button class="sigma-acao" type="button" data-acao="feedback" data-id="${item.id}" title="Adicionar feedback"><i class="fa-solid fa-paper-plane"></i></button>
          ${item.podeCapturar ? `<button class="sigma-acao destaque" type="button" data-acao="capturar" data-id="${item.id}" title="${reservadaOutro ? `Reservado por ${escaparHtml(dono)}` : "Capturar chamado"}" ${podeCapturar ? "" : "disabled"}><i class="fa-solid ${capturando ? "fa-spinner fa-spin" : "fa-thumbs-up"}"></i></button>` : ""}
        </div>
      </td>
    </tr>`;
  }

  // COLUNAS_OCULTAS_E_INTEGRACOES
  // Para localizar depois, use CTRL + F e procure por:
  // COLUNAS_OCULTAS_E_INTEGRACOES
  // =========================================================
  function aplicarVisibilidadeColunas() {
    const app = document.getElementById("sigma-doca-app");
    const botao = document.getElementById("sigma-toggle-colunas");
    if (!app || !botao) return;

    app.classList.toggle("sigma-mostrar-colunas-opcionais", !!state.mostrarColunasOpcionais);
    botao.classList.toggle("ativo", !!state.mostrarColunasOpcionais);
    const textoBotao = botao.querySelector("span");
    if (textoBotao) textoBotao.textContent = state.mostrarColunasOpcionais ? "Ocultar colunas secundárias" : "Exibir colunas ocultas";
    botao.title = state.mostrarColunasOpcionais
      ? "Ocultar Chamado, Representante, Última movimentação e SLA"
      : "Exibir Chamado, Representante, Última movimentação e SLA";
  }

  function iniciarEspelhoIntegracoes() {
    const bridge = document.getElementById("sigma-integracao-bridge");
    if (!bridge || state.integracaoObserver) return;

    state.integracaoObserver = new MutationObserver(function (mutacoes) {
      const ids = new Set();
      mutacoes.forEach(function (mutacao) {
        const coletar = function (node) {
          if (!node) return;
          if (node.nodeType !== 1) node = node.parentElement;
          if (!node) return;
          const card = node.matches?.(".chamado-item[data-chamado-id]")
            ? node
            : node.closest?.(".chamado-item[data-chamado-id]") || node.querySelector?.(".chamado-item[data-chamado-id]");
          const id = texto(card?.getAttribute?.("data-chamado-id") || "");
          if (id) ids.add(id);
        };
        coletar(mutacao.target);
        Array.from(mutacao.addedNodes || []).forEach(coletar);
      });
      agendarEspelhoIntegracoes(Array.from(ids));
    });
    state.integracaoObserver.observe(bridge, { childList: true, subtree: true, characterData: true });
  }

  function assinaturaIntegracaoItem(item) {
    return [
      item.id, item.statusId, item.chaveNf || "", item.subcategoria || "", item.fornecedor || "",
      item.representante || item.solicitante || "", item.aberturaTexto || "", item.descricaoResumo || "",
    ].join("|");
  }

  // =========================================================
  // INTEGRACOES_LAZY_VIEWPORT
  // Para localizar depois, use CTRL + F e procure por:
  // INTEGRACOES_LAZY_VIEWPORT
  // =========================================================
  function configurarIntegracoesLazy() {
    const wrap = document.querySelector(".sigma-grade-wrap");
    if (!wrap || state.integracaoScrollHandler) return;

    state.integracaoScrollHandler = function () { agendarSincronizacaoPonteVisivel(); };
    state.integracaoResizeHandler = function () { agendarSincronizacaoPonteVisivel(); };
    wrap.addEventListener("scroll", state.integracaoScrollHandler, { passive: true });
    window.addEventListener("resize", state.integracaoResizeHandler, { passive: true });
    agendarSincronizacaoPonteVisivel();
  }

  function itensIntegracaoProximosDaTela() {
    const wrap = document.querySelector(".sigma-grade-wrap");
    if (!wrap) return [];

    const margem = Math.max(100, Number(CONFIG.integracoesMargemPx) || 650);
    const inicio = Math.max(0, wrap.scrollTop - margem);
    const fim = wrap.scrollTop + wrap.clientHeight + margem;
    const maximo = Math.max(4, Number(CONFIG.integracoesMaxAtivas) || 18);
    const itens = [];

    const linhas = wrap.querySelectorAll('tr[data-sigma-chamado-id]');
    for (const linha of linhas) {
      const topo = linha.offsetTop;
      const baixo = topo + Math.max(1, linha.offsetHeight || 55);
      if (baixo < inicio) continue;
      if (topo > fim) break;

      const id = texto(linha.getAttribute("data-sigma-chamado-id") || "");
      const item = state.chamados.find(function (chamado) { return chamado.id === id; });
      if (!item || item.statusId !== "6") continue;
      itens.push(item);
      if (itens.length >= maximo) break;
    }
    return itens;
  }

  function garantirPonteIntegracaoItem(item) {
    const bridge = document.getElementById("sigma-integracao-bridge");
    if (!bridge || !item || item.statusId !== "6") return null;

    const id = String(item.id);
    const assinatura = assinaturaIntegracaoItem(item);
    let atual = bridge.querySelector(`ul[data-sigma-bridge-id="${CSS.escape(id)}"]`);
    if (atual && atual.getAttribute("data-sigma-bridge-assinatura") === assinatura) {
      atual.dataset.sigmaUltimoUso = String(Date.now());
      return atual.querySelector('.chamado-item[data-chamado-id]');
    }

    const temp = document.createElement("div");
    temp.innerHTML = htmlPonteIntegracao(item, assinatura);
    const novo = temp.firstElementChild;
    if (!novo) return null;
    novo.dataset.sigmaUltimoUso = String(Date.now());

    if (atual) atual.replaceWith(novo);
    else bridge.appendChild(novo);
    return novo.querySelector('.chamado-item[data-chamado-id]');
  }

  function sincronizarPonteIntegracoesVisiveis(idsExtras) {
    const bridge = document.getElementById("sigma-integracao-bridge");
    if (!bridge) return;

    const mapa = new Map();
    itensIntegracaoProximosDaTela().forEach(function (item) { mapa.set(String(item.id), item); });
    (idsExtras || []).forEach(function (id) {
      const item = state.chamados.find(function (chamado) { return chamado.id === String(id); });
      if (item && item.statusId === "6") mapa.set(String(item.id), item);
    });

    const desejados = new Set(mapa.keys());
    mapa.forEach(function (item) { garantirPonteIntegracaoItem(item); });

    // Mantém uma pequena reserva LRU para evitar recriar imediatamente quando
    // o usuário rolar alguns pixels para cima, mas nunca centenas de cartões.
    const maximo = Math.max(4, Number(CONFIG.integracoesMaxAtivas) || 18);
    const todos = Array.from(bridge.querySelectorAll("ul[data-sigma-bridge-id]"));
    if (todos.length > maximo) {
      const removiveis = todos.filter(function (ul) {
        return !desejados.has(texto(ul.getAttribute("data-sigma-bridge-id") || ""));
      }).sort(function (a, b) {
        return Number(a.dataset.sigmaUltimoUso || 0) - Number(b.dataset.sigmaUltimoUso || 0);
      });

      while (bridge.querySelectorAll("ul[data-sigma-bridge-id]").length > maximo && removiveis.length) {
        removiveis.shift().remove();
      }
    }

    state.integracaoAtivos = new Set(Array.from(bridge.querySelectorAll("ul[data-sigma-bridge-id]")).map(function (ul) {
      return texto(ul.getAttribute("data-sigma-bridge-id") || "");
    }).filter(Boolean));

    if (desejados.size) agendarEspelhoIntegracoes(Array.from(desejados));
  }

  function agendarSincronizacaoPonteVisivel(idsExtras) {
    const extras = Array.isArray(idsExtras) ? idsExtras.map(String) : [];
    extras.forEach(function (id) { if (id) state.integracaoViewportIdsPendentes.add(id); });
    clearTimeout(state.integracaoViewportTimer);
    state.integracaoViewportTimer = setTimeout(function () {
      const ids = Array.from(state.integracaoViewportIdsPendentes);
      state.integracaoViewportIdsPendentes.clear();
      executarQuandoOcioso(function () { sincronizarPonteIntegracoesVisiveis(ids); }, 300);
    }, CONFIG.integracoesScrollDebounceMs || 140);
  }

  // Mantém compatibilidade com chamadas antigas do próprio painel.
  function sincronizarPonteIntegracoes(itens) {
    const ids = Array.isArray(itens) ? itens.map(function (item) { return item?.id; }).filter(Boolean) : [];
    agendarSincronizacaoPonteVisivel(ids);
  }

  function htmlPonteIntegracao(item, assinatura) {
    const chave = /^\d{44}$/.test(String(item.chaveNf || "")) ? String(item.chaveNf) : "";
    const fornecedor = item.fornecedor || "Fornecedor não identificado";
    const empresa = item.representante || item.solicitante || item.loja || "";
    const ultimaDescricao = item.descricaoResumo || item.descricaoCompleta || "";

    return `<ul class="list-status-chamados" data-status-id="6" data-status-descricao="Em Análise Terceiro" data-sigma-bridge-id="${item.id}" data-sigma-bridge-assinatura="${escaparHtml(assinatura || assinaturaIntegracaoItem(item))}">
      <li class="chamado-item" data-chamado-id="${item.id}">
        <span class="item-subcategoria" title="${escaparHtml(item.subcategoria || item.prioridade || item.categoria || "")}">${escaparHtml(item.subcategoria || item.prioridade || item.categoria || "")}</span>
        <span class="item-data-abertura">${escaparHtml(item.aberturaTexto || "")}</span>
        <span class="item-data-empresa">${escaparHtml(empresa)}</span>
        <a class="item-data-fornecedor" href="javascript:void(0)">${escaparHtml(fornecedor)}</a>
        <div class="item-ultima-descricao-copy">${escaparHtml(ultimaDescricao)}</div>
        <div class="chamado-tags"><span>${escaparHtml(chave)}</span></div>
        <div class="list-toolbar"><div class="toolbar-atendente">
          <a href="javascript:void(0)" title="Registrar Interação"></a>
          <a href="javascript:void(0)" class="btn-anexo"></a>
        </div></div>
      </li>
    </ul>`;
  }

  function agendarEspelhoIntegracoes(ids) {
    if (Array.isArray(ids) && ids.length) {
      ids.forEach(function (id) { if (id) state.integracaoIdsPendentes.add(String(id)); });
    } else {
      state.integracaoEspelharTudo = true;
    }

    clearTimeout(state.integracaoRenderTimer);
    state.integracaoRenderTimer = setTimeout(function () {
      const tudo = state.integracaoEspelharTudo;
      const pendentes = Array.from(state.integracaoIdsPendentes);
      state.integracaoEspelharTudo = false;
      state.integracaoIdsPendentes.clear();
      requestAnimationFrame(function () {
        espelharIntegracoesVisiveis(tudo ? null : pendentes);
      });
    }, 180);
  }

  function espelharIntegracoesVisiveis(ids) {
    let destinos;
    if (Array.isArray(ids) && ids.length) {
      destinos = ids.map(function (id) {
        return document.querySelector(`[data-integracoes-id="${CSS.escape(String(id))}"]`);
      }).filter(Boolean);
    } else {
      destinos = Array.from(document.querySelectorAll("[data-integracoes-id]"));
    }

    destinos.forEach(function (destino) {
      const id = texto(destino.getAttribute("data-integracoes-id") || "");
      const card = document.querySelector(`#sigma-integracao-bridge .chamado-item[data-chamado-id="${CSS.escape(id)}"]`);
      const partes = [];
      if (card) {
        const xabuia = lerResumoIntegracao(card, "xabuia");
        const comercial = lerResumoIntegracao(card, "comercial");
        if (xabuia) partes.push(htmlResumoIntegracao("xabuia", xabuia));
        if (comercial) partes.push(htmlResumoIntegracao("comercial", comercial));
      }
      const html = partes.join("");
      if (destino.__sigmaResumoHtml === html) return;
      if (selecaoAtivaDentro(destino)) {
        agendarEspelhoIntegracoes([id]);
        return;
      }
      destino.innerHTML = html;
      destino.__sigmaResumoHtml = html;
    });
  }

  function lerResumoIntegracao(card, tipo) {
    const box = card.querySelector(`.${tipo}-box`);
    if (!box) return null;

    const status = texto(box.querySelector(`.${tipo}-chip`)?.textContent || "");
    const mensagem = texto(box.querySelector(`.${tipo}-last-text`)?.textContent || "");
    const meta = texto(box.querySelector("small")?.textContent || "");
    let resumo = "";

    const corpo = box.querySelector(`.${tipo}-box-body`);
    if (corpo) {
      const copia = corpo.cloneNode(true);
      copia.querySelectorAll(`.${tipo}-last-text, small`).forEach(function (el) { el.remove(); });
      resumo = texto(copia.textContent || "")
        .replace(/^Última ocorrência\s*/i, "")
        .replace(/^Ultima ocorrencia\s*/i, "");
    }

    const principal = [resumo, mensagem].filter(Boolean).join(resumo && mensagem ? " • " : "");
    if (!principal && !status && !meta) return null;
    return { status, principal: principal || "Registro disponível.", meta };
  }

  function htmlResumoIntegracao(tipo, dados) {
    const nome = tipo === "xabuia" ? "Xabuia" : "Comercial";
    const icone = tipo === "xabuia" ? CONFIG.xabuiaIcone : CONFIG.comercialIcone;
    const titulo = [nome, dados.status].filter(Boolean).join(" • ");
    const tooltip = [titulo, dados.principal, dados.meta].filter(Boolean).join(" — ");

    return `<div class="sigma-integracao-mini ${tipo}" title="${escaparHtml(tooltip)}">
      <img src="${icone}" alt="${nome}">
      <span><strong>${escaparHtml(titulo || nome)}</strong><em>${escaparHtml(dados.principal)}</em></span>
    </div>`;
  }

  function acionarIntegracaoExterna(item, tipo) {
    if (!item || item.statusId !== "6") {
      toast(`${tipo === "xabuia" ? "Xabuia" : "Comercial"} está disponível somente em Em Análise Terceiro.`, "erro");
      return;
    }
    if (!/^\d{44}$/.test(String(item.chaveNf || ""))) {
      toast("A chave NF-e de 44 dígitos ainda não foi carregada para esta nota.", "erro");
      return;
    }

    const seletor = tipo === "xabuia" ? ".xabuia-card-btn" : ".comercial-card-btn";
    const nome = tipo === "xabuia" ? "Xabuia" : "Comercial";
    garantirPonteIntegracaoItem(item);

    const clicar = function (tentativa) {
      const card = document.querySelector(`#sigma-integracao-bridge .chamado-item[data-chamado-id="${CSS.escape(item.id)}"]`);
      const botao = card?.querySelector(seletor);
      if (botao) {
        botao.click();
        return;
      }
      if (tentativa < 12) {
        setTimeout(function () { clicar(tentativa + 1); }, 220);
        return;
      }
      toast(`${nome} ainda não carregou nesta página. Confirme se o loader está ativado e atualize o painel.`, "erro");
    };
    clicar(0);
  }


  // =========================================================
  // FEEDBACK_MODAL_PROPRIO
  // Carrega apenas os dados do formulário de interação, sem abrir a página
  // inteira do InfraDesk em um iframe. Também controla o segundo modal de
  // mensagens pré-definidas e grava pelo endpoint real enviarEmail/{id}.json.
  // Para localizar depois, use CTRL + F e procure por:
  // FEEDBACK_MODAL_PROPRIO
  // =========================================================
  async function abrirModalFeedback(item) {
    if (!item || !item.id) return;
    state.modalFeedbackItem = item;
    state.modalFeedbackLoteIds = [];
    state.modalFeedbackPares = [];
    state.modalFeedbackPreUrl = "";

    const modal = document.getElementById("sigma-feedback-modal");
    const corpo = document.getElementById("sigma-feedback-corpo");
    const titulo = document.getElementById("sigma-feedback-titulo");
    titulo.textContent = `Chamado #${item.id} • Interação`;
    corpo.innerHTML = '<div class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Carregando somente o formulário do InfraDesk...</div>';
    modal.classList.add("ativo");
    modal.setAttribute("aria-hidden", "false");

    try {
      const url = new URL(`/backend/chamados/detalhes/${encodeURIComponent(item.id)}`, window.location.origin);
      url.searchParams.set("action", "lista");
      url.searchParams.set("tab", "tab-interacoes");
      url.searchParams.set("_sigma", String(Date.now()));

      const resposta = await fetch(url.toString(), {
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status} ao carregar o formulário.`);

      const html = await resposta.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const form = doc.querySelector("#form-interacao");
      if (!form) throw new Error("O InfraDesk não devolveu o formulário de interação.");

      state.modalFeedbackPares = extrairParesFormulario(form);
      const linkPre = doc.querySelector('a[href*="/backend/mensagens_predefinidas/listar"]');
      state.modalFeedbackPreUrl = linkPre ? new URL(linkPre.getAttribute("href"), window.location.origin).toString() : "";

      const selectStatus = form.querySelector('[name="status_chamado_id"]');

      // STATUS_FINALIZADO_NO_MODAL
      // Usa primeiro as opções reais devolvidas pelo InfraDesk. Caso a resposta
      // venha parcial, completa com Reaberto, Aberto, Em liberação,
      // Em Análise Terceiro e Finalizado.
      const opcoesStatus = [];
      const statusJaIncluidos = new Set();

      if (selectStatus) {
        Array.from(selectStatus.options).forEach(function (option) {
          const id = String(option.value || "");
          if (!id || statusJaIncluidos.has(id)) return;
          statusJaIncluidos.add(id);
          opcoesStatus.push({
            id: id,
            nome: texto(option.textContent) || CONFIG.statusNomes[id] || `Status ${id}`,
            selected: !!option.selected,
          });
        });
      }

      CONFIG.feedbackStatusIds.forEach(function (id) {
        if (statusJaIncluidos.has(id)) return;
        statusJaIncluidos.add(id);
        opcoesStatus.push({
          id: id,
          nome: CONFIG.statusNomes[id] || `Status ${id}`,
          selected: !selectStatus && id === String(item.statusId || ""),
        });
      });

      if (!opcoesStatus.some(function (option) { return option.selected; })) {
        const atual = opcoesStatus.find(function (option) {
          return option.id === String(item.statusId || "");
        });
        if (atual) atual.selected = true;
      }

      const options = opcoesStatus.map(function (option) {
        return `<option value="${escaparHtml(option.id)}" ${option.selected ? "selected" : ""}>${escaparHtml(option.nome)}</option>`;
      }).join("");

      const mensagemInicial = form.querySelector('[name="mensagem"]')?.value || "";

      corpo.innerHTML = `
        <div class="sigma-feedback-campo">
          <label for="sigma-feedback-status">Status da Solicitação</label>
          <select id="sigma-feedback-status" data-noselect="1">${options}</select>
        </div>
        <div class="sigma-feedback-campo">
          <label for="sigma-feedback-editor">Adicione sua interação</label>
          <div id="sigma-feedback-editor" contenteditable="true" role="textbox" aria-multiline="true">${mensagemInicial}</div>
        </div>
        <div class="sigma-feedback-acoes">
          <div>
            <button id="sigma-feedback-premsg" class="sigma-feedback-btn" type="button" ${state.modalFeedbackPreUrl ? "" : "disabled"}>
              <i class="fa-solid fa-message"></i> Mensagens pré-definidas
            </button>
          </div>
          <div>
            <button id="sigma-feedback-cancelar" class="sigma-feedback-btn" type="button">Cancelar</button>
            <button id="sigma-feedback-gravar" class="sigma-feedback-btn primario" type="button">
              <i class="fa-solid fa-paper-plane"></i> Gravar e Notificar
            </button>
          </div>
        </div>`;

      document.getElementById("sigma-feedback-cancelar").addEventListener("click", fecharModalFeedback);
      document.getElementById("sigma-feedback-premsg")?.addEventListener("click", abrirMensagensPredefinidas);
      document.getElementById("sigma-feedback-gravar").addEventListener("click", gravarFeedbackModal);
      setTimeout(function () { document.getElementById("sigma-feedback-editor")?.focus(); }, 50);
    } catch (falha) {
      console.error(PREFIXO, "Falha ao abrir feedback", falha);
      corpo.innerHTML = `<div class="sigma-vazio"><i class="fa-solid fa-triangle-exclamation"></i><br><br>${escaparHtml(texto(falha.message || falha))}<br><br><button class="sigma-feedback-btn" type="button" id="sigma-feedback-tentar-novamente">Tentar novamente</button></div>`;
      document.getElementById("sigma-feedback-tentar-novamente")?.addEventListener("click", function () { abrirModalFeedback(item); });
    }
  }

  function fecharModalFeedback(forcar = false) {
    if (state.modalFeedbackSalvando && !forcar) return;
    fecharMensagensPredefinidas();
    const modal = document.getElementById("sigma-feedback-modal");
    modal?.classList.remove("ativo");
    modal?.setAttribute("aria-hidden", "true");
    state.modalFeedbackItem = null;
    state.modalFeedbackLoteIds = [];
    state.modalFeedbackPares = [];
    state.modalFeedbackPreUrl = "";
  }

  function extrairParesFormulario(form) {
    const pares = [];
    Array.from(form.elements || []).forEach(function (campo) {
      const nome = campo.name;
      if (!nome || campo.disabled) return;
      const tipo = normalizar(campo.type || campo.tagName || "");
      if (["submit", "button", "reset", "file"].includes(tipo)) return;
      if (["checkbox", "radio"].includes(tipo) && !campo.checked) return;
      if (campo.tagName === "SELECT" && campo.multiple) {
        Array.from(campo.selectedOptions || []).forEach(function (option) { pares.push([nome, option.value]); });
        return;
      }
      pares.push([nome, campo.value == null ? "" : String(campo.value)]);
    });
    return pares;
  }

  // =========================================================
  // MENSAGENS_PREDEFINIDAS_SEM_AUTOFILL
  // Para localizar depois, use CTRL + F e procure por:
  // MENSAGENS_PREDEFINIDAS_SEM_AUTOFILL
  //
  // Alguns gerenciadores de senha interpretavam a busca como campo de login
  // e inseriam "elias.araujo". O modal também podia permanecer como uma
  // camada invisível depois de fechado. Esta versão neutraliza os dois casos.
  // =========================================================
  async function abrirMensagensPredefinidas(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    if (!state.modalFeedbackPreUrl) {
      toast("Este formulário não trouxe mensagens pré-definidas.", "aviso");
      return;
    }

    const modal = document.getElementById("sigma-premsg-modal");
    const corpo = document.getElementById("sigma-premsg-corpo");
    if (!modal || !corpo) return;

    // Remove qualquer estado residual deixado por uma abertura anterior.
    modal.style.removeProperty("display");
    modal.style.removeProperty("pointer-events");
    modal.classList.add("ativo");
    modal.setAttribute("aria-hidden", "false");
    state.premsgBuscaTocada = false;

    const urlMensagens = String(state.modalFeedbackPreUrl || "");
    if (state.mensagensPredefinidas.length && state.mensagensPredefinidasUrl === urlMensagens) {
      montarMensagensPredefinidas(state.mensagensPredefinidas);
      return;
    }

    if (state.premsgAbrindo) return;
    state.premsgAbrindo = true;
    corpo.innerHTML = '<div class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Carregando mensagens...</div>';

    try {
      if (state.premsgAbortController) {
        try { state.premsgAbortController.abort(); } catch (_) {}
      }
      const controller = new AbortController();
      state.premsgAbortController = controller;

      const resposta = await fetch(urlMensagens + (urlMensagens.includes("?") ? "&" : "?") + "_sigma=" + Date.now(), {
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Requested-With": "XMLHttpRequest" },
        signal: controller.signal,
      });
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status} ao carregar mensagens.`);

      const html = await resposta.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const mensagens = Array.from(doc.querySelectorAll('.search-list-mensagens li[data-mensagem], li.list-group-item[data-mensagem]')).map(function (li, index) {
        return {
          index,
          titulo: texto(li.getAttribute("data-mensagem") || li.querySelector("span")?.textContent || `Mensagem ${index + 1}`),
          html: String(li.querySelector(".predefinidas-body")?.innerHTML || "").trim(),
        };
      }).filter(function (msg) { return msg.html; });

      if (!mensagens.length) throw new Error("Nenhuma mensagem pré-definida foi encontrada.");

      state.mensagensPredefinidas = mensagens;
      state.mensagensPredefinidasUrl = urlMensagens;
      state._mensagensPredefinidas = mensagens;

      // O usuário pode fechar durante o carregamento. Nesse caso, guardamos
      // o cache, mas não reabrimos o modal sozinho.
      if (!modal.classList.contains("ativo")) return;
      montarMensagensPredefinidas(mensagens);
    } catch (falha) {
      if (falha?.name === "AbortError") return;
      if (modal.classList.contains("ativo")) {
        corpo.innerHTML = `<div class="sigma-vazio">${escaparHtml(texto(falha.message || falha))}</div>`;
      }
    } finally {
      state.premsgAbrindo = false;
      state.premsgAbortController = null;
    }
  }

  function montarMensagensPredefinidas(mensagens) {
    const modal = document.getElementById("sigma-premsg-modal");
    const corpo = document.getElementById("sigma-premsg-corpo");
    if (!modal || !corpo || !modal.classList.contains("ativo")) return;

    const nomeCampo = `sigma_premsg_filtro_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    corpo.innerHTML = `
      <div class="sigma-autofill-armadilha" aria-hidden="true">
        <input type="text" name="username" autocomplete="username" tabindex="-1">
        <input type="password" name="password" autocomplete="current-password" tabindex="-1">
      </div>
      <input
        id="sigma-premsg-busca"
        class="sigma-premsg-busca"
        type="text"
        name="${nomeCampo}"
        value=""
        placeholder="Buscar mensagem..."
        autocomplete="new-password"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        data-lpignore="true"
        data-1p-ignore="true"
        readonly
      >
      <div id="sigma-premsg-lista" class="sigma-premsg-lista">${htmlListaMensagens(mensagens)}</div>`;

    const busca = document.getElementById("sigma-premsg-busca");
    const lista = document.getElementById("sigma-premsg-lista");
    if (!busca || !lista) return;

    const filtrar = function () {
      const termo = normalizar(busca.value);
      const filtradas = mensagens.filter(function (msg) {
        return !termo || normalizar(msg.titulo + " " + removerHtml(msg.html)).includes(termo);
      });
      lista.innerHTML = htmlListaMensagens(filtradas);
    };

    const liberarBusca = function () {
      state.premsgBuscaTocada = true;
      busca.removeAttribute("readonly");
    };

    busca.addEventListener("pointerdown", liberarBusca, { once: true });
    busca.addEventListener("keydown", liberarBusca, { once: true });
    busca.addEventListener("focus", function () {
      busca.removeAttribute("readonly");
      if (!state.premsgBuscaTocada || pareceLoginAutopreenchido(busca.value)) {
        busca.value = "";
        filtrar();
      }
    });
    busca.addEventListener("input", function () {
      if (!state.premsgBuscaTocada && pareceLoginAutopreenchido(busca.value)) {
        busca.value = "";
      }
      filtrar();
    });
    lista.addEventListener("click", usarMensagemPredefinida);

    // Chrome e gerenciadores de senha podem preencher alguns milissegundos
    // depois da criação do campo. Fazemos uma limpeza curta sem roubar o foco.
    [0, 80, 220, 500, 1000, 1800].forEach(function (atraso) {
      setTimeout(function () {
        if (!modal.classList.contains("ativo") || state.premsgBuscaTocada) return;
        if (busca.value || pareceLoginAutopreenchido(busca.value)) {
          busca.value = "";
          filtrar();
        }
      }, atraso);
    });
  }

  function pareceLoginAutopreenchido(valor) {
    const atual = normalizar(valor).replace(/\s+/g, ".");
    if (!atual) return false;

    const nome = texto(state.usuario.nome || "");
    const candidatos = [
      state.usuario.login,
      nome,
      nome.replace(/\s+/g, "."),
      nome.replace(/\s+/g, ""),
    ].map(function (item) {
      return normalizar(item).replace(/\s+/g, ".");
    }).filter(Boolean);

    return candidatos.includes(atual) || (/^[a-z0-9._-]+$/.test(atual) && atual.includes(".") && candidatos.some(function (item) {
      return item && (atual.includes(item) || item.includes(atual));
    }));
  }

  function htmlListaMensagens(mensagens) {
    if (!mensagens.length) return '<div class="sigma-vazio">Nenhuma mensagem encontrada.</div>';
    return mensagens.map(function (msg) {
      return `<div class="sigma-premsg-item">
        <div><strong>${escaparHtml(msg.titulo)}</strong><div class="sigma-premsg-preview">${msg.html}</div></div>
        <button class="sigma-feedback-btn primario" type="button" data-premsg-index="${msg.index}">Usar</button>
      </div>`;
    }).join("");
  }

  function usarMensagemPredefinida(event) {
    const botao = event.target.closest("[data-premsg-index]");
    if (!botao) return;
    const index = Number(botao.dataset.premsgIndex);
    const msg = (state.mensagensPredefinidas || state._mensagensPredefinidas || []).find(function (item) { return item.index === index; });
    const editor = document.getElementById("sigma-feedback-editor");
    if (!msg || !editor) return;

    const atualTexto = texto(editor.textContent || "");
    editor.innerHTML = (atualTexto ? editor.innerHTML + "<p><br></p>" : "") + msg.html;
    editor.dispatchEvent(new Event("input", { bubbles:true }));
    fecharMensagensPredefinidas();
    editor.focus();
    toast(`Mensagem “${msg.titulo}” adicionada.`, "sucesso");
  }

  function fecharMensagensPredefinidas() {
    const modal = document.getElementById("sigma-premsg-modal");
    const corpo = document.getElementById("sigma-premsg-corpo");
    const busca = document.getElementById("sigma-premsg-busca");

    if (busca) busca.value = "";
    state.premsgBuscaTocada = false;

    if (state.premsgAbortController) {
      try { state.premsgAbortController.abort(); } catch (_) {}
      state.premsgAbortController = null;
    }
    state.premsgAbrindo = false;

    modal?.classList.remove("ativo");
    modal?.setAttribute("aria-hidden", "true");
    modal?.style.setProperty("display", "none", "important");
    modal?.style.setProperty("pointer-events", "none", "important");

    // Descarta apenas o DOM visual. A lista continua em cache para a próxima
    // abertura ser instantânea e não depender de uma segunda requisição.
    if (corpo) {
      corpo.innerHTML = '<div class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Carregando mensagens...</div>';
    }

    setTimeout(function () {
      document.getElementById("sigma-feedback-premsg")?.focus();
    }, 0);
  }

  function removerHtml(valor) {
    const doc = new DOMParser().parseFromString(String(valor || ""), "text/html");
    return texto(doc.body.textContent || "");
  }
  // =========================================================
  // ACOES_EM_LOTE
  // Para localizar depois, use CTRL + F e procure por:
  // ACOES_EM_LOTE
  // =========================================================
  function idsSelecionadosValidos() {
    const existentes = new Set(state.chamados.map(function (item) { return String(item.id); }));
    return Object.keys(state.selecionados).filter(function (id) { return state.selecionados[id] && existentes.has(String(id)); });
  }

  function itensSelecionados() {
    const ids = new Set(idsSelecionadosValidos());
    return state.chamados.filter(function (item) { return ids.has(String(item.id)); });
  }

  function idsVisiveisTabela() {
    return Array.from(document.querySelectorAll('#sigma-corpo-tabela tr[data-sigma-chamado-id]')).map(function (tr) {
      return texto(tr.getAttribute('data-sigma-chamado-id'));
    }).filter(Boolean);
  }

  function alternarSelecaoChamado(id, selecionado) {
    id = texto(id);
    if (!id) return;
    if (selecionado) state.selecionados[id] = true;
    else delete state.selecionados[id];
    atualizarSelecaoVisual();
  }

  function selecionarTodosVisiveis(marcar) {
    idsVisiveisTabela().forEach(function (id) {
      if (marcar) state.selecionados[id] = true;
      else delete state.selecionados[id];
    });
    atualizarSelecaoVisual();
  }

  function atualizarSelecaoVisual() {
    const idsValidos = new Set(idsSelecionadosValidos());
    Object.keys(state.selecionados).forEach(function (id) {
      if (!idsValidos.has(id)) delete state.selecionados[id];
    });

    const idsVisiveis = idsVisiveisTabela();
    const totalSel = Object.keys(state.selecionados).length;
    const visiveisSel = idsVisiveis.filter(function (id) { return !!state.selecionados[id]; }).length;

    document.querySelectorAll('#sigma-corpo-tabela .sigma-check-item').forEach(function (input) {
      const id = texto(input.dataset.id);
      input.checked = !!state.selecionados[id];
      const tr = input.closest('tr');
      if (tr) tr.classList.toggle('sigma-selecionado', !!state.selecionados[id]);
    });

    const master = document.getElementById('sigma-selecao-todos');
    if (master) {
      master.checked = !!idsVisiveis.length && visiveisSel === idsVisiveis.length;
      master.indeterminate = visiveisSel > 0 && visiveisSel < idsVisiveis.length;
    }

    const count = document.getElementById('sigma-lote-count');
    if (count) count.textContent = String(totalSel);
    const btn = document.getElementById('sigma-abrir-lote');
    if (btn) btn.disabled = totalSel === 0;
  }

  async function carregarEstruturaFeedback(item) {
    const url = new URL(`/backend/chamados/detalhes/${encodeURIComponent(item.id)}`, window.location.origin);
    url.searchParams.set('action', 'lista');
    url.searchParams.set('tab', 'tab-interacoes');
    url.searchParams.set('_sigma', String(Date.now()));

    const resposta = await fetch(url.toString(), {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status} ao carregar o formulário.`);

    const html = await resposta.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const form = doc.querySelector('#form-interacao');
    if (!form) throw new Error('O InfraDesk não devolveu o formulário de interação.');

    const pares = extrairParesFormulario(form);
    const linkPre = doc.querySelector('a[href*="/backend/mensagens_predefinidas/listar"]');
    const preUrl = linkPre ? new URL(linkPre.getAttribute('href'), window.location.origin).toString() : '';
    const selectStatus = form.querySelector('[name="status_chamado_id"]');
    const opcoesStatus = montarOpcoesStatusFeedback(item, selectStatus);
    const mensagemInicial = form.querySelector('[name="mensagem"]')?.value || '';
    return { pares, preUrl, opcoesStatus, mensagemInicial };
  }

  function montarOpcoesStatusFeedback(item, selectStatus) {
    const opcoesStatus = [];
    const statusJaIncluidos = new Set();

    if (selectStatus) {
      Array.from(selectStatus.options).forEach(function (option) {
        const id = String(option.value || '');
        if (!id || statusJaIncluidos.has(id)) return;
        statusJaIncluidos.add(id);
        opcoesStatus.push({
          id: id,
          nome: texto(option.textContent) || CONFIG.statusNomes[id] || `Status ${id}`,
          selected: !!option.selected,
        });
      });
    }

    CONFIG.feedbackStatusIds.forEach(function (id) {
      if (statusJaIncluidos.has(id)) return;
      statusJaIncluidos.add(id);
      opcoesStatus.push({
        id: id,
        nome: CONFIG.statusNomes[id] || `Status ${id}`,
        selected: !selectStatus && id === String(item.statusId || ''),
      });
    });

    if (!opcoesStatus.some(function (option) { return option.selected; })) {
      const atual = opcoesStatus.find(function (option) {
        return option.id === String(item.statusId || '');
      });
      if (atual) atual.selected = true;
    }
    return opcoesStatus;
  }

  function htmlOpcoesStatusFeedback(opcoesStatus) {
    return opcoesStatus.map(function (option) {
      return `<option value="${escaparHtml(option.id)}" ${option.selected ? 'selected' : ''}>${escaparHtml(option.nome)}</option>`;
    }).join('');
  }

  async function abrirModalFeedbackLote() {
    const itens = itensSelecionados();
    if (!itens.length) {
      toast('Selecione pelo menos um chamado para usar a ação em lote.', 'aviso');
      return;
    }

    const base = itens[0];
    state.modalFeedbackItem = base;
    state.modalFeedbackLoteIds = itens.map(function (item) { return item.id; });
    state.modalFeedbackPares = [];
    state.modalFeedbackPreUrl = '';
    state.modalFeedbackSalvando = false;

    const modal = document.getElementById('sigma-feedback-modal');
    const corpo = document.getElementById('sigma-feedback-corpo');
    const titulo = document.getElementById('sigma-feedback-titulo');
    titulo.textContent = `Ação em lote • ${itens.length} chamados`;
    corpo.innerHTML = '<div class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Preparando formulário em lote...</div>';
    modal.classList.add('ativo');
    modal.setAttribute('aria-hidden', 'false');

    try {
      const estrutura = await carregarEstruturaFeedback(base);
      state.modalFeedbackPares = estrutura.pares;
      state.modalFeedbackPreUrl = estrutura.preUrl;
      const options = htmlOpcoesStatusFeedback(estrutura.opcoesStatus);
      const resumoIds = itens.slice(0, 8).map(function (item) { return `#${item.id}`; }).join(', ');
      const sobra = itens.length > 8 ? ` e mais ${itens.length - 8}` : '';

      corpo.innerHTML = `
        <div class="sigma-feedback-resumo-lote">
          <strong>${itens.length} chamados selecionados</strong>
          <small>${escaparHtml(resumoIds + sobra)}</small>
          <small>Você escolhe uma única vez o status e a ocorrência. O painel grava um por um automaticamente.</small>
        </div>
        <div class="sigma-feedback-campo">
          <label for="sigma-feedback-status">Status para todos os selecionados</label>
          <select id="sigma-feedback-status" data-noselect="1">${options}</select>
        </div>
        <div class="sigma-feedback-campo">
          <label for="sigma-feedback-editor">Ocorrência única para todos</label>
          <div id="sigma-feedback-editor" contenteditable="true" role="textbox" aria-multiline="true"></div>
        </div>
        <div class="sigma-feedback-acoes">
          <div>
            <button id="sigma-feedback-premsg" class="sigma-feedback-btn" type="button" ${state.modalFeedbackPreUrl ? '' : 'disabled'}>
              <i class="fa-solid fa-message"></i> Mensagens pré-definidas
            </button>
          </div>
          <div>
            <button id="sigma-feedback-cancelar" class="sigma-feedback-btn" type="button">Cancelar</button>
            <button id="sigma-feedback-gravar" class="sigma-feedback-btn primario" type="button">
              <i class="fa-solid fa-paper-plane"></i> Gravar em ${itens.length} chamados
            </button>
          </div>
        </div>`;

      document.getElementById('sigma-feedback-cancelar').addEventListener('click', fecharModalFeedback);
      document.getElementById('sigma-feedback-premsg')?.addEventListener('click', abrirMensagensPredefinidas);
      document.getElementById('sigma-feedback-gravar').addEventListener('click', gravarFeedbackModal);
      setTimeout(function () { document.getElementById('sigma-feedback-editor')?.focus(); }, 50);
    } catch (falha) {
      console.error(PREFIXO, 'Falha ao abrir feedback em lote', falha);
      corpo.innerHTML = `<div class="sigma-vazio"><i class="fa-solid fa-triangle-exclamation"></i><br><br>${escaparHtml(texto(falha.message || falha))}<br><br><button class="sigma-feedback-btn" type="button" id="sigma-feedback-tentar-novamente">Tentar novamente</button></div>`;
      document.getElementById('sigma-feedback-tentar-novamente')?.addEventListener('click', abrirModalFeedbackLote);
    }
  }

  function aplicarResultadoFeedbackNoItem(item, novoStatus, mensagemTexto) {
    if (CONFIG.statusIds.includes(novoStatus)) {
      item.statusId = novoStatus;
      item.statusNome = CONFIG.statusNomes[novoStatus] || item.statusNome;
      item.atualizado = new Date();
      item.atualizadoTexto = formatarDataHora(item.atualizado);
      item.atualizadoPor = state.usuario.nome || state.usuario.login || item.atualizadoPor;
      item.descricaoResumo = mensagemTexto;
      item.busca += ' ' + normalizar(mensagemTexto);
    } else {
      state.chamados = state.chamados.filter(function (chamado) { return chamado.id !== item.id; });
      delete state.selecionados[item.id];
    }
  }

  async function enviarFeedbackParaItem(item, statusId, mensagemHtml) {
    const estrutura = await carregarEstruturaFeedback(item);
    const dados = new URLSearchParams();
    estrutura.pares.forEach(function ([nome, valor]) {
      if (nome === 'mensagem' || nome === 'status_chamado_id') return;
      dados.append(nome, valor);
    });
    dados.append('mensagem', mensagemHtml);
    dados.append('status_chamado_id', statusId);

    const resposta = await fetch(`/backend/chamados/enviarEmail/${encodeURIComponent(item.id)}.json`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: dados.toString(),
    });
    if (!resposta.ok) throw new Error(`InfraDesk retornou HTTP ${resposta.status}.`);
    const textoResposta = await resposta.text();
    let json = null;
    try { json = JSON.parse(textoResposta); } catch (_) {}
    if (!json || json.success === false) {
      throw new Error(texto(json?.message || json?.mensagem || 'O InfraDesk não confirmou a gravação.'));
    }
    return json;
  }

  async function gravarFeedbackLote(mensagemHtml, mensagemTexto, statusId, botao) {
    const ids = state.modalFeedbackLoteIds.slice();
    const itens = ids.map(function (id) {
      return state.chamados.find(function (item) { return String(item.id) === String(id); });
    }).filter(Boolean);

    if (!itens.length) throw new Error('Nenhum chamado selecionado ainda está disponível no painel.');

    let sucesso = 0;
    const falhas = [];
    for (let i = 0; i < itens.length; i++) {
      const item = itens[i];
      if (botao && document.body.contains(botao)) {
        botao.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Gravando ${i + 1}/${itens.length}...`;
      }
      try {
        const json = await enviarFeedbackParaItem(item, statusId, mensagemHtml);
        const novoStatus = String(json.chamado?.status_chamado_id || statusId || item.statusId);
        aplicarResultadoFeedbackNoItem(item, novoStatus, mensagemTexto);
        delete state.selecionados[item.id];
        sucesso++;
      } catch (erro) {
        console.error(PREFIXO, 'Erro no lote', item.id, erro);
        falhas.push(`#${item.id}: ${texto(erro.message || erro)}`);
      }
    }

    reconstruirFiltros();
    sincronizarTabelaIncremental();

    if (falhas.length) {
      const resumo = falhas.slice(0, 3).join(' | ');
      throw new Error(`${sucesso} gravado(s) e ${falhas.length} falha(s). ${resumo}`);
    }

    toast(`${sucesso} chamado(s) gravado(s) em lote com sucesso!`, 'sucesso');
    atualizarStatus(`${sucesso} chamados atualizados em lote sem sair do painel.`);
  }

  async function gravarFeedbackModal() {
    if (state.modalFeedbackSalvando) return;
    const item = state.modalFeedbackItem;
    const editor = document.getElementById("sigma-feedback-editor");
    const select = document.getElementById("sigma-feedback-status");
    const botao = document.getElementById("sigma-feedback-gravar");
    if (!item || !editor || !select) return;

    const mensagemHtml = String(editor.innerHTML || "").trim();
    const mensagemTexto = removerHtml(mensagemHtml);
    if (!mensagemTexto) {
      toast("Preencha a interação antes de gravar.", "aviso");
      editor.focus();
      return;
    }

    state.modalFeedbackSalvando = true;
    botao.disabled = true;
    botao.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gravando...';

    try {
      if (state.modalFeedbackLoteIds.length) {
        await gravarFeedbackLote(mensagemHtml, mensagemTexto, select.value, botao);
      } else {
        const json = await enviarFeedbackParaItem(item, select.value, mensagemHtml);
        const novoStatus = String(json.chamado?.status_chamado_id || select.value || item.statusId);
        aplicarResultadoFeedbackNoItem(item, novoStatus, mensagemTexto);
        reconstruirFiltros();
        sincronizarTabelaIncremental();
        toast(`Interação do chamado #${item.id} gravada com sucesso!`, "sucesso");
        atualizarStatus(`Chamado #${item.id} atualizado sem sair do painel.`);
      }
      // FECHAR_MODAL_APOS_GRAVAR
      // Durante a gravação modalFeedbackSalvando ainda está true. O fechamento
      // precisa ser forçado somente depois que o InfraDesk confirmou sucesso.
      fecharModalFeedback(true);
    } catch (falha) {
      console.error(PREFIXO, "Erro ao gravar feedback", falha);
      toast(`Não consegui gravar: ${texto(falha.message || falha)}`, "erro");
    } finally {
      state.modalFeedbackSalvando = false;
      if (botao && document.body.contains(botao)) {
        botao.disabled = false;
        botao.innerHTML = state.modalFeedbackLoteIds.length
          ? `<i class="fa-solid fa-paper-plane"></i> Gravar em ${state.modalFeedbackLoteIds.length} chamados`
          : '<i class="fa-solid fa-paper-plane"></i> Gravar e Notificar';
      }
    }
  }

  // =========================================================
  // DETALHES_REAIS_EM_MODAL
  // Para localizar depois, use CTRL + F e procure por:
  // DETALHES_REAIS_EM_MODAL
  //
  // O endpoint de detalhes devolve somente o #Modalv quando é chamado pelo
  // jQuery original do InfraDesk. Abrir a URL diretamente no iframe podia
  // carregar a página inteira, ficar branca ou travar. Agora o iframe primeiro
  // abre uma página normal do InfraDesk, aproveita todas as dependências reais
  // e depois solicita/injeta apenas o modal retornado pelo sistema.
  // =========================================================
  function mostrarCarregamentoModal(titulo, detalhe) {
    const el = document.getElementById("sigma-modal-carregando");
    const tituloEl = document.getElementById("sigma-modal-carregando-titulo");
    const detalheEl = document.getElementById("sigma-modal-carregando-detalhe");
    if (tituloEl) tituloEl.textContent = titulo || "Carregando...";
    if (detalheEl) detalheEl.textContent = detalhe || "Preparando o conteúdo sem sair do painel.";
    if (el) el.classList.add("ativo");
  }

  function ocultarCarregamentoModal() {
    const el = document.getElementById("sigma-modal-carregando");
    if (el) el.classList.remove("ativo");
  }

  function abrirModal(url, titulo) {
    if (!url) return;
    const modal = document.getElementById("sigma-modal");
    const frame = document.getElementById("sigma-modal-frame");
    const link = document.getElementById("sigma-modal-nova-aba");
    const tituloEl = document.getElementById("sigma-modal-titulo");
    const urlCompleta = new URL(url, window.location.origin).toString();

    state.modalModo = "iframe";
    state.modalItem = null;
    state.modalUrl = urlCompleta;
    state.modalCarregandoDetalhes = false;

    tituloEl.textContent = titulo || "InfraDesk";
    link.href = urlCompleta;
    mostrarCarregamentoModal("Carregando conteúdo...", "Consultando o InfraDesk sem sair do painel.");
    frame.style.visibility = "hidden";
    frame.src = urlCompleta;
    modal.classList.add("ativo");
    modal.setAttribute("aria-hidden", "false");
  }

  function abrirModalDetalhes(item, recarregar) {
    if (!item || !item.id) return;

    const modal = document.getElementById("sigma-modal");
    const frame = document.getElementById("sigma-modal-frame");
    const link = document.getElementById("sigma-modal-nova-aba");
    const tituloEl = document.getElementById("sigma-modal-titulo");
    const detalhesUrl = new URL(item.detalhesUrl || `/backend/chamados/detalhes/${encodeURIComponent(item.id)}`, window.location.origin).toString();

    state.modalModo = "detalhes";
    state.modalItem = item;
    state.modalUrl = detalhesUrl;
    state.modalCarregandoDetalhes = true;

    tituloEl.textContent = `Chamado #${item.id} • Detalhes`;
    link.href = detalhesUrl;
    mostrarCarregamentoModal(
      recarregar ? "Recarregando detalhes..." : `Abrindo chamado #${item.id}...`,
      "Carregando somente o modal real do InfraDesk e mantendo as abas funcionais."
    );
    frame.style.visibility = "hidden";

    modal.classList.add("ativo");
    modal.setAttribute("aria-hidden", "false");

    const motorUrl = new URL(montarUrlFonte(1));
    motorUrl.searchParams.set("sigma_modal_detalhes", String(Date.now()));
    frame.src = motorUrl.toString();
  }

  async function prepararFrameModal() {
    const frame = document.getElementById("sigma-modal-frame");
    if (!frame || !frame.src || frame.src === "about:blank") return;

    if (state.modalModo === "detalhes" && state.modalItem) {
      await carregarDetalhesNoFrame(frame, state.modalItem);
      return;
    }

    prepararConteudoModal();
    frame.style.visibility = "visible";
    ocultarCarregamentoModal();
  }

  function esperarJqueryNoFrame(frame, limiteMs) {
    limiteMs = limiteMs || 20000;
    return new Promise(function (resolve, reject) {
      const inicio = Date.now();
      const verificar = function () {
        try {
          const win = frame.contentWindow;
          if (win && win.jQuery && typeof win.jQuery.get === "function") {
            resolve(win.jQuery);
            return;
          }
        } catch (_) {}

        if (Date.now() - inicio >= limiteMs) {
          reject(new Error("O motor visual do InfraDesk não carregou o jQuery a tempo."));
          return;
        }
        setTimeout(verificar, 100);
      };
      verificar();
    });
  }

  async function carregarDetalhesNoFrame(frame, item) {
    if (!frame || !item || !item.id || !state.modalCarregandoDetalhes) return;

    try {
      const jq = await esperarJqueryNoFrame(frame, 20000);
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc) throw new Error("Não consegui acessar o conteúdo interno do modal.");

      const url = item.detalhesUrl || `/backend/chamados/detalhes/${encodeURIComponent(item.id)}?action=lista`;
      const html = await new Promise(function (resolve, reject) {
        jq.ajax({
          url: url,
          type: "GET",
          cache: false,
          dataType: "html",
          success: resolve,
          error: function (xhr) {
            reject(new Error(`InfraDesk respondeu ${xhr?.status || 0} ao carregar os detalhes.`));
          },
        });
      });

      if (state.modalModo !== "detalhes" || state.modalItem?.id !== item.id) return;

      jq("#Modalv,#modalPreMsg,.modal-backdrop", doc).remove();

      // O endpoint usado pela lista normalmente devolve apenas o CONTEÚDO da
      // .modal-content. O #Modalv já existe na página original e por isso não
      // vem novamente na resposta. Quando vier o modal completo, preservamos;
      // quando vier apenas o fragmento, criamos a mesma estrutura do InfraDesk.
      if (/id=["']Modalv["']/i.test(html)) {
        jq(doc.body).append(html);
      } else {
        const estrutura = jq(
          '<div id="Modalv" class="modal fade in" role="dialog" aria-hidden="false" style="display:block">' +
            '<div class="modal-dialog modal-xl" style="width:97%;max-width:1340px">' +
              '<div class="modal-content"></div>' +
            '</div>' +
          '</div>'
        );
        jq(doc.body).append(estrutura);
        jq("#Modalv .modal-content", doc).append(html);
      }

      const modalReal = doc.getElementById("Modalv");
      if (!modalReal || !modalReal.querySelector(".modal-content")) {
        throw new Error("O InfraDesk não devolveu conteúdo utilizável para os detalhes.");
      }

      instalarEstiloFrameDetalhes(doc);
      instalarEventosFrameDetalhes(doc, item);

      const $modal = jq(modalReal);
      $modal.addClass("in").attr("aria-hidden", "false").css({ display: "block" });
      jq(".modal-backdrop", doc).remove();

      // O servidor pode devolver a aba Tags já marcada como ativa. Não forçamos
      // outra aba: preservamos exatamente o estado que veio do InfraDesk.
      const abaAtiva = modalReal.querySelector('.nav-tabs li.active a[data-toggle="tab"]');
      if (abaAtiva && abaAtiva.getAttribute("href")) {
        const painelAtivo = modalReal.querySelector(abaAtiva.getAttribute("href"));
        if (painelAtivo) painelAtivo.classList.add("active");
      }

      state.modalCarregandoDetalhes = false;
      frame.style.visibility = "visible";
      ocultarCarregamentoModal();
    } catch (falha) {
      state.modalCarregandoDetalhes = false;
      console.error(PREFIXO, "Erro ao abrir detalhes no modal", falha);
      mostrarCarregamentoModal(
        "Não consegui abrir os detalhes",
        texto(falha.message || falha) + " Use Nova aba enquanto ajustamos este chamado específico."
      );
      toast("Não consegui abrir o modal de detalhes: " + texto(falha.message || falha), "erro");
    }
  }

  function instalarEstiloFrameDetalhes(doc) {
    let style = doc.getElementById("sigma-frame-detalhes-css");
    if (!style) {
      style = doc.createElement("style");
      style.id = "sigma-frame-detalhes-css";
      (doc.head || doc.documentElement).appendChild(style);
    }

    style.textContent = `
      html,body { width:100%!important;min-height:100%!important;margin:0!important;background:#f3f3f3!important;overflow:auto!important; }
      body > *:not(#Modalv):not(#modalPreMsg):not(.select2-container):not(.select2-dropdown):not(.daterangepicker):not(.tooltip):not(.popover):not(.note-modal):not(.modal-backdrop) { display:none!important; }
      body.modal-open { overflow:auto!important;padding-right:0!important; }
      .modal-backdrop { display:none!important; }
      #Modalv { position:relative!important;inset:auto!important;z-index:1!important;display:block!important;width:100%!important;min-height:100vh!important;padding:0!important;overflow:visible!important;background:#f3f3f3!important; }
      #Modalv .modal-dialog { width:100%!important;max-width:none!important;margin:0!important;padding:0!important;transform:none!important; }
      #Modalv .modal-content { min-height:100vh!important;border:0!important;border-radius:0!important;box-shadow:none!important; }
      /* A barra azul do Painel já permanece fixa. O cabeçalho interno do
         InfraDesk não deve ficar sticky, pois ele cobria parcialmente o menu
         Geral / Interação / Tags / Fornecedor ao rolar ou ao abrir o modal. */
      #Modalv > .modal-dialog > .modal-content > .modal-header {
        position:relative!important;top:auto!important;z-index:2!important;
        background:#fff!important;border-bottom:1px solid #d8e1ec!important;
      }
      #Modalv .modal-body { min-height:calc(100vh - 55px)!important;padding-top:14px!important;overflow:visible!important; }
      #Modalv .tabs-container { padding-top:2px!important;overflow:visible!important; }
      #Modalv .tabs-container > .nav-tabs {
        position:relative!important;top:auto!important;z-index:3!important;
        display:block!important;min-height:43px!important;margin-top:0!important;
        padding-top:2px!important;background:#fff!important;
      }
      #Modalv .tabs-container > .nav-tabs > li,
      #Modalv .tabs-container > .nav-tabs > li > a { visibility:visible!important;opacity:1!important; }
      #modalPreMsg { z-index:5000!important; }
      #modalPreMsg + .modal-backdrop,.modal-backdrop.in { z-index:4990!important;display:block!important; }
      .select2-container,.select2-dropdown,.daterangepicker,.tooltip,.popover,.note-modal { z-index:6000!important; }
    `;
  }

  function instalarEventosFrameDetalhes(doc, item) {
    if (doc.documentElement.dataset.sigmaDetalhesEventos === "1") return;
    doc.documentElement.dataset.sigmaDetalhesEventos = "1";

    doc.addEventListener("click", function (event) {
      const fechar = event.target?.closest?.("#Modalv > .modal-dialog > .modal-content > .modal-header .close[data-dismiss=modal]");
      if (fechar) {
        event.preventDefault();
        event.stopPropagation();
        fecharModal();
      }
    }, true);

    const observer = new MutationObserver(function () {
      const modal = doc.getElementById("Modalv");
      if (!modal) return;
      const status = modal.querySelector('[name="status_chamado_id"]')?.value;
      if (status && CONFIG.statusNomes[String(status)]) {
        item.statusId = String(status);
        item.statusNome = CONFIG.statusNomes[String(status)];
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["value", "class"] });
  }

  function fecharModal() {
    const modal = document.getElementById("sigma-modal");
    const frame = document.getElementById("sigma-modal-frame");
    if (!modal?.classList.contains("ativo")) return;
    modal.classList.remove("ativo");
    modal.setAttribute("aria-hidden", "true");
    state.modalModo = "";
    state.modalItem = null;
    state.modalUrl = "";
    state.modalCarregandoDetalhes = false;
    ocultarCarregamentoModal();
    if (frame) {
      frame.style.visibility = "hidden";
      frame.src = "about:blank";
    }
  }

  // =========================================================
  // PONTE_MENSAGENS_PREDEFINIDAS
  // O formulário de feedback usa Summernote e abre outro modal para escolher
  // mensagens prontas. Dentro do iframe, algumas versões alteram somente o
  // editor visual ou somente o textarea. Esta ponte mantém os dois sincronizados.
  // Para localizar depois, use CTRL + F e procure por:
  // PONTE_MENSAGENS_PREDEFINIDAS
  // =========================================================
  function prepararConteudoModal() {
    const frame = document.getElementById("sigma-modal-frame");
    if (!frame || !frame.src || frame.src === "about:blank") return;

    try {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc || doc.documentElement.dataset.sigmaPonteMensagem === "1") return;
      doc.documentElement.dataset.sigmaPonteMensagem = "1";

      const sincronizarDepois = function () {
        [0, 80, 220, 500].forEach(function (tempo) {
          setTimeout(function () { sincronizarEditorMensagem(doc, win); }, tempo);
        });
      };

      doc.addEventListener("click", function (event) {
        const alvo = event.target && event.target.closest
          ? event.target.closest("[data-mensagem],[data-message],[data-texto],[data-conteudo],a,button,li,tr")
          : null;
        const antes = lerMensagemEditor(doc);
        sincronizarDepois();

        if (!alvo || !pareceOpcaoMensagem(alvo)) return;
        const candidata = extrairMensagemDaOpcao(alvo);
        if (!candidata) return;

        setTimeout(function () {
          const depois = lerMensagemEditor(doc);
          if (!depois || depois === antes) preencherMensagemEditor(doc, win, candidata);
        }, 140);
      }, true);

      doc.addEventListener("submit", function () {
        sincronizarEditorMensagem(doc, win, true);
      }, true);

      const observer = new win.MutationObserver(function () {
        sincronizarEditorMensagem(doc, win);
      });
      observer.observe(doc.body || doc.documentElement, { childList:true, subtree:true });
      sincronizarDepois();
    } catch (erro) {
      console.warn(PREFIXO, "Não consegui instalar a ponte das mensagens predefinidas.", erro);
    }
  }

  function localizarCampoMensagem(doc) {
    return doc.querySelector('textarea[name="mensagem"], textarea#mensagem, textarea[name*="mensagem" i]');
  }

  function localizarEditorVisual(doc) {
    return doc.querySelector('.note-editor .note-editable, .note-editable[contenteditable="true"], [contenteditable="true"][data-placeholder*="mensag" i]');
  }

  function lerMensagemEditor(doc) {
    const visual = localizarEditorVisual(doc);
    const textarea = localizarCampoMensagem(doc);
    const htmlVisual = visual ? texto(visual.innerHTML) : "";
    return htmlVisual || texto(textarea?.value || "");
  }

  function sincronizarEditorMensagem(doc, win, forcarTextarea) {
    const textarea = localizarCampoMensagem(doc);
    const visual = localizarEditorVisual(doc);
    if (!textarea && !visual) return;

    const htmlVisual = visual ? String(visual.innerHTML || "").trim() : "";
    const valorTextarea = textarea ? String(textarea.value || "").trim() : "";

    const visualVazio = !visual || !texto(visual.textContent || "") || /^(?:<p>)?<br\s*\/?>(?:<\/p>)?$/i.test(htmlVisual);

    if (visual && valorTextarea && visualVazio) {
      visual.innerHTML = pareceHtml(valorTextarea) ? valorTextarea : escaparHtml(valorTextarea).replace(/\n/g, "<br>");
      visual.dispatchEvent(new win.Event("input", { bubbles:true }));
    }

    if (textarea && visual && (forcarTextarea || htmlVisual) && textarea.value !== visual.innerHTML) {
      textarea.value = visual.innerHTML;
      textarea.dispatchEvent(new win.Event("input", { bubbles:true }));
      textarea.dispatchEvent(new win.Event("change", { bubbles:true }));
    }
  }

  function preencherMensagemEditor(doc, win, conteudo) {
    conteudo = String(conteudo || "").trim();
    if (!conteudo) return;
    const textarea = localizarCampoMensagem(doc);
    const visual = localizarEditorVisual(doc);
    const html = pareceHtml(conteudo) ? conteudo : escaparHtml(conteudo).replace(/\n/g, "<br>");

    if (textarea) {
      textarea.value = html;
      textarea.dispatchEvent(new win.Event("input", { bubbles:true }));
      textarea.dispatchEvent(new win.Event("change", { bubbles:true }));
    }
    if (visual) {
      visual.innerHTML = html;
      visual.dispatchEvent(new win.Event("input", { bubbles:true }));
      visual.dispatchEvent(new win.Event("keyup", { bubbles:true }));
    }

    try {
      const $ = win.jQuery || win.$;
      if ($ && textarea) {
        $(textarea).val(html).trigger("input").trigger("change");
        if ($.fn && typeof $.fn.summernote === "function" && $(textarea).next(".note-editor").length) {
          $(textarea).summernote("code", html);
        }
      }
    } catch (_) {}
  }

  function pareceOpcaoMensagem(alvo) {
    if (!alvo) return false;
    if (alvo.matches('[data-mensagem],[data-message],[data-texto],[data-conteudo]')) return true;
    const contexto = alvo.closest('[id*="mensag" i],[class*="mensag" i],[id*="predef" i],[class*="predef" i],[id*="padrao" i],[class*="padrao" i],.modal,.dropdown-menu');
    const contextoTexto = normalizar([
      contexto?.id || "",
      contexto?.className || "",
      contexto?.getAttribute?.("aria-label") || "",
      alvo.getAttribute?.("onclick") || "",
      alvo.getAttribute?.("title") || "",
    ].join(" "));
    return /mensag|predef|pre-def|resposta pronta|resposta padrao|texto padrao/.test(contextoTexto);
  }

  function extrairMensagemDaOpcao(alvo) {
    const container = alvo.closest?.('[data-mensagem],[data-message],[data-texto],[data-conteudo],tr,li,.list-group-item,.card,.panel') || alvo;
    const atributos = ["data-mensagem", "data-message", "data-texto", "data-conteudo", "data-content"];
    for (const nome of atributos) {
      const valor = alvo.getAttribute?.(nome) || container.getAttribute?.(nome);
      if (texto(valor).length >= 5) return valor;
    }

    const campoInterno = container.querySelector?.('textarea,input[type="hidden"],[data-mensagem],[data-texto],.mensagem,.texto,.descricao,p,td');
    const candidatos = [
      campoInterno?.value,
      campoInterno?.getAttribute?.("data-mensagem"),
      campoInterno?.getAttribute?.("data-texto"),
      campoInterno?.innerHTML,
      alvo.getAttribute?.("value"),
      alvo.getAttribute?.("title"),
      container.innerHTML,
      container.textContent,
      alvo.innerHTML,
      alvo.textContent,
    ];

    for (const candidato of candidatos) {
      const limpo = texto(candidato);
      if (limpo.length < 5) continue;
      if (/^(selecionar|usar|escolher|fechar|cancelar|ok|mensagem|editar)$/i.test(limpo)) continue;
      return String(candidato).trim();
    }
    return "";
  }

  function pareceHtml(valor) {
    return /<[^>]+>/.test(String(valor || ""));
  }

  // =========================================================
  // ATUALIZACAO
  // =========================================================
  async function atualizarTudo() {
    const assinaturasAntes = new Map(state.chamados.map(function (item) {
      return [String(item.id), assinaturaLinhaItem(item)];
    }));

    // As reservas já chegam pelo stream econômico. Aqui atualizamos somente
    // o InfraDesk e removemos travas mínimas que venceram.
    await carregarTodosChamados();
    limparReservasExpiradasDoCache();
    aplicarCacheComplementosAntesDaPrimeiraRenderizacao();
    reconstruirFiltros();
    sincronizarTabelaIncremental(assinaturasAntes);
    agendarComplementoNfEmOciosidade();
  }

  function configurarAtualizacaoAutomatica() {
    clearInterval(state.autoTimer);
    if (!CONFIG.atualizarAutomaticamenteMs) return;
    state.autoTimer = setInterval(function () {
      const selecao = window.getSelection?.();
      if (document.hidden || state.carregando || state.enriquecendoDadosNf || Object.keys(state.capturandoIds).length || (selecao && !selecao.isCollapsed)) return;
      atualizarTudo();
    }, CONFIG.atualizarAutomaticamenteMs);
  }

  function mostrarErroFatal(falha) {
    if (!document.body) return;
    document.body.innerHTML = `<div style="padding:40px;font-family:Arial;background:#fff;color:#172033;min-height:100vh">
      <h2>Não consegui abrir o Painel da Doca</h2>
      <p>${escaparHtml(texto(falha?.message || falha || "Erro desconhecido"))}</p>
      <p><a href="/backend/chamados">Voltar para o InfraDesk</a></p>
    </div>`;
  }

  window.addEventListener("beforeunload", function () {
    if (state.eventSource) state.eventSource.close();
    if (state.autoTimer) clearInterval(state.autoTimer);
    if (state.filtrosObserver) state.filtrosObserver.disconnect();
    if (state.integracaoObserver) state.integracaoObserver.disconnect();
    if (state.complementoNfTimer) clearTimeout(state.complementoNfTimer);
    if (state.integracaoViewportTimer) clearTimeout(state.integracaoViewportTimer);
    const wrap = document.querySelector(".sigma-grade-wrap");
    if (wrap && state.integracaoScrollHandler) wrap.removeEventListener("scroll", state.integracaoScrollHandler);
    if (state.integracaoResizeHandler) window.removeEventListener("resize", state.integracaoResizeHandler);
  });
})();

  // =========================================================
  // MODULO_KANBAN_LEVE_UNIFICADO
  // O módulo abaixo fica fora deste IIFE e só atua no Kanban normal.
  // =========================================================

(function () {
  'use strict';

  // Dentro do arquivo unificado, este módulo cuida somente do Kanban normal.
  // O painel independente possui seu próprio motor econômico.
  if (window.top !== window.self) {
    return;
  }

  try {
    if (new URL(window.location.href).searchParams.get('sigma_painel_doca') === '1') {
      return;
    }
  } catch (_) {}

  var InfraDeskDoca = {};

  InfraDeskDoca.__name = 'InfraDeskDoca';

  // Se sua URL do Realtime Database for diferente, troque aqui.
  InfraDeskDoca.FIREBASE_DB_URL = 'https://infra-doca-default-rtdb.firebaseio.com';

  InfraDeskDoca.FIREBASE_ROOT = 'doca_capturas';

  // RESERVAS_ATIVAS_ECONOMICAS_KANBAN
  // Para localizar depois, use CTRL + F e procure por:
  // RESERVAS_ATIVAS_ECONOMICAS_KANBAN
  InfraDeskDoca.FIREBASE_ACTIVE_ROOT = 'reservas_ativas';

  // Compatibilidade com as versões antigas:
  // continua usando doca_capturas/by_id/{chamadoId}.
  // Uma reserva de outro usuário só bloqueia por 1 hora.
  // A mesma pessoa pode recapturar antes disso, útil quando o chamado foi reaberto no Infradesk.
  InfraDeskDoca.RESERVA_VALIDADE_MS = 60 * 60 * 1000;
  InfraDeskDoca.RESERVA_VALIDADE_LABEL = '1 hora';

  InfraDeskDoca.STATUS_ABERTO = '2';
  InfraDeskDoca.STATUS_EM_LIBERACAO = '3';
  InfraDeskDoca.STATUS_EM_LIBERACAO_NOME = 'Em liberação';
  InfraDeskDoca.STATUS_EM_ANALISE_TERCEIRO = '6';
  InfraDeskDoca.STATUS_EM_ANALISE_TERCEIRO_NOME = 'Em Análise Terceiro';

  // Ordem visual dos chamados dentro das colunas Aberto, Em liberação e Em Análise Terceiro.
  // Só prioriza estas lojas no topo, nesta ordem. O restante mantém a ordem original da tela.
  // Não muda status, não salva nada no sistema; apenas reorganiza os cards carregados na tela.
  InfraDeskDoca.ORDEM_STATUS_IDS = ['2', '3', '6'];
  InfraDeskDoca.ORDEM_EMPRESAS_PRIORIDADE = [
    'Loja 03 - ASP Paraíso',
    'Loja 05 - ASP Vinhedo',
    'Loja 01 - ASP São Marcos'
  ];

  InfraDeskDoca.state = {
    started: false,
    observer: null,
    eventSource: null,
    debounceTimer: null,
    orderTimer: null,
    orderRunning: false,
    firebaseCache: {},
    savingIds: {},
    movingIds: {},
    clickingIds: {},
    user: {
      nome: '',
      id: ''
    }
  };

  InfraDeskDoca.clean = function (value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  };

  InfraDeskDoca.cleanFieldValue = function (value) {
    value = InfraDeskDoca.clean(value);

    if (!value) {
      return '';
    }

    value = value.replace(/^[;,\.\-\s]+|[;,\.\-\s]+$/g, '').trim();

    if (!value || value === ';' || value === '-' || value === '.') {
      return '';
    }

    return value;
  };

  InfraDeskDoca.norm = function (value) {
    return InfraDeskDoca.clean(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  };

  InfraDeskDoca.onlyDigits = function (value) {
    return String(value == null ? '' : value).replace(/\D+/g, '');
  };

  InfraDeskDoca.keyUser = function (value) {
    return InfraDeskDoca.norm(value)
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'sem_usuario';
  };

  InfraDeskDoca.getReservaUserKey = function (reserva) {
    if (!reserva || typeof reserva !== 'object') {
      return '';
    }

    var userKey = InfraDeskDoca.clean(reserva.usuarioNorm || '');

    if (userKey) {
      return userKey;
    }

    var nome = InfraDeskDoca.clean(reserva.usuario || reserva.operador || reserva.nome || '');

    return nome ? InfraDeskDoca.keyUser(nome) : '';
  };

  InfraDeskDoca.isSameReservationUser = function (reserva, usuarioAtual) {
    var reservedKey = InfraDeskDoca.getReservaUserKey(reserva);
    var currentKey = InfraDeskDoca.keyUser(usuarioAtual);

    return !!reservedKey && reservedKey === currentKey;
  };

  InfraDeskDoca.getReservaTimestamp = function (reserva) {
    if (!reserva || typeof reserva !== 'object') {
      return 0;
    }

    return Number(
      reserva.reservadoEm ||
      reserva.capturadoEm ||
      reserva.atualizadoEm ||
      reserva.ts ||
      0
    ) || 0;
  };

  InfraDeskDoca.getReservaAgeMs = function (reserva) {
    var ts = InfraDeskDoca.getReservaTimestamp(reserva);

    if (!ts) {
      return 0;
    }

    return Math.max(0, Date.now() - ts);
  };

  InfraDeskDoca.isReservaExpirada = function (reserva) {
    var ts = InfraDeskDoca.getReservaTimestamp(reserva);

    if (!ts) {
      return false;
    }

    return Date.now() - ts > InfraDeskDoca.RESERVA_VALIDADE_MS;
  };

  InfraDeskDoca.formatCnpj = function (cnpj) {
    cnpj = InfraDeskDoca.onlyDigits(cnpj);

    if (cnpj.length !== 14) {
      return cnpj;
    }

    return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  };

  InfraDeskDoca.firebaseUrl = function (path) {
    var base = InfraDeskDoca.FIREBASE_DB_URL.replace(/\/+$/, '');
    var cleanPath = String(path || '').replace(/^\/+/, '');
    return base + '/' + cleanPath + '.json';
  };

  InfraDeskDoca.isOkResponse = function (res) {
    return res && res.status >= 200 && res.status < 300;
  };

  InfraDeskDoca.parseJson = function (text, fallback) {
    try {
      return JSON.parse(text || '');
    } catch (_) {
      return fallback;
    }
  };

  InfraDeskDoca.deleteEmptyDeep = function (value) {
    if (Array.isArray(value)) {
      var arr = [];

      for (var i = 0; i < value.length; i++) {
        var cleanedItem = InfraDeskDoca.deleteEmptyDeep(value[i]);

        if (cleanedItem !== undefined) {
          arr.push(cleanedItem);
        }
      }

      return arr.length ? arr : undefined;
    }

    if (value && typeof value === 'object') {
      var obj = {};

      Object.keys(value).forEach(function (key) {
        var cleanedValue = InfraDeskDoca.deleteEmptyDeep(value[key]);

        if (cleanedValue !== undefined) {
          obj[key] = cleanedValue;
        }
      });

      return Object.keys(obj).length ? obj : undefined;
    }

    if (typeof value === 'string') {
      var cleanedString = InfraDeskDoca.cleanFieldValue(value);

      if (!cleanedString) {
        return undefined;
      }

      return cleanedString;
    }

    if (value === null || value === undefined) {
      return undefined;
    }

    return value;
  };

  InfraDeskDoca.requestFirebase = function (opts) {
    opts = opts || {};

    return new Promise(function (resolve, reject) {
      var req = {
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data == null ? null : opts.data,
        timeout: opts.timeout || 30000,
        onload: function (res) {
          resolve(res);
        },
        onerror: function (err) {
          reject(err || new Error('GM_xmlhttpRequest onerror'));
        },
        ontimeout: function () {
          reject(new Error('timeout'));
        }
      };

      try {
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest(req);
          return;
        }

        if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
          var result = GM.xmlHttpRequest(req);

          if (result && typeof result.then === 'function') {
            result.then(resolve).catch(reject);
          }

          return;
        }

        fetch(opts.url, {
          method: opts.method || 'GET',
          headers: opts.headers || {},
          body: opts.data == null ? undefined : opts.data,
          cache: 'no-store',
          credentials: 'omit'
        }).then(function (res) {
          return res.text().then(function (text) {
            resolve({
              status: res.status,
              responseText: text,
              finalUrl: res.url
            });
          });
        }).catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  };

  InfraDeskDoca.sameOriginPost = function (url, data) {
    data = data || {};

    return new Promise(function (resolve, reject) {
      var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      var jq = root.jQuery || root.$ || window.jQuery || window.$;

      if (jq && typeof jq.ajax === 'function') {
        jq.ajax({
          url: url,
          type: 'POST',
          data: data,
          dataType: 'json',
          success: function (response, textStatus, xhr) {
            resolve({
              ok: true,
              status: xhr ? xhr.status : 200,
              json: response,
              text: JSON.stringify(response || {})
            });
          },
          error: function (xhr) {
            resolve({
              ok: false,
              status: xhr ? xhr.status : 0,
              json: null,
              text: xhr ? xhr.responseText || '' : ''
            });
          }
        });

        return;
      }

      var body = Object.keys(data).map(function (key) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(data[key]);
      }).join('&');

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: body,
        credentials: 'include',
        cache: 'no-store'
      }).then(function (res) {
        return res.text().then(function (text) {
          resolve({
            ok: res.ok,
            status: res.status,
            json: InfraDeskDoca.parseJson(text, null),
            text: text
          });
        });
      }).catch(reject);
    });
  };

  InfraDeskDoca.notify = function (type, message) {
    var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    var toastr = root.toastr || window.toastr;

    if (toastr && typeof toastr[type] === 'function') {
      toastr[type](message);
      return;
    }

    if (type === 'error' || type === 'warning') {
      window.alert(message);
    }
  };

  InfraDeskDoca.getTextWithoutChildren = function (el) {
    if (!el) {
      return '';
    }

    var text = '';

    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];

      if (node.nodeType === 3) {
        text += node.nodeValue || '';
      }
    }

    return InfraDeskDoca.clean(text || el.textContent || '');
  };

  InfraDeskDoca.detectLoggedUserName = function () {
    var selectors = [
      '.profile-element strong.font-bold',
      '.profile-element .font-bold',
      '.logo-element .dropdown-menu big',
      '.nav-header .font-bold',
      '.nav-header big'
    ];

    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);

      if (el) {
        var txt = InfraDeskDoca.getTextWithoutChildren(el);
        txt = txt.replace(/\s*\bSair\b\s*$/i, '');
        txt = txt.replace(/\s*\bMeus dados\b\s*$/i, '');
        txt = InfraDeskDoca.clean(txt);

        if (txt && !/central|libera/i.test(txt) && txt.length >= 3) {
          return txt;
        }
      }
    }

    var strong = document.querySelector('.nav-header strong');

    if (strong) {
      return InfraDeskDoca.clean(strong.textContent || '');
    }

    return '';
  };

  InfraDeskDoca.detectLoggedUserId = function () {
    var html = document.documentElement ? document.documentElement.innerHTML : '';

    var patterns = [
      /avatar_usuario_(\d+)/i,
      /atendente_id=(\d+)/i,
      /\/avatar\/(\d+)\//i
    ];

    for (var i = 0; i < patterns.length; i++) {
      var match = html.match(patterns[i]);

      if (match && match[1]) {
        return InfraDeskDoca.clean(match[1]);
      }
    }

    return '';
  };

  InfraDeskDoca.refreshLoggedUser = function () {
    var nome = InfraDeskDoca.detectLoggedUserName();
    var id = InfraDeskDoca.detectLoggedUserId();

    if (nome) {
      InfraDeskDoca.state.user.nome = nome;
    }

    if (id) {
      InfraDeskDoca.state.user.id = id;
    }

    return InfraDeskDoca.state.user;
  };

  InfraDeskDoca.textOf = function (root, selector) {
    var el = root && root.querySelector ? root.querySelector(selector) : null;
    return el ? InfraDeskDoca.clean(el.innerText || el.textContent || '') : '';
  };

  InfraDeskDoca.attrOf = function (root, selector, attr) {
    var el = root && root.querySelector ? root.querySelector(selector) : null;
    return el ? InfraDeskDoca.clean(el.getAttribute(attr) || '') : '';
  };

  InfraDeskDoca.parseBrazilDateTime = function (value) {
    value = InfraDeskDoca.clean(value);

    var match = value.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);

    if (!match) {
      return '';
    }

    return match[3] + '-' + match[2] + '-' + match[1] + 'T' + match[4] + ':' + match[5] + ':' + (match[6] || '00');
  };

  InfraDeskDoca.parseLoja = function (value) {
    value = InfraDeskDoca.clean(value);

    var out = {
      lojaTexto: value,
      lojaCodigo: '',
      lojaNome: ''
    };

    var match = value.match(/Loja\s+(\d+)\s*-\s*(.+)$/i);

    if (match) {
      out.lojaCodigo = match[1];
      out.lojaNome = InfraDeskDoca.clean(match[2]);
    }

    return out;
  };

  InfraDeskDoca.parseFornecedor = function (value, href) {
    value = InfraDeskDoca.clean(value).replace(/^#+/, '#');
    href = InfraDeskDoca.clean(href);

    var out = {
      fornecedorTexto: value,
      fornecedorId: '',
      fornecedorNome: ''
    };

    var hrefMatch = href.match(/\/fornecedores\/contato\/(\d+)/i);

    if (hrefMatch && hrefMatch[1]) {
      out.fornecedorId = hrefMatch[1];
    }

    var textMatch = value.match(/#?(\d+)\s+(.+)$/);

    if (textMatch) {
      if (!out.fornecedorId) {
        out.fornecedorId = textMatch[1];
      }

      out.fornecedorNome = InfraDeskDoca.clean(textMatch[2]);
    } else {
      out.fornecedorNome = value.replace(/^#\d+\s*/, '');
    }

    return out;
  };

  InfraDeskDoca.parseAccessKey = function (chave) {
    chave = InfraDeskDoca.onlyDigits(chave);

    if (chave.length !== 44) {
      return {};
    }

    var ano2 = chave.slice(2, 4);
    var mes = chave.slice(4, 6);
    var cnpj = chave.slice(6, 20);
    var numero = chave.slice(25, 34);

    return {
      chaveAcesso: chave,
      chaveValidaTamanho: true,
      ufCodigo: chave.slice(0, 2),
      anoMes: chave.slice(2, 6),
      ano: '20' + ano2,
      mes: mes,
      cnpjEmitente: cnpj,
      cnpjEmitenteFormatado: InfraDeskDoca.formatCnpj(cnpj),
      modelo: chave.slice(20, 22),
      serie: chave.slice(22, 25),
      numero: numero,
      numeroLimpo: String(Number(numero) || ''),
      tipoEmissao: chave.slice(34, 35),
      codigoNumerico: chave.slice(35, 43),
      dv: chave.slice(43, 44)
    };
  };

  InfraDeskDoca.tagKey = function (label) {
    return InfraDeskDoca.norm(label)
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  };

  InfraDeskDoca.getCardId = function (card) {
    if (!card) {
      return '';
    }

    var dataId = InfraDeskDoca.clean(card.getAttribute('data-chamado-id'));

    if (dataId) {
      return dataId;
    }

    var link = card.querySelector('a[href*="/backend/chamados/detalhes/"]');

    if (link) {
      var match = String(link.getAttribute('href') || '').match(/\/backend\/chamados\/detalhes\/(\d+)/i);

      if (match && match[1]) {
        return InfraDeskDoca.clean(match[1]);
      }
    }

    var text = InfraDeskDoca.clean(card.innerText || card.textContent || '');
    var textMatch = text.match(/\b\d{4,}\b/);

    return textMatch ? textMatch[0] : '';
  };

  InfraDeskDoca.getCards = function () {
    return Array.prototype.slice.call(document.querySelectorAll('.chamado-item[data-chamado-id], li.chamado-item'));
  };

  InfraDeskDoca.findCardById = function (id) {
    id = InfraDeskDoca.clean(id);

    if (!id) {
      return null;
    }

    return document.querySelector('.chamado-item[data-chamado-id="' + id + '"]');
  };

  InfraDeskDoca.getStatusUl = function (statusId) {
    return document.querySelector('ul.list-status-chamados[data-status-id="' + statusId + '"]');
  };

  InfraDeskDoca.getCardStatusId = function (card) {
    var ul = card && card.closest ? card.closest('ul.list-status-chamados[data-status-id]') : null;
    return ul ? InfraDeskDoca.clean(ul.getAttribute('data-status-id')) : '';
  };

  InfraDeskDoca.getCardStatusName = function (card) {
    var ul = card && card.closest ? card.closest('ul.list-status-chamados[data-status-descricao]') : null;
    return ul ? InfraDeskDoca.clean(ul.getAttribute('data-status-descricao')) : '';
  };

  InfraDeskDoca.getOrderPriorityNorms = function () {
    if (!InfraDeskDoca._orderPriorityNorms) {
      InfraDeskDoca._orderPriorityNorms = InfraDeskDoca.ORDEM_EMPRESAS_PRIORIDADE.map(function (empresa) {
        return InfraDeskDoca.norm(empresa);
      });
    }

    return InfraDeskDoca._orderPriorityNorms;
  };

  InfraDeskDoca.isOrderTargetList = function (ul) {
    if (!ul) {
      return false;
    }

    var statusId = InfraDeskDoca.clean(ul.getAttribute('data-status-id') || '');

    if (InfraDeskDoca.ORDEM_STATUS_IDS.indexOf(statusId) >= 0) {
      return true;
    }

    var desc = InfraDeskDoca.norm(ul.getAttribute('data-status-descricao') || '');
    var nomesAlvo = ['aberto', 'em liberacao', 'em analise terceiro', 'analise terceiro'];

    for (var i = 0; i < nomesAlvo.length; i++) {
      if (desc.indexOf(nomesAlvo[i]) >= 0) {
        return true;
      }
    }

    var wrap = ul.closest ? ul.closest('.wrap-status') : null;
    var h3 = wrap ? wrap.querySelector('h3[data-status-id], h3') : null;
    var title = InfraDeskDoca.norm(h3 ? h3.textContent || h3.innerText || '' : '');

    for (var j = 0; j < nomesAlvo.length; j++) {
      if (title.indexOf(nomesAlvo[j]) >= 0) {
        return true;
      }
    }

    return false;
  };

  InfraDeskDoca.getOrderTargetLists = function () {
    var lists = Array.prototype.slice.call(document.querySelectorAll('ul.list-status-chamados[data-status-id]'));

    return lists.filter(function (ul) {
      return InfraDeskDoca.isOrderTargetList(ul);
    });
  };

  InfraDeskDoca.getCardEmpresaTexto = function (card) {
    return InfraDeskDoca.textOf(card, '.item-data-empresa');
  };

  InfraDeskDoca.getCardEmpresaNorm = function (card) {
    return InfraDeskDoca.norm(InfraDeskDoca.getCardEmpresaTexto(card));
  };

  InfraDeskDoca.stripLojaPrefixNorm = function (value) {
    value = InfraDeskDoca.norm(value);
    return value.replace(/^loja\s+/i, '').trim();
  };

  InfraDeskDoca.getCardOrderPriority = function (card) {
    var empresa = InfraDeskDoca.getCardEmpresaNorm(card);
    var empresaSemLoja = InfraDeskDoca.stripLojaPrefixNorm(empresa);
    var prioridades = InfraDeskDoca.getOrderPriorityNorms();

    for (var i = 0; i < prioridades.length; i++) {
      var prioridade = prioridades[i];
      var prioridadeSemLoja = InfraDeskDoca.stripLojaPrefixNorm(prioridade);

      if (empresa.indexOf(prioridade) >= 0 || empresaSemLoja.indexOf(prioridadeSemLoja) >= 0) {
        return i;
      }
    }

    return 999;
  };

  InfraDeskDoca.getCardLojaNumero = function (card) {
    var empresa = InfraDeskDoca.getCardEmpresaNorm(card);
    var match = empresa.match(/(?:^|)loja\s+0?(\d{1,3})/i) || empresa.match(/^0?(\d{1,3})\s*-/i);

    return match && match[1] ? Number(match[1]) : 9999;
  };

  InfraDeskDoca.getCardAberturaMs = function (card) {
    var aberturaTexto = InfraDeskDoca.textOf(card, '.item-data-abertura');
    var match = aberturaTexto.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);

    if (!match) {
      return 0;
    }

    return new Date(
      Number(match[3]),
      Number(match[2]) - 1,
      Number(match[1]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0)
    ).getTime();
  };

  InfraDeskDoca.compareCardsByStorePriority = function (a, b) {
    var priorityA = InfraDeskDoca.getCardOrderPriority(a);
    var priorityB = InfraDeskDoca.getCardOrderPriority(b);

    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    var lojaA = InfraDeskDoca.getCardLojaNumero(a);
    var lojaB = InfraDeskDoca.getCardLojaNumero(b);

    if (lojaA !== lojaB) {
      return lojaA - lojaB;
    }

    var empresaA = InfraDeskDoca.getCardEmpresaNorm(a);
    var empresaB = InfraDeskDoca.getCardEmpresaNorm(b);

    if (empresaA !== empresaB) {
      return empresaA.localeCompare(empresaB, 'pt-BR', {
        numeric: true
      });
    }

    // Dentro da mesma loja, deixa os chamados mais novos primeiro.
    return InfraDeskDoca.getCardAberturaMs(b) - InfraDeskDoca.getCardAberturaMs(a);
  };

  InfraDeskDoca.orderListByStorePriority = function (ul) {
    if (!ul) {
      return false;
    }

    var cards = Array.prototype.slice.call(ul.children).filter(function (el) {
      return el && el.matches && el.matches('li.chamado-item, .chamado-item[data-chamado-id]');
    });

    if (cards.length <= 1) {
      return false;
    }

    var oldOrder = cards.map(function (card) {
      return InfraDeskDoca.getCardId(card);
    }).join('|');

    var sorted = cards.map(function (card, index) {
      return {
        card: card,
        index: index
      };
    }).sort(function (a, b) {
      var priorityA = InfraDeskDoca.getCardOrderPriority(a.card);
      var priorityB = InfraDeskDoca.getCardOrderPriority(b.card);

      // Só mexe nas lojas prioritárias: 03, 05 e 01.
      // Quem não é prioridade continua na mesma ordem em que o Infradesk carregou.
      if (priorityA === 999 && priorityB === 999) {
        return a.index - b.index;
      }

      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      // Dentro da mesma loja prioritária, deixa os chamados mais novos primeiro.
      var aberturaDiff = InfraDeskDoca.getCardAberturaMs(b.card) - InfraDeskDoca.getCardAberturaMs(a.card);

      if (aberturaDiff) {
        return aberturaDiff;
      }

      return a.index - b.index;
    }).map(function (item) {
      return item.card;
    });

    var newOrder = sorted.map(function (card) {
      return InfraDeskDoca.getCardId(card);
    }).join('|');

    if (oldOrder === newOrder) {
      return false;
    }

    var frag = document.createDocumentFragment();

    sorted.forEach(function (card) {
      frag.appendChild(card);
    });

    ul.appendChild(frag);

    try {
      var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      var jq = root.jQuery || root.$ || window.jQuery || window.$;

      if (jq && jq.fn && jq.fn.sortable) {
        jq(ul).sortable('refresh');
      }
    } catch (_) {}

    return true;
  };

  InfraDeskDoca.orderPriorityTabs = function () {
    if (InfraDeskDoca.state.orderRunning) {
      return;
    }

    InfraDeskDoca.state.orderRunning = true;

    try {
      var lists = InfraDeskDoca.getOrderTargetLists();
      var changed = false;

      lists.forEach(function (ul) {
        if (InfraDeskDoca.orderListByStorePriority(ul)) {
          changed = true;
        }
      });

      if (changed) {
        InfraDeskDoca.updateKanbanCounters();
      }
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao ordenar chamados por loja', err);
    } finally {
      setTimeout(function () {
        InfraDeskDoca.state.orderRunning = false;
      }, 100);
    }
  };

  InfraDeskDoca.scheduleOrderPriorityTabs = function (delay) {
    clearTimeout(InfraDeskDoca.state.orderTimer);

    InfraDeskDoca.state.orderTimer = setTimeout(function () {
      InfraDeskDoca.orderPriorityTabs();
    }, typeof delay === 'number' ? delay : 250);
  };

  InfraDeskDoca.extractTagsFromCard = function (card) {
    var tags = {};
    var tagsLista = [];

    if (!card) {
      return {
        tags: tags,
        tagsLista: tagsLista
      };
    }

    var items = Array.prototype.slice.call(card.querySelectorAll('.chamado-tag-item'));

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var labelEl = item.querySelector('b');
      var valueEl = item.querySelector('span');

      var label = InfraDeskDoca.clean(labelEl ? labelEl.textContent || labelEl.innerText || '' : '');
      var value = InfraDeskDoca.cleanFieldValue(valueEl ? valueEl.textContent || valueEl.innerText || '' : '');

      label = label
        .replace(/^['"`]+/, '')
        .replace(/[:：]\s*$/, '')
        .trim();

      if (!label) {
        continue;
      }

      var key = InfraDeskDoca.tagKey(label);

      if (!key) {
        continue;
      }

      if (value) {
        tags[key] = value;

        tagsLista.push({
          label: label,
          key: key,
          valor: value
        });
      }
    }

    return {
      tags: tags,
      tagsLista: tagsLista
    };
  };

  InfraDeskDoca.extractNfFromCard = function (card, tagsInfo) {
    tagsInfo = tagsInfo || InfraDeskDoca.extractTagsFromCard(card);

    var textoCard = InfraDeskDoca.clean(card ? card.innerText || card.textContent || '' : '');
    var chave = '';

    var chaveTag = tagsInfo.tags.chave_da_nf || tagsInfo.tags.chave_nf || tagsInfo.tags.chave_nfe || '';

    if (chaveTag) {
      var chaveMatchTag = chaveTag.match(/\b(\d{44})\b/);

      if (chaveMatchTag) {
        chave = chaveMatchTag[1];
      }
    }

    if (!chave) {
      var chaveMatchCard = textoCard.match(/\b(\d{44})\b/);

      if (chaveMatchCard) {
        chave = chaveMatchCard[1];
      }
    }

    var numeroRaw = '';

    if (chaveTag) {
      var numeroAntesChave = chaveTag.match(/^\s*([\d.\-\/]+)\s*\(/);

      if (numeroAntesChave) {
        numeroRaw = numeroAntesChave[1];
      }
    }

    if (!numeroRaw) {
      var ultimaDescricaoEl = card ? card.querySelector('.item-ultima-descricao-copy') : null;
      var ultimaDescricao = ultimaDescricaoEl ? InfraDeskDoca.cleanFieldValue(ultimaDescricaoEl.textContent || ultimaDescricaoEl.innerText || '') : '';
      var nfMatch = ultimaDescricao.match(/\bNF\s+([\d.\-\/]+)/i);

      if (nfMatch) {
        numeroRaw = nfMatch[1];
      }
    }

    if (!numeroRaw) {
      var mensagem = InfraDeskDoca.textOf(card, '.message-collapsed');
      var msgMatch = mensagem.match(/\bNF\s+([\d.\-\/]+)/i);

      if (msgMatch) {
        numeroRaw = msgMatch[1];
      }
    }

    var parsed = InfraDeskDoca.parseAccessKey(chave);
    var numeroLimpo = InfraDeskDoca.onlyDigits(numeroRaw);

    if (!numeroLimpo && parsed.numeroLimpo) {
      numeroLimpo = parsed.numeroLimpo;
    }

    var out = {
      nfNumeroTexto: numeroRaw || parsed.numero || '',
      nfNumero: numeroLimpo,
      chaveAcesso: parsed.chaveAcesso || ''
    };

    if (parsed && Object.keys(parsed).length) {
      out.nfe = parsed;
      out.cnpjEmitente = parsed.cnpjEmitente || '';
      out.cnpjEmitenteFormatado = parsed.cnpjEmitenteFormatado || '';
      out.modeloNf = parsed.modelo || '';
      out.serieNf = parsed.serie || '';
      out.numeroNfChave = parsed.numero || '';
      out.numeroNfChaveLimpo = parsed.numeroLimpo || '';
      out.ufCodigoNf = parsed.ufCodigo || '';
      out.anoNf = parsed.ano || '';
      out.mesNf = parsed.mes || '';
    }

    return out;
  };

  InfraDeskDoca.extractSolicitanteFromCard = function (card) {
    var title = InfraDeskDoca.clean(card ? card.getAttribute('title') || '' : '');
    var tooltip = InfraDeskDoca.attrOf(card, '.avatar-user-card .img-circle', 'data-original-title');

    var out = {
      solicitanteTexto: title,
      solicitanteNome: '',
      solicitanteLojaTexto: '',
      solicitanteEmail: '',
      solicitanteAvatarId: ''
    };

    var emailMatch = (title + ' ' + tooltip).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

    if (emailMatch) {
      out.solicitanteEmail = emailMatch[0];
    }

    var avatarMatch = String(card ? card.innerHTML || '' : '').match(/avatar_usuario_(\d+)/i);

    if (avatarMatch && avatarMatch[1]) {
      out.solicitanteAvatarId = avatarMatch[1];
    }

    var nomeMatch = tooltip.match(/<h6>(.*?)<\/h6>/i);

    if (nomeMatch && nomeMatch[1]) {
      out.solicitanteNome = InfraDeskDoca.clean(nomeMatch[1].replace(/<[^>]+>/g, ''));
    }

    var lojaTooltipMatch = tooltip.match(/<p>(.*?)<\/p>/i);

    if (lojaTooltipMatch && lojaTooltipMatch[1]) {
      out.solicitanteLojaTexto = InfraDeskDoca.clean(lojaTooltipMatch[1].replace(/<[^>]+>/g, ''));
    }

    return out;
  };

  InfraDeskDoca.extractCardInfo = function (card) {
    if (!card) {
      return {};
    }

    var chamadoId = InfraDeskDoca.getCardId(card);
    var tagsInfo = InfraDeskDoca.extractTagsFromCard(card);
    var nfInfo = InfraDeskDoca.extractNfFromCard(card, tagsInfo);

    var aberturaTexto = InfraDeskDoca.textOf(card, '.item-data-abertura');
    var lojaTexto = InfraDeskDoca.textOf(card, '.item-data-empresa');

    var fornecedorTexto = InfraDeskDoca.textOf(card, '.item-data-fornecedor');
    var fornecedorHref = InfraDeskDoca.attrOf(card, '.item-data-fornecedor', 'href');

    var categoria = InfraDeskDoca.textOf(card, 'a[href*="/backend/chamados/detalhes/"] .item-categoria');
    var subcategoria = InfraDeskDoca.textOf(card, '.item-subcategoria');

    var descricaoResumo = '';
    var ultimaDescricaoEl = card.querySelector('.item-ultima-descricao-copy');

    if (ultimaDescricaoEl) {
      descricaoResumo = InfraDeskDoca.cleanFieldValue(ultimaDescricaoEl.textContent || ultimaDescricaoEl.innerText || '');
    }

    if (!descricaoResumo) {
      descricaoResumo = InfraDeskDoca.cleanFieldValue(InfraDeskDoca.textOf(card, '.message-collapsed'));
    }

    var loja = InfraDeskDoca.parseLoja(lojaTexto);
    var fornecedor = InfraDeskDoca.parseFornecedor(fornecedorTexto, fornecedorHref);
    var solicitante = InfraDeskDoca.extractSolicitanteFromCard(card);

    var info = {};

    Object.assign(info, loja);
    Object.assign(info, fornecedor);
    Object.assign(info, solicitante);
    Object.assign(info, nfInfo);

    info.chamadoId = chamadoId;

    info.categoriaId = InfraDeskDoca.clean(card.getAttribute('data-categoria-id') || '');
    info.categoria = categoria;
    info.subcategoria = subcategoria;

    info.statusAntesId = InfraDeskDoca.getCardStatusId(card);
    info.statusAntesNome = InfraDeskDoca.getCardStatusName(card);

    info.origemAtendimento = InfraDeskDoca.clean(card.getAttribute('data-origem-atendimento') || '');
    info.transferenciaGrupoId = InfraDeskDoca.clean(card.getAttribute('data-transferencia-grupo-id') || '');
    info.fornecedorTags = InfraDeskDoca.clean(card.getAttribute('data-fornecedor-tags') || '');

    info.aberturaTexto = aberturaTexto;
    info.aberturaISO = InfraDeskDoca.parseBrazilDateTime(aberturaTexto);

    info.descricaoResumo = descricaoResumo;

    info.motorista = InfraDeskDoca.cleanFieldValue(tagsInfo.tags.motorista || '');
    info.documentoMotorista = InfraDeskDoca.cleanFieldValue(tagsInfo.tags.documento_rg_ou_cpf || tagsInfo.tags.documento || tagsInfo.tags.cpf || '');
    info.placa = InfraDeskDoca.cleanFieldValue(tagsInfo.tags.placa || '');
    info.temperatura = InfraDeskDoca.cleanFieldValue(tagsInfo.tags.temperatura || '');

    info.tags = tagsInfo.tags;
    info.tagsLista = tagsInfo.tagsLista;

    var cleaned = InfraDeskDoca.deleteEmptyDeep(info);
    return cleaned || {};
  };

  InfraDeskDoca.injectStyle = function () {
    if (document.getElementById('tm-infradesk-doca-style')) {
      return;
    }

    var style = document.createElement('style');
    style.id = 'tm-infradesk-doca-style';
    style.textContent = [
      '.tm-doca-user-badge {',
      '  display: inline-flex !important;',
      '  align-items: center !important;',
      '  gap: 3px !important;',
      '  margin-left: 5px !important;',
      '  padding: 1px 6px !important;',
      '  border-radius: 999px !important;',
      '  background: #eef6ff !important;',
      '  border: 1px solid #b6dcff !important;',
      '  color: #1a82cd !important;',
      '  font-size: 10px !important;',
      '  font-weight: 800 !important;',
      '  line-height: 16px !important;',
      '  vertical-align: middle !important;',
      '  max-width: 112px !important;',
      '  overflow: hidden !important;',
      '  white-space: nowrap !important;',
      '  text-overflow: ellipsis !important;',
      '}',
      '.tm-doca-user-badge i {',
      '  font-size: 9px !important;',
      '}',
      '.tm-doca-moving {',
      '  opacity: .72 !important;',
      '  transform: scale(.995) !important;',
      '}',
      '.tm-doca-capturado {',
      '  box-shadow: 1px 1px 6px #00000029, inset 4px 0 0 #1ab394 !important;',
      '}',
      '.tm-doca-hidden-reserved {',
      '  display: none !important;',
      '}'
    ].join('\n');

    document.head.appendChild(style);
  };

  InfraDeskDoca.shortName = function (name) {
    name = InfraDeskDoca.clean(name);

    if (!name) {
      return '';
    }

    var parts = name.split(' ').filter(Boolean);

    if (parts.length >= 2) {
      return parts[0] + ' ' + parts[1];
    }

    return name;
  };

  InfraDeskDoca.ensureBadgeOnCard = function (card, usuario) {
    if (!card || !usuario) {
      return;
    }

    var id = InfraDeskDoca.getCardId(card);

    if (!id) {
      return;
    }

    var headerLink = card.querySelector('a[href*="/backend/chamados/detalhes/"]');
    var numberEl = headerLink ? headerLink.querySelector('b') : null;

    if (!numberEl) {
      return;
    }

    var badge = card.querySelector('.tm-doca-user-badge');

    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tm-doca-user-badge';
      numberEl.insertAdjacentElement('afterend', badge);
    }

    badge.innerHTML = '<i class="fa fa-user-check"></i> ' + InfraDeskDoca.shortName(usuario);
    badge.title = 'Capturado por ' + usuario;

    card.classList.add('tm-doca-capturado');
    card.dataset.tmDocaUsuario = usuario;
  };

  InfraDeskDoca.removeCaptureButton = function (card) {
    if (!card) {
      return;
    }

    var buttons = Array.prototype.slice.call(card.querySelectorAll('.capturar-btn, a[onclick*="capturarChamadoNew"], a[data-tm-doca-native-onclick*="capturarChamadoNew"]'));

    buttons.forEach(function (btn) {
      btn.remove();
    });
  };

  InfraDeskDoca.hideReservedOpenCard = function (card, item) {
    if (!card || !item) {
      return;
    }

    var statusId = InfraDeskDoca.getCardStatusId(card);
    var usuario = InfraDeskDoca.clean(item.usuario || item.operador || item.nome || 'outro usuário');

    InfraDeskDoca.ensureBadgeOnCard(card, usuario);
    InfraDeskDoca.removeCaptureButton(card);

    if (statusId === InfraDeskDoca.STATUS_ABERTO) {
      card.classList.add('tm-doca-hidden-reserved');
      card.dataset.tmDocaHiddenReason = 'reserved';
      InfraDeskDoca.updateKanbanCounters();
      InfraDeskDoca.scheduleOrderPriorityTabs(300);
    }
  };

  InfraDeskDoca.isDifferentReservation = function (reserva, usuarioAtual) {
    if (!reserva) {
      return false;
    }

    var currentKey = InfraDeskDoca.keyUser(usuarioAtual);
    var reservedKey = InfraDeskDoca.getReservaUserKey(reserva);

    return !!reservedKey && reservedKey !== currentKey;
  };

  InfraDeskDoca.applyFirebaseItem = function (id, item) {
    id = InfraDeskDoca.clean(id);

    if (!id || !item) {
      return;
    }

    InfraDeskDoca.state.firebaseCache[id] = item;

    var usuario = InfraDeskDoca.clean(item.usuario || item.operador || item.nome || '');
    var card = InfraDeskDoca.findCardById(id);

    if (!card) {
      return;
    }

    if (usuario) {
      InfraDeskDoca.ensureBadgeOnCard(card, usuario);
    }

    if (InfraDeskDoca.getCardStatusId(card) === InfraDeskDoca.STATUS_ABERTO) {
      InfraDeskDoca.hideReservedOpenCard(card, item);
    }
  };

  InfraDeskDoca.injectAllCards = function () {
    InfraDeskDoca.prepareCaptureButtons();

    var cards = InfraDeskDoca.getCards();

    for (var i = 0; i < cards.length; i++) {
      var id = InfraDeskDoca.getCardId(cards[i]);

      if (!id) {
        continue;
      }

      var item = InfraDeskDoca.state.firebaseCache[id];

      if (item) {
        InfraDeskDoca.applyFirebaseItem(id, item);
      }
    }

    InfraDeskDoca.scheduleOrderPriorityTabs(250);
  };

  InfraDeskDoca.loadFirebaseState = async function () {
    try {
      var res = await InfraDeskDoca.requestFirebase({
        method: 'GET',
        url: InfraDeskDoca.firebaseUrl(InfraDeskDoca.FIREBASE_ROOT + '/' + InfraDeskDoca.FIREBASE_ACTIVE_ROOT) + '?_=' + Date.now()
      });

      if (!InfraDeskDoca.isOkResponse(res)) {
        return;
      }

      var data = InfraDeskDoca.parseJson(res.responseText || '{}', {}) || {};
      InfraDeskDoca.state.firebaseCache = data;

      Object.keys(data).forEach(function (id) {
        InfraDeskDoca.applyFirebaseItem(id, data[id]);
      });

      InfraDeskDoca.injectAllCards();
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao carregar Firebase', err);
    }
  };

  InfraDeskDoca.handleFirebaseEvent = function (raw) {
    var payload;

    try {
      payload = JSON.parse(raw || '{}');
    } catch (_) {
      return;
    }

    var path = String(payload.path || '/');
    var data = payload.data;

    if (path === '/' || path === '') {
      InfraDeskDoca.state.firebaseCache = data || {};
      Object.keys(InfraDeskDoca.state.firebaseCache).forEach(function (id) {
        InfraDeskDoca.applyFirebaseItem(id, InfraDeskDoca.state.firebaseCache[id]);
      });
      InfraDeskDoca.scheduleOrderPriorityTabs(300);
      return;
    }

    var cleanPath = path.replace(/^\/+/, '');
    var parts = cleanPath.split('/').filter(Boolean);
    var id = InfraDeskDoca.clean(parts[0]);

    if (!id) {
      return;
    }

    if (data === null) {
      delete InfraDeskDoca.state.firebaseCache[id];
      return;
    }

    if (parts.length === 1) {
      InfraDeskDoca.state.firebaseCache[id] = data;
      InfraDeskDoca.applyFirebaseItem(id, data);
      InfraDeskDoca.scheduleOrderPriorityTabs(300);
      return;
    }

    var current = InfraDeskDoca.state.firebaseCache[id] || {};
    current[parts[1]] = data;
    InfraDeskDoca.state.firebaseCache[id] = current;
    InfraDeskDoca.applyFirebaseItem(id, current);
    InfraDeskDoca.scheduleOrderPriorityTabs(300);
  };

  InfraDeskDoca.connectRealtime = function () {
    if (InfraDeskDoca.state.eventSource) {
      InfraDeskDoca.state.eventSource.close();
    }

    try {
      var es = new EventSource(InfraDeskDoca.firebaseUrl(InfraDeskDoca.FIREBASE_ROOT + '/' + InfraDeskDoca.FIREBASE_ACTIVE_ROOT));

      es.addEventListener('put', function (event) {
        InfraDeskDoca.handleFirebaseEvent(event.data);
      });

      es.addEventListener('patch', function (event) {
        InfraDeskDoca.handleFirebaseEvent(event.data);
      });

      es.onerror = function () {
        console.warn('[InfraDeskDoca] realtime Firebase reconectando...');
      };

      InfraDeskDoca.state.eventSource = es;
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao iniciar realtime', err);
    }
  };

  InfraDeskDoca.getRemoteCapture = async function (id) {
    id = InfraDeskDoca.clean(id);

    if (!id) {
      return null;
    }

    try {
      var res = await InfraDeskDoca.requestFirebase({
        method: 'GET',
        url: InfraDeskDoca.firebaseUrl(InfraDeskDoca.FIREBASE_ROOT + '/by_id/' + id) + '?_=' + Date.now()
      });

      if (!InfraDeskDoca.isOkResponse(res)) {
        return null;
      }

      return InfraDeskDoca.parseJson(res.responseText || 'null', null);
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao consultar reserva antes do clique', err);
      return null;
    }
  };

  InfraDeskDoca.buildMinimalReservation = function (id, usuario) {
    var ts = Date.now();
    var usuarioLimpo = InfraDeskDoca.clean(usuario);

    return {
      chamadoId: InfraDeskDoca.clean(id),
      operador: usuarioLimpo,
      usuario: usuarioLimpo,
      usuarioNorm: InfraDeskDoca.keyUser(usuarioLimpo),
      ts: ts,
      reservadoEm: ts,
      expiraEm: ts + InfraDeskDoca.RESERVA_VALIDADE_MS,
      origem: 'tampermonkey-infradesk-doca-lock'
    };
  };

  // Modo ultra leve e compatível:
  // - Não baixa o banco inteiro.
  // - Não abre realtime/EventSource.
  // - No clique, consulta somente /by_id/{chamadoId}.
  // - Se estiver vazio, grava somente /by_id/{chamadoId} com payload mínimo.
  // - Se já existir reserva de outro usuário com menos de 1 hora, bloqueia como antes.
  // - Se já existir reserva do mesmo usuário, permite recapturar para tratar nota reaberta.
  // - Se já existir reserva de outro usuário com mais de 1 hora, considera trava velha e sobrescreve.
  // Observação: este modo evita o problema de compatibilidade do If-Match/null_etag em alguns Tampermonkey/navegadores.
  InfraDeskDoca.tryReserveOnFirebase = async function (id, usuario) {
    id = InfraDeskDoca.clean(id);
    usuario = InfraDeskDoca.clean(usuario);

    if (!id || !usuario) {
      return {
        ok: false,
        exists: false,
        reserva: null
      };
    }

    var path = InfraDeskDoca.FIREBASE_ROOT + '/by_id/' + encodeURIComponent(id);
    var payload = InfraDeskDoca.buildMinimalReservation(id, usuario);

    try {
      // 1) Consulta apenas o chamado clicado. Não baixa o banco completo.
      var readRes = await InfraDeskDoca.requestFirebase({
        method: 'GET',
        url: InfraDeskDoca.firebaseUrl(path) + '?_=' + Date.now(),
        timeout: 12000
      });

      if (!InfraDeskDoca.isOkResponse(readRes)) {
        throw new Error('Firebase GET status ' + (readRes ? readRes.status : 0) + ' - ' + (readRes && readRes.responseText || ''));
      }

      var existing = InfraDeskDoca.parseJson(readRes.responseText || 'null', null);

      if (existing && typeof existing === 'object') {
        var sameUser = InfraDeskDoca.isSameReservationUser(existing, usuario);
        var expired = InfraDeskDoca.isReservaExpirada(existing);

        if (!sameUser && !expired) {
          return {
            ok: false,
            exists: true,
            reserva: existing
          };
        }

        if (sameUser) {
          console.info('[InfraDeskDoca] reserva anterior do mesmo usuário encontrada; permitindo recaptura do chamado reaberto:', id);
        } else if (expired) {
          console.info('[InfraDeskDoca] reserva antiga com mais de ' + InfraDeskDoca.RESERVA_VALIDADE_LABEL + ' encontrada; permitindo nova captura:', id, existing);
        }
      }

      // 2) Se não existe, se é do mesmo usuário ou se está velha, grava somente o chamado clicado.
      // print=silent evita resposta grande.
      var reservationPatch = {};
      reservationPatch['by_id/' + id] = payload;
      reservationPatch[InfraDeskDoca.FIREBASE_ACTIVE_ROOT + '/' + id] = payload;

      var writeRes = await InfraDeskDoca.requestFirebase({
        method: 'PATCH',
        url: InfraDeskDoca.firebaseUrl(InfraDeskDoca.FIREBASE_ROOT) + '?print=silent&_=' + Date.now(),
        headers: {
          'Content-Type': 'application/json'
        },
        data: JSON.stringify(reservationPatch),
        timeout: 12000
      });

      if (!InfraDeskDoca.isOkResponse(writeRes)) {
        throw new Error('Firebase PATCH status ' + (writeRes ? writeRes.status : 0) + ' - ' + (writeRes && writeRes.responseText || ''));
      }

      InfraDeskDoca.state.firebaseCache[id] = payload;

      return {
        ok: true,
        exists: false,
        reserva: payload
      };
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao consultar/criar reserva no Firebase', err);

      return {
        ok: false,
        exists: false,
        reserva: null,
        error: err
      };
    }
  };

  InfraDeskDoca.releaseFirebaseReservation = async function (id) {
    id = InfraDeskDoca.clean(id);

    if (!id) {
      return false;
    }

    try {
      var releasePatch = {};
      releasePatch['by_id/' + id] = null;
      releasePatch[InfraDeskDoca.FIREBASE_ACTIVE_ROOT + '/' + id] = null;
      var res = await InfraDeskDoca.requestFirebase({
        method: 'PATCH',
        url: InfraDeskDoca.firebaseUrl(InfraDeskDoca.FIREBASE_ROOT) + '?print=silent&_=' + Date.now(),
        headers: {
          'Content-Type': 'application/json'
        },
        data: JSON.stringify(releasePatch)
      });

      if (InfraDeskDoca.isOkResponse(res)) {
        delete InfraDeskDoca.state.firebaseCache[id];
        return true;
      }
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao liberar reserva no Firebase', err);
    }

    return false;
  };

  InfraDeskDoca.saveCaptureToFirebase = async function (id, usuario, cardInfo) {
    id = InfraDeskDoca.clean(id);
    usuario = InfraDeskDoca.clean(usuario);
    cardInfo = cardInfo || {};

    if (!id || !usuario) {
      return false;
    }

    if (InfraDeskDoca.state.savingIds[id]) {
      return true;
    }

    InfraDeskDoca.state.savingIds[id] = true;

    var userKey = InfraDeskDoca.keyUser(usuario);
    var ts = Date.now();
    var expiraEm = ts + InfraDeskDoca.RESERVA_VALIDADE_MS;

    var payload = {
      chamadoId: id,
      usuario: usuario,
      usuarioNorm: userKey,
      usuarioId: InfraDeskDoca.clean(InfraDeskDoca.state.user.id),
      statusId: InfraDeskDoca.STATUS_EM_LIBERACAO,
      statusNome: InfraDeskDoca.STATUS_EM_LIBERACAO_NOME,
      capturadoEm: ts,
      atualizadoEm: ts,
      reservadoEm: ts,
      expiraEm: expiraEm,
      origem: 'tampermonkey-infradesk-doca'
    };

    Object.keys(cardInfo).forEach(function (key) {
      payload[key] = cardInfo[key];
    });

    payload.chamadoId = id;
    payload.usuario = usuario;
    payload.usuarioNorm = userKey;
    payload.usuarioId = InfraDeskDoca.clean(InfraDeskDoca.state.user.id);
    payload.statusId = InfraDeskDoca.STATUS_EM_LIBERACAO;
    payload.statusNome = InfraDeskDoca.STATUS_EM_LIBERACAO_NOME;
    payload.atualizadoEm = ts;

    payload = InfraDeskDoca.deleteEmptyDeep(payload) || {};

    var patch = {};
    patch['by_id/' + id] = payload;
    patch['by_usuario/' + userKey + '/' + id] = true;
    patch[InfraDeskDoca.FIREBASE_ACTIVE_ROOT + '/' + id] = {
      chamadoId: id,
      operador: usuario,
      usuario: usuario,
      usuarioNorm: userKey,
      usuarioId: InfraDeskDoca.clean(InfraDeskDoca.state.user.id),
      statusId: InfraDeskDoca.STATUS_EM_LIBERACAO,
      reservadoEm: ts,
      atualizadoEm: ts,
      expiraEm: expiraEm,
      origem: 'tampermonkey-doca-reserva-ativa'
    };

    try {
      var res = await InfraDeskDoca.requestFirebase({
        method: 'PATCH',
        url: InfraDeskDoca.firebaseUrl(InfraDeskDoca.FIREBASE_ROOT) + '?print=silent&_=' + Date.now(),
        headers: {
          'Content-Type': 'application/json'
        },
        data: JSON.stringify(patch)
      });

      if (!InfraDeskDoca.isOkResponse(res)) {
        throw new Error('Firebase status ' + res.status + ' - ' + (res.responseText || ''));
      }

      InfraDeskDoca.state.firebaseCache[id] = payload;

      var card = InfraDeskDoca.findCardById(id);

      if (card) {
        InfraDeskDoca.ensureBadgeOnCard(card, usuario);
      }

      return true;
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao salvar captura no Firebase', err);
      InfraDeskDoca.notify('warning', 'Capturei na tela, mas não consegui registrar no Firebase.');
      return false;
    } finally {
      delete InfraDeskDoca.state.savingIds[id];
    }
  };

  InfraDeskDoca.updateKanbanCounters = function () {
    var lists = Array.prototype.slice.call(document.querySelectorAll('ul.list-status-chamados[data-status-id]'));

    for (var i = 0; i < lists.length; i++) {
      var ul = lists[i];
      var statusId = ul.getAttribute('data-status-id');
      var cards = Array.prototype.slice.call(ul.querySelectorAll('.chamado-item[data-chamado-id], li.chamado-item'));
      var count = cards.filter(function (card) {
        return !card.classList.contains('tm-doca-hidden-reserved');
      }).length;
      var h3 = document.querySelector('h3[data-status-id="' + statusId + '"] span');

      if (h3) {
        h3.textContent = String(count);
      }
    }
  };

  InfraDeskDoca.moveCardToLiberacaoLocal = function (id, usuario) {
    var card = InfraDeskDoca.findCardById(id);
    var targetUl = InfraDeskDoca.getStatusUl(InfraDeskDoca.STATUS_EM_LIBERACAO);

    if (!card || !targetUl) {
      return false;
    }

    InfraDeskDoca.ensureBadgeOnCard(card, usuario);

    card.classList.remove('tm-doca-hidden-reserved');
    card.classList.add('tm-doca-moving');
    card.dataset.isCapturado = '1';

    InfraDeskDoca.removeCaptureButton(card);
    targetUl.prepend(card);

    setTimeout(function () {
      card.classList.remove('tm-doca-moving');
    }, 450);

    InfraDeskDoca.updateKanbanCounters();
    InfraDeskDoca.scheduleOrderPriorityTabs(250);

    return true;
  };

  InfraDeskDoca.refreshCardFromSystem = function (id, usuario, forceStatusId) {
    var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    if (root && typeof root.atualizarCard === 'function') {
      try {
        root.atualizarCard(id, {
          chamado: {
            id: id,
            status_chamado_id: forceStatusId || InfraDeskDoca.STATUS_EM_LIBERACAO
          }
        }, function () {
          var card = InfraDeskDoca.findCardById(id);

          if (card) {
            InfraDeskDoca.ensureBadgeOnCard(card, usuario);
          }

          InfraDeskDoca.updateKanbanCounters();
          InfraDeskDoca.scheduleOrderPriorityTabs(250);
        });

        return;
      } catch (err) {
        console.warn('[InfraDeskDoca] atualizarCard falhou, usando movimento local', err);
      }
    }

    InfraDeskDoca.moveCardToLiberacaoLocal(id, usuario);
  };

  InfraDeskDoca.persistStatusInInfradesk = async function (id) {
    id = InfraDeskDoca.clean(id);

    if (!id) {
      return false;
    }

    if (InfraDeskDoca.state.movingIds[id]) {
      return true;
    }

    InfraDeskDoca.state.movingIds[id] = true;

    var attempts = [
      {
        url: '/backend/chamados/editar/' + encodeURIComponent(id) + '.json',
        data: {
          status_chamado_id: InfraDeskDoca.STATUS_EM_LIBERACAO
        }
      },
      {
        url: '/backend/chamados/editar/' + encodeURIComponent(id) + '.json',
        data: {
          chamado_status_id: InfraDeskDoca.STATUS_EM_LIBERACAO
        }
      },
      {
        url: '/backend/chamados/editar/' + encodeURIComponent(id) + '.json',
        data: {
          status_id: InfraDeskDoca.STATUS_EM_LIBERACAO
        }
      },
      {
        url: '/backend/chamados/editar/' + encodeURIComponent(id) + '.json',
        data: {
          status_chamado_id: InfraDeskDoca.STATUS_EM_LIBERACAO,
          is_capturado: 1
        }
      }
    ];

    try {
      for (var i = 0; i < attempts.length; i++) {
        var attempt = attempts[i];

        var response = await InfraDeskDoca.sameOriginPost(attempt.url, attempt.data);

        if (response && response.ok) {
          var json = response.json || {};

          if (json && json.success === false) {
            continue;
          }

          return true;
        }
      }

      return false;
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao persistir status no Infradesk', err);
      return false;
    } finally {
      delete InfraDeskDoca.state.movingIds[id];
    }
  };

  InfraDeskDoca.getNativeOnclick = function (btn) {
    return InfraDeskDoca.clean(
      btn.getAttribute('data-tm-doca-native-onclick') ||
      btn.getAttribute('onclick') ||
      btn.getAttribute('_onclick') ||
      ''
    );
  };

  InfraDeskDoca.runNativeCapture = function (btn, id) {
    var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    var onclick = InfraDeskDoca.getNativeOnclick(btn);

    var match = onclick.match(/capturarChamadoNew\s*\(\s*(\d+)\s*,\s*([^,\)]+)/i);
    var grupoId = match && match[2] ? match[2].replace(/\D+/g, '') : '';

    if (root && typeof root.capturarChamadoNew === 'function') {
      root.capturarChamadoNew(Number(id), grupoId ? Number(grupoId) : undefined, btn, undefined);
      return true;
    }

    return false;
  };

  InfraDeskDoca.prepareCaptureButton = function (btn) {
    if (!btn || btn.dataset.tmDocaPrepared === '1') {
      return;
    }

    var nativeOnclick = InfraDeskDoca.getNativeOnclick(btn);

    if (nativeOnclick) {
      btn.setAttribute('data-tm-doca-native-onclick', nativeOnclick);
    }

    btn.removeAttribute('onclick');
    btn.onclick = null;
    btn.href = 'javascript:void(0);';
    btn.dataset.tmDocaPrepared = '1';

    btn.addEventListener('click', InfraDeskDoca.onSafeCaptureClick, true);
  };

  InfraDeskDoca.prepareCaptureButtons = function () {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('.capturar-btn, a[onclick*="capturarChamadoNew"], a[data-tm-doca-native-onclick*="capturarChamadoNew"]'));

    buttons.forEach(function (btn) {
      InfraDeskDoca.prepareCaptureButton(btn);
    });
  };

  InfraDeskDoca.abortAlreadyReserved = function (card, reserva, usuarioAtual) {
    var nomeReserva = InfraDeskDoca.clean(reserva && (reserva.usuario || reserva.operador || reserva.nome) || 'outro usuário');

    if (InfraDeskDoca.isDifferentReservation(reserva, usuarioAtual)) {
      var ageMs = InfraDeskDoca.getReservaAgeMs(reserva);
      var detalheTempo = ageMs ? ' Reserva com menos de ' + InfraDeskDoca.RESERVA_VALIDADE_LABEL + '.' : '';
      InfraDeskDoca.notify('warning', 'Este chamado já foi reservado por ' + nomeReserva + '.' + detalheTempo);
    } else {
      InfraDeskDoca.notify('info', 'Este chamado já está reservado por você.');
    }

    if (card) {
      if (InfraDeskDoca.isDifferentReservation(reserva, usuarioAtual)) {
        // No modo leve, a checagem acontece no clique. Se descobriu que outro usuário já reservou,
        // some com o card da coluna Aberto para ninguém tentar pegar o mesmo chamado de novo.
        InfraDeskDoca.hideReservedOpenCard(card, reserva || {});
      } else {
        InfraDeskDoca.ensureBadgeOnCard(card, nomeReserva);
        InfraDeskDoca.removeCaptureButton(card);
        InfraDeskDoca.updateKanbanCounters();
        InfraDeskDoca.scheduleOrderPriorityTabs(250);
      }
    }
  };

  InfraDeskDoca.captureAllowed = async function (btn) {
    var card = btn && btn.closest ? btn.closest('.chamado-item[data-chamado-id], li.chamado-item') : null;

    if (!card) {
      return;
    }

    var id = InfraDeskDoca.getCardId(card);

    if (!id) {
      return;
    }

    if (InfraDeskDoca.state.clickingIds[id]) {
      return;
    }

    InfraDeskDoca.state.clickingIds[id] = true;

    try {
      InfraDeskDoca.refreshLoggedUser();

      var usuario = InfraDeskDoca.clean(InfraDeskDoca.state.user.nome);

      if (!usuario) {
        InfraDeskDoca.notify('error', 'Não consegui identificar o usuário logado.');
        return;
      }

      // Modo leve: no clique, consulta/cria somente a reserva mínima desse chamado.
      // Não baixa o banco inteiro e não abre realtime.
      var lock = await InfraDeskDoca.tryReserveOnFirebase(id, usuario);

      if (!lock.ok) {
        if (lock.exists) {
          InfraDeskDoca.abortAlreadyReserved(card, lock.reserva, usuario);
        } else {
          InfraDeskDoca.notify('warning', 'Não consegui consultar/criar a reserva no Firebase. Para evitar duplicidade, não capturei este chamado.');
        }

        return;
      }

      // Extrai os dados completos do card somente no clique.
      // Isso não consome download do Firebase; é leitura do HTML já carregado na tela.
      var cardInfo = InfraDeskDoca.extractCardInfo(card);
      cardInfo.statusAntes = InfraDeskDoca.getCardStatusId(card);

      var nativeOk = InfraDeskDoca.runNativeCapture(btn, id);

      if (!nativeOk) {
        await InfraDeskDoca.releaseFirebaseReservation(id);
        InfraDeskDoca.notify('error', 'Não consegui executar a captura original do Infradesk. Liberei a reserva no Firebase.');
        return;
      }

      // Espera a captura original terminar. Depois confirma status no Infradesk e move visualmente.
      setTimeout(async function () {
        var persisted = await InfraDeskDoca.persistStatusInInfradesk(id);

        if (!persisted) {
          await InfraDeskDoca.releaseFirebaseReservation(id);
          InfraDeskDoca.notify('warning', 'A captura não confirmou a mudança de status. Liberei a reserva no Firebase e não movi o card.');
          return;
        }

        // Agora grava o pacote completo igual ao script original, mas somente deste chamado.
        // O PATCH usa print=silent para não baixar resposta grande.
        await InfraDeskDoca.saveCaptureToFirebase(id, usuario, cardInfo);

        InfraDeskDoca.moveCardToLiberacaoLocal(id, usuario);

        setTimeout(function () {
          InfraDeskDoca.refreshCardFromSystem(id, usuario, InfraDeskDoca.STATUS_EM_LIBERACAO);
        }, 450);
      }, 900);
    } finally {
      setTimeout(function () {
        delete InfraDeskDoca.state.clickingIds[id];
      }, 1800);
    }
  };

  InfraDeskDoca.onSafeCaptureClick = function (event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    var btn = event.currentTarget || (event.target && event.target.closest ? event.target.closest('.capturar-btn, a[data-tm-doca-native-onclick*="capturarChamadoNew"]') : null);

    if (!btn) {
      return;
    }

    InfraDeskDoca.captureAllowed(btn);
  };

  InfraDeskDoca.onDocumentClickCapture = function (event) {
    var target = event.target;

    if (!target || !target.closest) {
      return;
    }

    var btn = target.closest('.capturar-btn, a[onclick*="capturarChamadoNew"], a[data-tm-doca-native-onclick*="capturarChamadoNew"]');

    if (!btn) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    InfraDeskDoca.prepareCaptureButton(btn);
    InfraDeskDoca.captureAllowed(btn);
  };

  InfraDeskDoca.observeBody = function () {
    if (InfraDeskDoca.state.observer) {
      InfraDeskDoca.state.observer.disconnect();
    }

    InfraDeskDoca.state.observer = new MutationObserver(function () {
      if (InfraDeskDoca.state.orderRunning) {
        return;
      }

      clearTimeout(InfraDeskDoca.state.debounceTimer);

      InfraDeskDoca.state.debounceTimer = setTimeout(function () {
        if (InfraDeskDoca.state.orderRunning) {
          return;
        }

        InfraDeskDoca.refreshLoggedUser();
        InfraDeskDoca.injectAllCards();
      }, 300);
    });

    InfraDeskDoca.state.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  };

  InfraDeskDoca.testPersistStatus = function (id) {
    return InfraDeskDoca.persistStatusInInfradesk(id);
  };

  InfraDeskDoca.testExtract = function (id) {
    var card = id ? InfraDeskDoca.findCardById(id) : document.querySelector('.chamado-item[data-chamado-id], li.chamado-item');
    return InfraDeskDoca.extractCardInfo(card);
  };

  InfraDeskDoca.testRemote = function (id) {
    return InfraDeskDoca.getRemoteCapture(id);
  };

  InfraDeskDoca.start = function () {
    if (InfraDeskDoca.state.started) {
      return;
    }

    InfraDeskDoca.state.started = true;

    InfraDeskDoca.injectStyle();
    InfraDeskDoca.refreshLoggedUser();

    document.removeEventListener('click', InfraDeskDoca.onDocumentClickCapture, true);
    document.addEventListener('click', InfraDeskDoca.onDocumentClickCapture, true);

    // Mantém o modo leve no Firebase, mas religa a parte visual:
    // prepara botões, organiza as três colunas e observa novos cards carregados pelo Infradesk.
    InfraDeskDoca.injectAllCards();
    InfraDeskDoca.observeBody();
    InfraDeskDoca.scheduleOrderPriorityTabs(350);

    setTimeout(function () {
      console.info('[InfraDeskDoca] v4.0.0 unificado ativo: painel econômico, reserva expira após 1h e Firebase completo somente no clique.');
    }, 600);

    window.addEventListener('beforeunload', function () {
      if (InfraDeskDoca.state.eventSource) {
        InfraDeskDoca.state.eventSource.close();
      }
    });
  };

  window.InfraDeskDoca = InfraDeskDoca;

  if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.InfraDeskDoca = InfraDeskDoca;
  }

  if (document.body && document.readyState !== 'loading') {
    InfraDeskDoca.start();
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      InfraDeskDoca.start();
    }, { once: true });
  }
})();
