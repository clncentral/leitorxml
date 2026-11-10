// ==UserScript==
// @name         InfraDesk Despesas • Trava por usuário logado
// @namespace    clncentral/infradesk
// @version      5.3.5
// @description  Reserva permanente por operador, painel financeiro unificado, relatório PDF e integração Firebase.
// @author       CLN Central
// @match        https://asp.infradesk.app/backend/despesas*
// @match        https://asp.infradesk.app/backend/despesas/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      infradesk-operadores-default-rtdb.firebaseio.com
// @updateURL    https://clncentral.github.io/leitorxml/script/tamperMonkey.user.js
// @downloadURL  https://clncentral.github.io/leitorxml/script/tamperMonkey.user.js
// @noframes
// ==/UserScript==


(function () {
  "use strict";

  // =========================================================
  // CONFIGURACAO_PRINCIPAL
  // Para localizar depois, use CTRL + F e procure por:
  // CONFIGURACAO_PRINCIPAL
  // =========================================================
  const CONFIG = {
    versao: "5.3.5",
    parametroPainel: "sigma_painel_financeiro_v5",
    urlPainel: "/backend/despesas?sigma_painel_financeiro_v5=1",
    statusFilaFixo: "P",
    statusAbas: {
      agendar: ["P"],
      pendentes: ["R", "A"],
    },

    // O InfraDesk pagina o resultado normal. Portanto podemos usar
    // um período amplo sem mandar o navegador desenhar 200 despesas.
    periodoInicial: "01/01/2020",
    periodoFinal: "31/12/2035",
    paginasSimultaneas: 3,

    firebaseBase: "https://infradesk-operadores-default-rtdb.firebaseio.com",
    firebaseReservas: "despesas_updates/by_id",
    firebaseEstadoPainel: "despesas_painel/estado/by_id",
    // Dados persistentes para histórico/relatórios; NÃO entram na limpeza de estados.
    firebaseDados: "despesas_painel/dados/by_id",
    // Registro permanente por evento: cada reserva/liberação possui seu ID único.
    firebaseHistorico: "despesas_painel/historico/by_id",

    // Uma conclusão recente some imediatamente da tela dos outros usuários.
    // Em uma nova consulta, depois desse prazo, o InfraDesk volta a ser
    // a fonte principal da verdade caso a despesa retorne ao Financeiro.
    validadeEstadoFinalMs: 12 * 60 * 60 * 1000,

    coresUsuarios: {
      "Elias Araujo": "#0324ff",
      "Camily Assis": "#d8b4e8",
      "Elia Maria": "#962bcc",
      Patricia: "#ff8e03",
      Marcia: "#6a0e9c",
      Helena: "#8c1223",
    },
  };

  const PREFIXO = "[Painel Financeiro]";
  const urlAtual = new URL(window.location.href);
  const modoPainel = urlAtual.searchParams.get(CONFIG.parametroPainel) === "1";

  const normalState = {
    iniciado: false,
    usuario: { nome: "", id: "" },
    reservas: {},
    eventosReserva: null,
    recebeuPrimeiroEvento: false,
    observer: null,
    linhasPorId: new Map(),
    modalDespesaId: "",
    abrindoIds: new Set(),
    salvandoIds: new Set(),
    enviandoConclusoes: false,
    timerConclusoes: null,
  };

  // A fila do histórico deve existir ANTES da saída antecipada da página
  // normal: somente o painel continua executando o restante deste IIFE.
  const CHAVE_FILA_METADADOS = "sigma-financeiro-fila-dados-v1";
  const CHAVE_FILA_EVENTOS = "sigma-financeiro-fila-eventos-v1";
  const CHAVE_CONCLUSOES_NORMAL = "sigma-financeiro-conclusoes-confirmadas-v1";
  const filaMetadados = {
    iniciada: false,
    pendentes: {},
    eventos: {},
    ultimoSnapshot: {},
    timer: null,
    timerCaptura: null,
    enviando: false,
    errosConsecutivos: 0,
  };

  if (!modoPainel) {
    iniciarPaginaPrincipalLeve();
    return;
  }

  // A versão anterior tentava interromper e reescrever o documento em
  // document-start. Em alguns navegadores isso também interrompia os
  // próprios arquivos do painel e resultava em uma aba completamente branca.
  // Agora escondemos a página original, esperamos o DOM ficar disponível e
  // então substituímos somente o conteúdo visual.
  ocultarPaginaOriginal();

  const state = {
    despesas: [],
    abaAtual: "agendar",
    cacheAbas: {
      agendar: null,
      pendentes: null,
    },
    reservas: {},
    estados: {},
    usuario: { nome: "", setor: "", login: "", id: "" },
    itemModal: null,
    carregando: false,
    dependenciasPromise: null,
    eventosReserva: null,
    eventosEstado: null,
    renderTimer: null,
    modalObserver: null,
    restaurandoPreferencias: false,
    inicializando: true,
    filtrosProntos: false,
    renderPendente: false,
    destruindoSelect2: false,
    salvandoId: "",
    abrindoIds: new Set(),
    reservandoIds: new Set(),
    sincronizandoFirebase: false,
    firebaseRetryTimer: null,
  };

  prepararPainel().catch(function (falha) {
    console.error(PREFIXO, falha);
    revelarDocumento();
    mostrarErroFatal(falha);
  });

  // =========================================================
  // ABRIR_PAINEL_EM_OUTRA_ABA
  // Nas páginas normais do InfraDesk adiciona um pequeno atalho.
  // =========================================================
  function instalarBotaoAbrirPainel() {
    const instalar = function () {
      if (!document.body) return;

      let link = document.getElementById("sigma-abrir-painel-financeiro");
      if (!link) {
        link = document.createElement("a");
        link.id = "sigma-abrir-painel-financeiro";
        document.body.appendChild(link);
      }
      link.href = CONFIG.urlPainel;
      link.target = "_blank";
      link.rel = "noopener";
      link.innerHTML = '<i class="fa-solid fa-table-list"></i><span>Painel Financeiro</span>';
      link.title = "Abrir o novo Painel Financeiro em outra aba";
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
        "background:#0f172a",
        "color:#fff",
        "font:800 13px Arial,sans-serif",
        "text-decoration:none",
        "box-shadow:0 10px 28px rgba(15,23,42,.32)",
      ].join(";");

    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", instalar, { once: true });
    } else {
      instalar();
    }
  }

  // =========================================================
  // PAGINA_PRINCIPAL_LEVE
  // Para localizar depois, use CTRL + F e procure por:
  // PAGINA_PRINCIPAL_LEVE
  //
  // Nesta tela não existe contador de competências, paginação extra,
  // cache de competências nem varredura das outras páginas.
  // O script cuida somente da reserva e do atalho para o painel.
  // =========================================================
  function iniciarPaginaPrincipalLeve() {
    if (window.top !== window.self) return;

    const iniciar = function () {
      if (normalState.iniciado || !document.body) return;
      normalState.iniciado = true;
      iniciarFilaMetadados();
      agendarReenvioConclusoesNormal(600);

      instalarBotaoAbrirPainel();
      injetarEstiloPaginaPrincipal();
      atualizarUsuarioPaginaPrincipal();
      processarLinhasPaginaPrincipal(document);
      atualizarTodosBotoesFinanceirosNormal();
      observarPaginaPrincipal();

      document.addEventListener("click", tratarCliquePaginaPrincipal, true);
      document.addEventListener("submit", tratarSubmitPaginaPrincipal, true);
      // O listener de bolha executa depois dos validadores nativos do formulário.
      document.addEventListener("submit", auditarEnvioFinanceiroNormal, false);
      conectarRealtimePaginaPrincipal();

      // Algumas partes do InfraDesk chegam logo depois do DOMContentLoaded.
      // São poucas tentativas e somente as linhas ainda não preparadas entram.
      let tentativas = 0;
      const timer = setInterval(function () {
        tentativas++;
        atualizarUsuarioPaginaPrincipal();
        processarLinhasPaginaPrincipal(document);
        if (tentativas >= 8) clearInterval(timer);
      }, 600);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", iniciar, { once: true });
    } else {
      iniciar();
    }
  }

  function injetarEstiloPaginaPrincipal() {
    if (document.getElementById("sigma-reserva-principal-css")) return;

    const style = document.createElement("style");
    style.id = "sigma-reserva-principal-css";
    style.textContent = `
      tr.tr-index > td:first-child p {
        display: inline-block !important;
        margin: 0 4px !important;
        vertical-align: middle !important;
        line-height: 23px !important;
      }
      .sigma-reserva-inline {
        display: inline-flex !important;
        align-items: center !important;
        gap: 4px !important;
        margin-left: 5px !important;
        vertical-align: middle !important;
      }
      .sigma-reserva-inline > .select2-container,
      .sigma-reserva-inline .select2-container {
        display: none !important;
      }
      .sigma-reserva-select,
      .sigma-reserva-select.select2-hidden-accessible {
        position: static !important;
        display: inline-block !important;
        clip: auto !important;
        overflow: visible !important;
        width: 118px !important;
        height: 23px !important;
        min-height: 23px !important;
        max-height: 23px !important;
        margin: 0 !important;
        padding: 1px 5px !important;
        border: 1px solid #94a3b8 !important;
        border-radius: 9px !important;
        opacity: 1 !important;
        white-space: normal !important;
        color: #334155 !important;
        font-size: 10px !important;
        font-weight: 900 !important;
        line-height: 19px !important;
        outline: none !important;
        cursor: pointer !important;
        vertical-align: middle !important;
        box-shadow: 0 1px 3px rgba(15, 23, 42, .08) !important;
      }
      .sigma-reserva-select:focus {
        border-color: #2563eb !important;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, .14) !important;
      }
      .sigma-reserva-select.sigma-salvando {
        opacity: .55 !important;
        pointer-events: none !important;
      }
      .sigma-reserva-select option {
        background: #fff !important;
        color: #111827 !important;
        font-weight: 800 !important;
      }
      .sigma-reserva-liberar {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 20px !important;
        min-width: 20px !important;
        height: 20px !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 999px !important;
        color: #fff !important;
        font-size: 14px !important;
        font-weight: 900 !important;
        line-height: 20px !important;
        cursor: pointer !important;
        box-shadow: 0 2px 5px rgba(15, 23, 42, .22) !important;
      }
      .sigma-reserva-liberar:hover {
        filter: brightness(1.15) !important;
        transform: scale(1.05) !important;
      }
      .sigma-reserva-liberar[hidden] {
        display: none !important;
      }
      .sigma-reserva-status {
        min-width: 11px !important;
        color: #64748b !important;
        font-size: 10px !important;
        font-weight: 900 !important;
      }
      .sigma-reserva-bloqueado {
        opacity: .36 !important;
        cursor: not-allowed !important;
        filter: grayscale(1) !important;
      }
    `;
    document.head.appendChild(style);
  }

  function atualizarUsuarioPaginaPrincipal() {
    const globalUsuario = paginaWindow().__SIGMA_USUARIO_LOGADO__;
    if (globalUsuario && texto(globalUsuario.nome)) {
      normalState.usuario.nome = texto(globalUsuario.nome);
      normalState.usuario.id = texto(globalUsuario.id);
      return normalState.usuario;
    }

    const seletores = [
      ".profile-element strong.font-bold",
      ".profile-element .font-bold",
      ".nav-header strong.font-bold",
      ".nav-header .font-bold",
      ".nav-header big",
    ];

    for (const seletor of seletores) {
      const el = document.querySelector(seletor);
      if (!el) continue;
      const nome = texto(el.textContent || "")
        .replace(/\s*\bSair\b\s*$/i, "")
        .replace(/\s*\bMeus dados\b\s*$/i, "")
        .replace(/[▾▼]/g, "")
        .trim();
      if (nome && !/central|libera/i.test(nome) && nome.length >= 3) {
        normalState.usuario.nome = nome;
        break;
      }
    }

    const avatar = document.querySelector(
      '[id*="avatar_usuario_"], img[src*="/avatar/"], [style*="avatar_usuario_"]'
    );
    if (avatar) {
      const origem = [
        avatar.id || "",
        avatar.getAttribute("src") || "",
        avatar.getAttribute("style") || "",
      ].join(" ");
      const match = origem.match(/avatar_usuario_(\d+)|\/avatar\/(\d+)\//i);
      if (match) normalState.usuario.id = texto(match[1] || match[2]);
    }

    return normalState.usuario;
  }

  function idDespesaDeTexto(valor) {
    const match = String(valor || "").match(
      /\/backend\/despesas\/(?:financeiro|revisar|aprovar|bloquear)\/(\d+)|despesa_id=(\d+)/i
    );
    return match ? texto(match[1] || match[2]) : "";
  }

  function idLinhaPaginaPrincipal(tr) {
    if (!tr) return "";

    const salvo = texto(tr.dataset ? tr.dataset.sigmaId : "");
    if (salvo) return salvo;

    const botao = tr.querySelector(
      '[onclick*="/backend/despesas/financeiro/"],' +
      '[onclick*="/backend/despesas/revisar/"],' +
      '[onclick*="/backend/despesas/aprovar/"],' +
      '[onclick*="/backend/despesas/bloquear/"]'
    );
    const peloBotao = botao ? idDespesaDeTexto(botao.getAttribute("onclick") || "") : "";
    if (peloBotao) return peloBotao;

    const primeira = tr.children && tr.children.length ? tr.children[0] : null;
    const p = primeira ? primeira.querySelector("p") : null;
    const numero = texto(p ? p.textContent : "").match(/^\d{3,}$/);
    return numero ? numero[0] : "";
  }

  function ehLinhaDespesaPaginaPrincipal(tr) {
    if (!tr || !tr.matches || !tr.matches("tr")) return false;
    if (tr.querySelector("th") || tr.classList.contains("expandir")) return false;
    if (String(tr.className || "").includes("expandir-")) return false;
    if (!idLinhaPaginaPrincipal(tr)) return false;
    return tr.classList.contains("tr-index")
      || !!tr.querySelector(".td-buttons, a.btn, button.btn")
      || Array.from(tr.children || []).some(function (td) {
        return /\bR\$\s*/.test(td.textContent || "");
      });
  }

  function processarLinhasPaginaPrincipal(raiz) {
    if (!raiz || !raiz.querySelectorAll) return;

    const linhas = [];
    if (raiz.matches && raiz.matches("tr")) linhas.push(raiz);
    raiz.querySelectorAll("tbody tr").forEach(function (tr) { linhas.push(tr); });

    linhas.forEach(function (tr) {
      if (!ehLinhaDespesaPaginaPrincipal(tr)) return;
      prepararLinhaPaginaPrincipal(tr);
    });
  }

  function prepararLinhaPaginaPrincipal(tr) {
    const id = idLinhaPaginaPrincipal(tr);
    if (!id) return;

    tr.dataset.sigmaId = id;
    normalState.linhasPorId.set(id, tr);

    let inline = tr.querySelector(".sigma-reserva-inline");
    if (!inline) {
      inline = document.createElement("span");
      inline.className = "sigma-reserva-inline";

      const select = document.createElement("select");
      select.className = "sigma-reserva-select";
      select.dataset.sigmaId = id;
      select.title = "Responsável por esta despesa";
      select.addEventListener("mousedown", function (evento) { evento.stopPropagation(); });
      select.addEventListener("click", function (evento) { evento.stopPropagation(); });
      select.addEventListener("change", function () { void alterarReservaPaginaPrincipal(select); });

      const liberar = document.createElement("button");
      liberar.type = "button";
      liberar.className = "sigma-reserva-liberar";
      liberar.dataset.sigmaId = id;
      liberar.textContent = "×";
      liberar.hidden = true;
      liberar.addEventListener("mousedown", function (evento) { evento.stopPropagation(); });
      liberar.addEventListener("click", function (evento) {
        evento.preventDefault();
        evento.stopPropagation();
        void removerReservaPaginaPrincipal(id);
      });

      const status = document.createElement("span");
      status.className = "sigma-reserva-status";

      inline.appendChild(select);
      inline.appendChild(liberar);
      inline.appendChild(status);

      const primeira = tr.children && tr.children.length ? tr.children[0] : null;
      const numero = primeira ? primeira.querySelector("p") : null;
      if (numero) numero.insertAdjacentElement("afterend", inline);
      else if (primeira) primeira.insertBefore(inline, primeira.firstChild);
    }

    atualizarLinhaPaginaPrincipal(id);
  }

  function donoReservaNormal(id) {
    return donoReservaNoMapa(normalState.reservas, id);
  }

  function donoReservaNoMapa(mapa, id) {
    const item = mapa && mapa[id];
    if (!item) return "";
    if (typeof item === "string") return texto(item);
    return texto(item.operador || item.usuario || item.nome || item.user || "");
  }

  function donoItemReserva(item) {
    if (!item) return "";
    if (typeof item === "string") return texto(item);
    return texto(item.operador || item.usuario || item.nome || item.user || "");
  }

  function atualizarOpcoesReservaNormal(select, owner) {
    if (!select) return;
    atualizarUsuarioPaginaPrincipal();
    restaurarSelectReservaNativo(select);

    const usuario = texto(normalState.usuario.nome);
    const valorAnterior = owner || "";
    select.innerHTML = "";

    const semUsuario = document.createElement("option");
    semUsuario.value = "";
    semUsuario.textContent = "Sem usuário";
    select.appendChild(semUsuario);

    if (owner) {
      const atual = document.createElement("option");
      atual.value = owner;
      atual.textContent = owner;
      select.appendChild(atual);
    }

    if (usuario && !mesmaPessoa(owner, usuario)) {
      const assumir = document.createElement("option");
      assumir.value = usuario;
      assumir.textContent = usuario;
      select.appendChild(assumir);
    }

    select.value = valorAnterior;
    estilizarSelectReservaNormal(select, owner);
  }

  function estilizarSelectReservaNormal(select, owner) {
    const cor = corUsuario(owner);
    const corTexto = owner && cor.toLowerCase() !== "#d8b4e8" ? "#fff" : "#334155";
    select.style.setProperty("background", owner ? cor : "#fff", "important");
    select.style.setProperty("background-color", owner ? cor : "#fff", "important");
    select.style.setProperty("color", corTexto, "important");
    select.style.setProperty("border-color", owner ? cor : "#94a3b8", "important");
    select.style.setProperty(
      "box-shadow",
      owner ? `0 0 0 2px ${cor}33` : "0 1px 3px rgba(15, 23, 42, .08)",
      "important"
    );
  }

  function restaurarSelectReservaNativo(select) {
    if (!select) return;

    const root = paginaWindow();
    const $ = root.jQuery || root.$ || window.jQuery || window.$;
    if (
      $ && $.fn && typeof $.fn.select2 === "function"
      && select.classList.contains("select2-hidden-accessible")
    ) {
      try { $(select).select2("destroy"); } catch (_) {}
    }

    select.classList.remove("select2-hidden-accessible");
    select.removeAttribute("data-select2-id");
    select.removeAttribute("tabindex");
    select.removeAttribute("aria-hidden");
    select.style.removeProperty("position");
    select.style.removeProperty("clip");
    select.style.removeProperty("overflow");
    select.style.removeProperty("opacity");

    const inline = select.closest(".sigma-reserva-inline");
    if (inline) {
      inline.querySelectorAll(".select2-container").forEach(function (container) {
        container.remove();
      });
    }
  }

  function restaurarTodosSelectsReservaNativos() {
    document.querySelectorAll(".sigma-reserva-select").forEach(function (select) {
      restaurarSelectReservaNativo(select);
      estilizarSelectReservaNormal(select, donoReservaNormal(texto(select.dataset.sigmaId)));
    });
  }

  function obterLinhaNormal(id) {
    const conhecida = normalState.linhasPorId.get(id);
    if (conhecida && conhecida.isConnected) return conhecida;
    normalState.linhasPorId.delete(id);
    return null;
  }

  function atualizarLinhaPaginaPrincipal(id) {
    const tr = obterLinhaNormal(id);
    if (!tr) return;

    const owner = donoReservaNormal(id);
    const select = tr.querySelector(".sigma-reserva-select");
    atualizarOpcoesReservaNormal(select, owner);

    const cor = corUsuario(owner);
    const liberar = tr.querySelector(".sigma-reserva-liberar");
    if (liberar) {
      liberar.hidden = !owner;
      liberar.title = owner
        ? (mesmaPessoa(owner, normalState.usuario.nome)
          ? "Liberar esta despesa"
          : `Remover a reserva de ${owner}`)
        : "";
      liberar.style.setProperty("background", owner ? cor : "#64748b", "important");
      liberar.style.setProperty(
        "color",
        owner && cor.toLowerCase() === "#d8b4e8" ? "#334155" : "#fff",
        "important"
      );
    }
    tr.style.boxShadow = owner ? `inset 5px 0 0 ${cor}` : "";
    const primeira = tr.children && tr.children.length ? tr.children[0] : null;
    if (primeira) primeira.style.boxShadow = owner ? `${cor} 6px 0 0 inset` : "";

    atualizarBotoesFinanceirosDaLinhaNormal(tr, id, owner);
    // Só arquiva a despesa quando há responsável conhecido. A reserva em tempo
    // real pode chegar depois do HTML; nesse caso esta função roda novamente.
    if (owner) {
      const item = extrairMetadadosDaLinhaNormal(tr, id);
      if (item) registrarMetadadosDespesa(item, owner);
    }
    if (normalState.modalDespesaId === id) atualizarBotoesModalNormal();
  }

  function guardarEstadoOriginalBotaoNormal(botao) {
    if (!botao.dataset.sigmaOriginalDisabled) {
      botao.dataset.sigmaOriginalDisabled = botao.disabled ? "1" : "0";
      botao.dataset.sigmaOriginalClasseDisabled = botao.classList.contains("disabled") ? "1" : "0";
      botao.dataset.sigmaOriginalTitle = botao.getAttribute("title") || "";
    }
  }

  function definirBloqueioBotaoNormal(botao, bloqueado, owner) {
    if (!botao) return;
    guardarEstadoOriginalBotaoNormal(botao);

    if (bloqueado) {
      if (botao.tagName.toLowerCase() === "button") botao.disabled = true;
      botao.classList.add("disabled", "sigma-reserva-bloqueado");
      botao.setAttribute("aria-disabled", "true");
      botao.setAttribute("title", "Bloqueado: " + owner);
      botao.dataset.sigmaBloqueadoReserva = "1";
      return;
    }

    if (botao.dataset.sigmaOriginalDisabled === "0" && botao.tagName.toLowerCase() === "button") {
      botao.disabled = false;
    }
    if (botao.dataset.sigmaOriginalClasseDisabled === "0") botao.classList.remove("disabled");
    botao.classList.remove("sigma-reserva-bloqueado");
    botao.removeAttribute("aria-disabled");
    botao.setAttribute("title", botao.dataset.sigmaOriginalTitle || "");
    botao.dataset.sigmaBloqueadoReserva = "0";
  }

  function atualizarBotoesFinanceirosDaLinhaNormal(tr, id, owner) {
    const bloqueado = !!owner && !mesmaPessoa(owner, normalState.usuario.nome);
    tr.querySelectorAll(
      '[onclick*="/backend/despesas/financeiro/"], [data-sigma-finance-url]'
    ).forEach(function (botao) {
      const idBotao = idDespesaDeTexto(botao.getAttribute("onclick") || "") || texto(botao.dataset.sigmaId);
      if (!idBotao || idBotao === id) definirBloqueioBotaoNormal(botao, bloqueado, owner);
    });
  }

  function atualizarTodosBotoesFinanceirosNormal() {
    document.querySelectorAll('[onclick*="/backend/despesas/financeiro/"]').forEach(function (botao) {
      const id = idDespesaDeTexto(botao.getAttribute("onclick") || "");
      if (!id) return;
      definirBloqueioBotaoNormal(
        botao,
        !!donoReservaNormal(id) && !mesmaPessoa(donoReservaNormal(id), normalState.usuario.nome),
        donoReservaNormal(id)
      );
    });
    atualizarBotoesModalNormal();
  }

  function atualizarBotoesModalNormal() {
    const modal = document.querySelector("#ModalDespesas");
    if (!modal || !normalState.modalDespesaId) return;
    const owner = donoReservaNormal(normalState.modalDespesaId);
    const bloqueado = !!owner && !mesmaPessoa(owner, normalState.usuario.nome);
    modal.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(function (botao) {
      definirBloqueioBotaoNormal(botao, bloqueado, owner);
    });
  }

  function statusReservaNormal(id, valor) {
    const tr = obterLinhaNormal(id);
    const status = tr ? tr.querySelector(".sigma-reserva-status") : null;
    if (status) status.textContent = valor || "";
  }

  async function removerReservaPaginaPrincipal(id) {
    id = texto(id);
    const ownerAnterior = donoReservaNormal(id);
    const tr = obterLinhaNormal(id);
    const select = tr ? tr.querySelector(".sigma-reserva-select") : null;

    atualizarUsuarioPaginaPrincipal();
    if (!id || !ownerAnterior) {
      atualizarLinhaPaginaPrincipal(id);
      return false;
    }
    if (!normalState.usuario.nome) {
      notificarPaginaPrincipal("error", "Não consegui identificar o usuário logado.");
      atualizarLinhaPaginaPrincipal(id);
      return false;
    }

    const pergunta = mesmaPessoa(ownerAnterior, normalState.usuario.nome)
      ? `Liberar a despesa ${id}?`
      : `Remover a reserva de ${ownerAnterior} na despesa ${id}?`;
    if (!window.confirm(pergunta)) {
      atualizarLinhaPaginaPrincipal(id);
      return false;
    }

    if (select) select.classList.add("sigma-salvando");
    statusReservaNormal(id, "...");

    try {
      const resultado = await liberarReservaFirebaseSeguro(
        id,
        normalState.usuario,
        { permitirOutro: true, donoEsperado: ownerAnterior }
      );
      aplicarResultadoReservaNormal(id, resultado);
      if (!resultado.ok) throw new Error(mensagemFalhaReserva(resultado));

      statusReservaNormal(id, "✓");
      setTimeout(function () { statusReservaNormal(id, ""); }, 1100);
      return true;
    } catch (falha) {
      statusReservaNormal(id, "!");
      notificarPaginaPrincipal("error", texto(falha.message || falha));
      return false;
    } finally {
      if (select) select.classList.remove("sigma-salvando");
      atualizarLinhaPaginaPrincipal(id);
    }
  }

  async function alterarReservaPaginaPrincipal(select) {
    const id = texto(select.dataset.sigmaId);
    const ownerAnterior = donoReservaNormal(id);
    const escolhido = texto(select.value);
    atualizarUsuarioPaginaPrincipal();

    if (!id || !normalState.usuario.nome) {
      notificarPaginaPrincipal("error", "Não consegui identificar o usuário logado.");
      atualizarOpcoesReservaNormal(select, ownerAnterior);
      return;
    }

    if (escolhido && mesmaPessoa(escolhido, ownerAnterior)) return;

    if (!escolhido) {
      await removerReservaPaginaPrincipal(id);
      return;
    }

    select.classList.add("sigma-salvando");
    statusReservaNormal(id, "...");

    try {
      if (mesmaPessoa(escolhido, normalState.usuario.nome)) {
        const assumirOutro = !!ownerAnterior && !mesmaPessoa(ownerAnterior, normalState.usuario.nome);
        if (assumirOutro && !window.confirm(
          `Esta despesa está com ${ownerAnterior}.\n\nAssumir para ${normalState.usuario.nome}?`
        )) return;

        const resultado = await reservarDespesaFirebaseSeguro(
          id,
          normalState.usuario,
          { permitirAssumir: assumirOutro, donoEsperado: ownerAnterior }
        );
        aplicarResultadoReservaNormal(id, resultado);
        if (!resultado.ok) throw new Error(mensagemFalhaReserva(resultado));
      }

      statusReservaNormal(id, "✓");
      setTimeout(function () { statusReservaNormal(id, ""); }, 1100);
    } catch (falha) {
      statusReservaNormal(id, "!");
      notificarPaginaPrincipal("error", texto(falha.message || falha));
    } finally {
      select.classList.remove("sigma-salvando");
      atualizarLinhaPaginaPrincipal(id);
    }
  }

  function aplicarResultadoReservaNormal(id, resultado) {
    if (!resultado) return;
    if (donoItemReserva(resultado.item)) {
      normalState.reservas[id] = resultado.item;
    } else {
      delete normalState.reservas[id];
    }
    atualizarLinhaPaginaPrincipal(id);
  }

  function mensagemFalhaReserva(resultado) {
    if (resultado && resultado.codigo === "ocupada") {
      return "Esta despesa está com " + (resultado.owner || "outro usuário") + ".";
    }
    if (resultado && resultado.codigo === "alterada") {
      return "A reserva mudou enquanto você trabalhava. A linha foi atualizada.";
    }
    return texto(resultado && resultado.mensagem) || "Não consegui atualizar a reserva no Firebase.";
  }

  function aplicarEventoReservaPaginaPrincipal(raw) {
    try {
      const evento = JSON.parse(raw || "{}");
      const caminho = String(evento.path || "");
      const data = evento.data;

      if (caminho === "/" || caminho === "") {
        normalState.reservas = data && typeof data === "object" ? data : {};
        normalState.recebeuPrimeiroEvento = true;
        normalState.linhasPorId.forEach(function (tr, id) {
          if (tr && tr.isConnected) atualizarLinhaPaginaPrincipal(id);
          else normalState.linhasPorId.delete(id);
        });
        atualizarTodosBotoesFinanceirosNormal();
        return;
      }

      const partes = caminho.replace(/^\/+/, "").split("/").filter(Boolean);
      const id = texto(partes[0]);
      if (!id) return;

      if (partes.length === 1) {
        if (data == null) delete normalState.reservas[id];
        else normalState.reservas[id] = data;
      } else {
        if (!normalState.reservas[id] || typeof normalState.reservas[id] !== "object") {
          normalState.reservas[id] = {};
        }
        if (data == null) delete normalState.reservas[id][partes[1]];
        else normalState.reservas[id][partes[1]] = data;
      }
      atualizarLinhaPaginaPrincipal(id);
    } catch (_) {}
  }

  function conectarRealtimePaginaPrincipal() {
    try {
      if (normalState.eventosReserva) normalState.eventosReserva.close();
      const es = new EventSource(firebaseUrl(CONFIG.firebaseReservas));
      es.addEventListener("put", function (evento) {
        aplicarEventoReservaPaginaPrincipal(evento.data);
      });
      es.addEventListener("patch", function (evento) {
        aplicarEventoReservaPaginaPrincipal(evento.data);
      });
      es.onerror = function () {};
      normalState.eventosReserva = es;
    } catch (falha) {
      console.warn(PREFIXO, "Realtime da página principal", falha);
    }
  }

  function observarPaginaPrincipal() {
    if (normalState.observer) normalState.observer.disconnect();
    let pendentes = [];
    let agendado = false;

    normalState.observer = new MutationObserver(function (mutacoes) {
      mutacoes.forEach(function (mutacao) {
        mutacao.addedNodes.forEach(function (no) {
          if (no && no.nodeType === 1) pendentes.push(no);
        });
      });

      if (agendado || !pendentes.length) return;
      agendado = true;
      requestAnimationFrame(function () {
        agendado = false;
        const atuais = pendentes;
        pendentes = [];
        atuais.forEach(processarLinhasPaginaPrincipal);
        restaurarTodosSelectsReservaNativos();
        atualizarBotoesModalNormal();
      });
    });

    normalState.observer.observe(document.body, { childList: true, subtree: true });
  }

  function ehBotaoFinanceiroNormal(el) {
    return !!(el && el.getAttribute && /\/backend\/despesas\/financeiro\/\d+/i.test(
      el.getAttribute("onclick") || el.dataset.sigmaFinanceUrl || ""
    ));
  }

  function tratarCliquePaginaPrincipal(evento) {
    const alvo = evento.target && evento.target.closest
      ? evento.target.closest("button, a")
      : null;
    if (!ehBotaoFinanceiroNormal(alvo)) return;

    evento.preventDefault();
    evento.stopPropagation();
    evento.stopImmediatePropagation();
    void abrirFinanceiroPaginaPrincipal(alvo);
  }

  async function abrirFinanceiroPaginaPrincipal(botao) {
    const id = idDespesaDeTexto(
      botao.getAttribute("onclick") || botao.dataset.sigmaFinanceUrl || ""
    ) || texto(botao.dataset.sigmaId);
    if (!id || normalState.abrindoIds.has(id)) return;

    normalState.abrindoIds.add(id);
    try {
      atualizarUsuarioPaginaPrincipal();
      if (!normalState.usuario.nome) {
        notificarPaginaPrincipal("error", "Não consegui identificar o usuário logado.");
        return;
      }

      const resultado = await reservarDespesaFirebaseSeguro(
        id,
        normalState.usuario,
        { permitirAssumir: false }
      );
      aplicarResultadoReservaNormal(id, resultado);
      if (!resultado.ok) {
        notificarPaginaPrincipal("warning", mensagemFalhaReserva(resultado));
        return;
      }

      normalState.modalDespesaId = id;
      executarAberturaFinanceiroNormal(botao);
    } catch (falha) {
      notificarPaginaPrincipal("error", "Não consegui reservar: " + texto(falha.message || falha));
    } finally {
      normalState.abrindoIds.delete(id);
    }
  }

  function executarAberturaFinanceiroNormal(botao) {
    const onclick = botao.getAttribute("onclick") || "";
    const match = onclick.match(/\.load\(['"]([^'"]+)['"]\)/i);
    const url = match ? match[1].replace(/&amp;/g, "&") : "";
    const root = paginaWindow();
    const $ = root.jQuery || root.$ || window.jQuery || window.$;
    const modalBody = corpoPrincipalModal();

    if (url && $ && document.getElementById("ModalDespesas") && modalBody) {
      $("#ModalDespesas").modal("show");
      $(modalBody).load(url, function (_resposta, status, xhr) {
        if (status === "error") {
          notificarPaginaPrincipal(
            "error",
            "Não consegui carregar o Financeiro"
              + (xhr && xhr.status ? ` (HTTP ${xhr.status})` : "")
              + "."
          );
          return;
        }
        atualizarBotoesModalNormal();
      });
      return;
    }

    try {
      if (root && typeof root.eval === "function") root.eval(onclick);
      else new Function(onclick).call(botao);
    } catch (falha) {
      console.warn(PREFIXO, "Abertura do financeiro", falha);
    }
  }

  function idFormularioFinanceiroNormal(form) {
    if (!form) return "";
    const idPelaAcao = idDespesaDeTexto(form.getAttribute("action") || "");
    if (idPelaAcao) return idPelaAcao;
    if (form.closest && form.closest("#ModalDespesas")) return normalState.modalDespesaId;
    return "";
  }

  // =========================================================
  // CONCLUSAO_CONFIRMADA_NA_PAGINA_NORMAL_V5_3_4
  // A v5.3.3 gravava "conclusao" somente pelo painel customizado.
  // No InfraDesk normal, a reserva era criada, mas o POST financeiro
  // prosseguia sem registrar o operador da conclusão para o gráfico.
  // Esta correção preserva os validadores do formulário: o primeiro
  // submit confirma a reserva e solicita o envio nativo; o listener de
  // BOLHA intercepta somente o POST já validado, acompanha a resposta
  // do InfraDesk e só registra o evento se não voltou o formulário.
  // Nenhum dado histórico é apagado ou reatribuído aqui.
  // =========================================================
  function tratarSubmitPaginaPrincipal(evento) {
    const form = evento.target;
    if (!form || !form.matches || !form.matches("form")) return;
    const id = idFormularioFinanceiroNormal(form);
    if (!id) return;

    if (form.dataset.sigmaReservaPermitirEnvio === "1") {
      form.dataset.sigmaReservaPermitirEnvio = "0";
      return;
    }

    evento.preventDefault();
    evento.stopPropagation();
    evento.stopImmediatePropagation();
    if (normalState.salvandoIds.has(id)) return;
    normalState.salvandoIds.add(id);
    const submitter = evento.submitter || null;
    atualizarUsuarioPaginaPrincipal();
    const usuarioConfirmado = Object.assign({}, normalState.usuario);

    reservarDespesaFirebaseSeguro(id, usuarioConfirmado, { permitirAssumir: false })
      .then(function (resultado) {
        aplicarResultadoReservaNormal(id, resultado);
        if (!resultado.ok) {
          notificarPaginaPrincipal("warning", mensagemFalhaReserva(resultado));
          return;
        }
        const financeiroPost = String(form.method || "post").toLowerCase() === "post"
          && /\/backend\/despesas\/financeiro\/\d+/i.test(form.action || "");
        if (financeiroPost) {
          form.dataset.sigmaAuditoriaNormalPendente = "1";
          // Congela o operador autenticado ANTES de qualquer navegação.
          form.sigmaUsuarioDaGravacao = usuarioConfirmado;
        }
        form.dataset.sigmaReservaPermitirEnvio = "1";
        try {
          if (typeof form.requestSubmit === "function") {
            if (submitter && submitter.form === form) form.requestSubmit(submitter);
            else form.requestSubmit();
          } else {
            // Navegadores muito antigos preservam o comportamento legado,
            // sem inventar uma conclusão que não pudemos confirmar.
            HTMLFormElement.prototype.submit.call(form);
          }
        } finally {
          // Um validador pode barrar o segundo envio antes da fase de bolha.
          // Nunca deixar uma autorização antiga válida para o próximo clique.
          setTimeout(function () {
            delete form.dataset.sigmaReservaPermitirEnvio;
            delete form.dataset.sigmaAuditoriaNormalPendente;
          }, 0);
        }
      })
      .catch(function (falha) {
        notificarPaginaPrincipal("error", "Não consegui confirmar a reserva: " + texto(falha.message || falha));
      })
      .finally(function () {
        normalState.salvandoIds.delete(id);
      });
  }

  // Fica na fase de bolha: validadores ligados ao formulário têm precedência.
  // Se o InfraDesk já tratou o envio via AJAX e cancelou o evento, não duplica POST.
  function auditarEnvioFinanceiroNormal(evento) {
    const form = evento.target;
    if (!form || form.dataset.sigmaAuditoriaNormalPendente !== "1") return;
    delete form.dataset.sigmaAuditoriaNormalPendente;
    if (evento.defaultPrevented) {
      console.warn(PREFIXO, "Envio controlado por outra rotina; não duplicamos POST nem atribuímos conclusão sem confirmação.");
      return;
    }
    const id = idFormularioFinanceiroNormal(form);
    if (!id) return;
    evento.preventDefault();
    evento.stopPropagation();
    const usuario = form.sigmaUsuarioDaGravacao || Object.assign({}, normalState.usuario);
    const submitter = evento.submitter || null;
    void enviarFormularioNormalConfirmandoConclusao(form, id, usuario, submitter);
  }

  function coletarFormularioFinanceiroNormal(form, submitter) {
    let dados;
    try { dados = submitter ? new FormData(form, submitter) : new FormData(form); }
    catch (_) { dados = new FormData(form); }
    if (submitter && submitter.name && !dados.has(submitter.name)) {
      dados.append(submitter.name, submitter.value || "");
    }
    return dados;
  }

  async function enviarFormularioNormalConfirmandoConclusao(form, id, usuario, submitter) {
    if (form.dataset.sigmaFinanceiroEnviando === "1") return;
    form.dataset.sigmaFinanceiroEnviando = "1";
    const botao = submitter && submitter.disabled !== undefined ? submitter : null;
    if (botao) botao.disabled = true;
    const url = new URL(form.action, window.location.href);
    if (url.origin !== window.location.origin) {
      notificarPaginaPrincipal("error", "Por segurança, não enviei o formulário para outra origem.");
      form.dataset.sigmaFinanceiroEnviando = "0";
      if (botao) botao.disabled = false;
      return;
    }
    const linha = obterLinhaNormal(id);
    const item = extrairMetadadosDaLinhaNormal(linha, id) || { id: id };
    const owner = donoReservaNormal(id) || texto(usuario && usuario.nome);
    const resetarBruto = texto(form.querySelector('[name="resetar"]')?.value || "");
    const resetar = /^(?:0|false|nao|não)$/i.test(resetarBruto) ? "" : resetarBruto;

    try {
      const resposta = await fetch(url.href, {
        method: "POST",
        body: coletarFormularioFinanceiroNormal(form, submitter),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "follow",
      });
      const corpo = await resposta.text();
      if (!resposta.ok) throw new Error("InfraDesk retornou HTTP " + resposta.status);
      if (/\/(?:login|entrar|signin)(?:[/?#]|$)/i.test(resposta.url || "")) {
        throw new Error("A sessão expirou. Confirme o login no InfraDesk.");
      }
      const tipo = texto(resposta.headers.get("content-type") || "");
      if (/application\/json/i.test(tipo)) {
        let json;
        try { json = JSON.parse(corpo); } catch (_) { throw new Error("Resposta JSON não pôde ser validada."); }
        if (!json || json.success !== true && json.sucesso !== true && json.ok !== true) {
          throw new Error(texto(json && (json.message || json.mensagem)) || "InfraDesk não confirmou a gravação.");
        }
      } else {
        const doc = new DOMParser().parseFromString(corpo, "text/html");
        const formularioDevolvido = Array.from(doc.querySelectorAll("form")).find(function (f) {
          return /\/backend\/despesas\/financeiro\/\d+/i.test(f.action || "")
            && idFormularioFinanceiroNormal(f) === id;
        });
        if (formularioDevolvido) {
          const modalBody = corpoPrincipalModal();
          const root = paginaWindow();
          const $ = root.jQuery || root.$ || window.jQuery || window.$;
          if (modalBody && $) {
            const area = formularioDevolvido.parentElement;
            const conteudo = area && area.tagName.toLowerCase() !== "body"
              ? area.outerHTML : formularioDevolvido.outerHTML;
            $(modalBody).empty().append(conteudo);
          }
          atualizarBotoesModalNormal();
          throw new Error("InfraDesk devolveu o formulário. Confira campos obrigatórios e mensagens de validação.");
        }
        if (doc.querySelector('form[action*="/login"], input[type="password"][name="password"]')) {
          throw new Error("InfraDesk devolveu tela de login; não marquei a despesa como concluída.");
        }
        // Critério de confirmação usado pelo painel: resposta HTTP 2xx
        // sem o formulário financeiro devolvido. Não conta falhas de validação.
      }

      // Somente após a resposta do InfraDesk, preserva o operador da ação.
      registrarConclusaoFinanceiraNormalConfirmada(id, item, usuario, owner, resetar);
      notificarPaginaPrincipal("success", "Despesa " + id + " gravada. Operador registrado na auditoria.");
      // A fila está salva no localStorage ANTES de recarregar. No próximo
      // carregamento continua o envio se o Firebase ficou indisponível.
      window.location.reload();
    } catch (falha) {
      console.error(PREFIXO, "Gravação normal com auditoria", falha);
      notificarPaginaPrincipal("error", "Não consegui confirmar a gravação: " + texto(falha.message || falha));
    } finally {
      form.dataset.sigmaFinanceiroEnviando = "0";
      if (botao && botao.isConnected) botao.disabled = false;
    }
  }

  function carregarConclusoesNormais() {
    try {
      const registros = JSON.parse(localStorage.getItem(CHAVE_CONCLUSOES_NORMAL) || "{}");
      return registros && typeof registros === "object" && !Array.isArray(registros) ? registros : {};
    } catch (_) { return {}; }
  }

  function salvarConclusoesNormais(registros) {
    try { localStorage.setItem(CHAVE_CONCLUSOES_NORMAL, JSON.stringify(registros)); }
    catch (falha) { console.error(PREFIXO, "Falha ao preservar conclusões pendentes", falha); }
  }

  function registrarConclusaoFinanceiraNormalConfirmada(id, item, usuario, owner, resetar) {
    const ts = Date.now();
    const nome = texto(usuario && usuario.nome);
    const payload = {
      status: resetar ? "retornada" : "concluida",
      etapa: resetar || "",
      usuario: nome,
      login: texto(usuario && usuario.login),
      usuarioId: texto(usuario && usuario.id),
      ts: ts,
      competencia: texto(item && item.competencia),
      fornecedor: texto(item && item.fornecedor),
      tipo_documento: texto(item && item.tipo),
      valor: texto(item && item.valor),
    };
    // Metadados e evento possuem trilhas persistentes próprias; nenhum DELETE.
    if (item) registrarMetadadosDespesa(item, owner || nome);
    registrarEventoHistorico(id, resetar ? "retorno" : "conclusao", usuario, owner, owner || nome);
    const registros = carregarConclusoesNormais();
    registros[id] = payload;
    salvarConclusoesNormais(registros);
    agendarReenvioConclusoesNormal(0);
  }

  function agendarReenvioConclusoesNormal(atraso) {
    if (normalState.timerConclusoes) clearTimeout(normalState.timerConclusoes);
    normalState.timerConclusoes = setTimeout(function () {
      normalState.timerConclusoes = null;
      void reenviarConclusoesNormais();
    }, Math.max(0, Number(atraso || 0)));
  }

  async function reenviarConclusoesNormais() {
    if (normalState.enviandoConclusoes) return;
    normalState.enviandoConclusoes = true;
    let falhaOcorreu = false;
    try {
      const registros = carregarConclusoesNormais();
      for (const id of Object.keys(registros).slice(0, 30)) {
        const payload = registros[id];
        if (!payload || !payload.ts || !payload.usuario) continue;
        try {
          const url = firebaseUrl(CONFIG.firebaseEstadoPainel + "/" + encodeURIComponent(id));
          let preservouMaisRecente = false;
          let gravou = false;
          for (let tentativa = 0; tentativa < 3; tentativa++) {
            const leitura = await gmRequest({
              method: "GET", url: url,
              headers: { "X-Firebase-ETag": "true", "Accept": "application/json" },
              timeout: 12000,
            });
            if (!leitura || leitura.status < 200 || leitura.status >= 300) {
              throw new Error("Consulta do histórico: HTTP " + (leitura ? leitura.status : "sem resposta"));
            }
            const anterior = parseJsonSeguro(leitura.responseText || "null", null);
            if (anterior && Number(anterior.ts || 0) >= Number(payload.ts)) {
              if (Number(anterior.ts || 0) === Number(payload.ts)
                  && texto(anterior.usuario) === texto(payload.usuario)
                  && texto(anterior.status) === texto(payload.status)) gravou = true;
              else preservouMaisRecente = true;
              break;
            }
            const headers = { "Content-Type": "application/json" };
            const etag = obterCabecalhoResposta(leitura, "etag");
            if (!etag) throw new Error("Sem ETag; atualização não será feita para proteger o operador histórico.");
            headers["If-Match"] = etag;
            const resposta = await gmRequest({
              method: "PUT", url: url, headers: headers,
              data: JSON.stringify(payload), timeout: 12000,
            });
            if (resposta && resposta.status === 412) continue;
            if (!resposta || resposta.status < 200 || resposta.status >= 300) {
              throw new Error("Arquivo de conclusão: HTTP " + (resposta ? resposta.status : "sem resposta"));
            }
            gravou = true;
            break;
          }
          if (!gravou && !preservouMaisRecente) throw new Error("Concorrência na atualização do histórico");
          // REGRA_RESERVA_PERMANENTE_V5_3_5:
          // Registrar conclusão não remove nem altera a reserva do operador.
          // Liberação/transferência é EXCLUSIVAMENTE manual para correções.
          const atuais = carregarConclusoesNormais();
          if (JSON.stringify(atuais[id]) === JSON.stringify(payload)) {
            delete atuais[id];
            salvarConclusoesNormais(atuais);
          }
        } catch (falha) {
          falhaOcorreu = true;
          console.warn(PREFIXO, "Conclusão permanece na fila para repetição: " + id, falha);
        }
      }
    } finally {
      normalState.enviandoConclusoes = false;
      if (Object.keys(carregarConclusoesNormais()).length) {
        agendarReenvioConclusoesNormal(falhaOcorreu ? 30000 : 800);
      }
    }
  }

  function notificarPaginaPrincipal(tipo, mensagem) {
    const root = paginaWindow();
    const toastr = root.toastr || window.toastr;
    if (toastr && typeof toastr[tipo] === "function") {
      toastr[tipo](mensagem);
      return;
    }
    if (tipo === "error" || tipo === "warning") window.alert(mensagem);
  }

  // =========================================================
  // PREPARAR_DOCUMENTO_SEM_TELA_BRANCA
  // Para localizar depois, use CTRL + F e procure por:
  // PREPARAR_DOCUMENTO_SEM_TELA_BRANCA
  // =========================================================
  function ocultarPaginaOriginal() {
    try {
      document.documentElement.style.setProperty("visibility", "hidden", "important");
      document.documentElement.style.setProperty("background", "#eef2f7", "important");
    } catch (_) {}
  }

  function revelarDocumento() {
    try {
      document.documentElement.style.removeProperty("visibility");
      document.documentElement.style.setProperty("background", "#eef2f7", "important");
    } catch (_) {}
  }

  function esperarDocumentoDisponivel() {
    if (document.body && document.readyState !== "loading") {
      return Promise.resolve();
    }

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
    montarDocumentoIndependente();
    revelarDocumento();

    atualizarStatus("Preparando os componentes do painel...");

    await incluirScript(
      "sigma-jquery-base",
      "/js/jquery-2.1.1.js",
      function () {
        const w = paginaWindow();
        return !!(w.jQuery && w.jQuery.fn);
      }
    );

    await incluirScript(
      "sigma-bootstrap-base",
      "/js/bootstrap.min.js",
      function () {
        const w = paginaWindow();
        return !!(w.jQuery && w.jQuery.fn && typeof w.jQuery.fn.modal === "function");
      }
    );

    await iniciarPainel();
  }

  // =========================================================
  // DOCUMENTO_INDEPENDENTE
  // Esta é uma página criada pelo Tampermonkey. O InfraDesk fica
  // apenas como fonte dos dados e como responsável por gravá-los.
  // =========================================================
  function montarDocumentoIndependente() {
    const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Painel Financeiro • InfraDesk</title>
  <link rel="icon" href="https://cdn.infradesk.app/favicon.ico">
  <link rel="stylesheet" href="/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/select2/4.0.13/css/select2.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
  <style id="sigma-painel-financeiro-css">
    :root {
      --sigma-bg: #eef2f7;
      --sigma-card: #ffffff;
      --sigma-dark: #111c32;
      --sigma-dark-2: #192641;
      --sigma-border: #d8e0ea;
      --sigma-text: #172033;
      --sigma-muted: #64748b;
      --sigma-green: #12865d;
      --sigma-blue: #2563eb;
      --sigma-red: #dc2626;
      --sigma-yellow: #d97706;
    }

    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body {
      overflow: hidden;
      background: var(--sigma-bg);
      color: var(--sigma-text);
      font-family: "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
    }

    button, input, select { font: inherit; }

    /* Oculta somente o atalho criado por uma versão antiga do painel. */
    #sigma-abrir-painel-financeiro { display: none !important; }

    #sigma-app {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100vh;
      padding: 8px;
      gap: 7px;
    }

    .sigma-topo {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-height: 52px;
      padding: 8px 12px;
      border-radius: 12px;
      background: var(--sigma-dark);
      color: #fff;
      box-shadow: 0 8px 24px rgba(15, 23, 42, .18);
    }

    .sigma-marca {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 10px;
    }

    .sigma-marca-icone {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      flex: 0 0 auto;
      border-radius: 10px;
      background: rgba(34, 197, 94, .17);
      color: #86efac;
      font-size: 18px;
    }

    .sigma-marca strong { display: block; font-size: 14px; line-height: 18px; }
    .sigma-marca small {
      display: block;
      overflow: hidden;
      max-width: 620px;
      color: #b8c5d8;
      font-size: 11px;
      line-height: 15px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .sigma-topo-acoes {
      display: flex;
      align-items: center;
      gap: 7px;
      flex: 0 0 auto;
    }

    .sigma-abas {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 3px;
      border-radius: 10px;
      background: rgba(255, 255, 255, .08);
    }

    .sigma-aba {
      min-height: 29px;
      padding: 0 11px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: #cbd5e1;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }

    .sigma-aba:hover {
      background: rgba(255, 255, 255, .08);
      color: #fff;
    }

    .sigma-aba.ativo {
      background: #fff;
      color: #172033;
      box-shadow: 0 2px 8px rgba(15, 23, 42, .22);
    }

    .sigma-aba:disabled {
      opacity: .55;
      cursor: wait;
    }

    .sigma-usuario {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 31px;
      padding: 0 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .09);
      color: #e5edf8;
      font-size: 11px;
      font-weight: 600;
    }

    .sigma-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      height: 32px;
      padding: 0 11px;
      border: 1px solid rgba(255, 255, 255, .14);
      border-radius: 8px;
      background: rgba(255, 255, 255, .09);
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }

    .sigma-btn:hover { background: rgba(255, 255, 255, .16); }
    .sigma-btn:disabled { opacity: .48; cursor: wait; }

    /* FILTROS_NAO_ENCOLHEM
       CTRL + F: FILTROS_NAO_ENCOLHEM
       O painel é um flex vertical. Quando a grade ganhava muitas linhas,
       o navegador podia encolher este bloco e cortar inputs/selects,
       deixando visíveis somente os rótulos. Filtros, topo e resumo agora
       preservam a própria altura; somente a grade ocupa o espaço restante. */
    .sigma-topo,
    .sigma-filtros,
    .sigma-resumo {
      flex: 0 0 auto;
    }

    .sigma-filtros {
      min-height: 59px;
      padding: 8px 10px;
      overflow-x: auto;
      overflow-y: hidden;
      border: 1px solid var(--sigma-border);
      border-radius: 11px;
      background: var(--sigma-card);
      box-shadow: 0 5px 18px rgba(15, 23, 42, .06);
    }

    /* FILTROS_EM_UMA_LINHA
       CTRL + F: FILTROS_EM_UMA_LINHA
       Competência, Tipo e Responsável ficam compactos (130px).
       Em telas menores preferimos rolagem horizontal a quebrar os filtros. */
    .sigma-filtros-linha {
      display: grid;
      grid-template-columns:
        minmax(280px, 1.65fr)
        130px
        minmax(220px, 1.15fr)
        minmax(210px, 1fr)
        130px
        130px
        165px;
      gap: 7px;
      align-items: end;
      min-width: 1305px;
    }

    .sigma-campo label {
      display: block;
      margin: 0 0 3px;
      color: #475569;
      font-size: 10px;
      font-weight: 700;
    }

    /* Os filtros do painel são propositalmente nativos.
       O InfraDesk tenta transformar qualquer SELECT em Select2; isso criava
       atraso, texto visual diferente do valor real e filtros aparentemente
       incorretos. No painel, Select2 fica reservado somente para o modal. */
    #sigma-app .sigma-filtros .select2-container {
      display: none !important;
    }
    #sigma-app .sigma-filtros select,
    #sigma-app .sigma-filtros select.select2-hidden-accessible {
      position: static !important;
      display: block !important;
      clip: auto !important;
      width: 100% !important;
      height: 32px !important;
      margin: 0 !important;
      overflow: hidden !important;
      white-space: nowrap !important;
      text-overflow: ellipsis !important;
      opacity: 1 !important;
    }

    .sigma-campo input,
    .sigma-campo select {
      width: 100%;
      height: 32px;
      padding: 0 9px;
      border: 1px solid #cbd5e1;
      border-radius: 7px;
      background: #fff;
      color: #1e293b;
      outline: none;
      font-size: 11px;
    }

    .sigma-campo input:focus,
    .sigma-campo select:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, .12);
    }

    .sigma-resumo {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 36px;
      padding: 4px 8px;
      border: 1px solid var(--sigma-border);
      border-radius: 10px;
      background: #fff;
    }

    .sigma-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .sigma-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-height: 26px;
      padding: 0 9px;
      border: 1px solid #dbe3ec;
      border-radius: 999px;
      background: #f8fafc;
      color: #475569;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
    }
    .sigma-chip:hover, .sigma-chip.ativo { border-color: #2563eb; background: #eff6ff; color: #1d4ed8; }
    .sigma-chip b { color: #0f172a; }

    #sigma-status-carregamento {
      color: #64748b;
      font-size: 10px;
      font-weight: 600;
      white-space: nowrap;
    }

    .sigma-grade-wrap {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--sigma-border);
      border-radius: 11px;
      background: #fff;
      box-shadow: 0 7px 22px rgba(15, 23, 42, .07);
    }

    .sigma-grade {
      width: 100%;
      min-width: 1160px;
      border-collapse: separate;
      border-spacing: 0;
    }

    .sigma-grade thead th {
      position: sticky;
      top: 0;
      z-index: 20;
      padding: 9px 8px;
      border: 0;
      border-bottom: 2px solid #dbe5ef;
      background: #fff;
      color: #1c84c6;
      font-size: 11px;
      font-weight: 700;
      text-align: left;
      white-space: nowrap;
      box-shadow: 0 1px 0 rgba(15, 23, 42, .03);
    }

    .sigma-grade tbody td {
      padding: 7px 8px;
      border-top: 1px solid #e7edf4;
      color: #475569;
      font-size: 12px;
      vertical-align: middle;
    }

    .sigma-grade tbody tr.sigma-despesa:hover td,
    .sigma-grade tbody tr.sigma-despesa-dados:hover td,
    .sigma-grade tbody tr.sigma-despesa-rodape:hover td,
    .sigma-grade tbody tr.sigma-observacoes:hover td { background: #f7faff; }

    /* BORDA_CARD_DESPESA
       CTRL + F: BORDA_CARD_DESPESA
       O contorno EXTERNO é propositalmente mais forte que as divisórias
       internas. Assim fica evidente onde cada despesa começa e termina. */
    .sigma-despesa-meta td {
      padding: 5px 8px !important;
      border-top: 2px solid #94a3b8 !important;
      border-left: 2px solid #94a3b8 !important;
      border-right: 2px solid #94a3b8 !important;
      border-radius: 7px 7px 0 0;
      background: #fbfdff;
      box-shadow: 0 -1px 0 rgba(15, 23, 42, .04);
    }

    .sigma-despesa-dados td {
      border-top: 1px solid #e2e8f0 !important;
    }
    .sigma-despesa-dados td:first-child { border-left: 2px solid #94a3b8 !important; }
    .sigma-despesa-dados td:last-child { border-right: 2px solid #94a3b8 !important; }

    .sigma-meta-linha {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }

    .sigma-meta-esquerda,
    .sigma-meta-direita {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-wrap: wrap;
    }

    .sigma-numero-id {
      color: #0f172a;
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
    }

    .sigma-fluxo {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      background: #f1f5f9;
      color: #475569;
      font-size: 10px;
      font-weight: 600;
      white-space: nowrap;
    }

    .sigma-fluxo strong {
      color: #1e293b;
      font-weight: 700;
    }

    .sigma-despesa-rodape td {
      padding: 5px 8px !important;
      border-top: 1px solid #e2e8f0 !important;
      border-left: 2px solid #94a3b8 !important;
      border-right: 2px solid #94a3b8 !important;
      background: #fff;
    }
    .sigma-despesa-rodape.sem-observacao td {
      border-bottom: 2px solid #94a3b8 !important;
      border-radius: 0 0 7px 7px;
      box-shadow: 0 2px 4px rgba(15, 23, 42, .06);
    }

    .sigma-rodape-linha {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-wrap: nowrap;
    }

    .sigma-plano-conta {
      overflow: hidden;
      color: #334155;
      font-size: 11px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sigma-plano-conta strong {
      color: #0f172a;
      font-weight: 700;
    }

    .sigma-setor-contratante {
      overflow: hidden;
      color: #475569;
      font-size: 11px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sigma-setor-contratante::before {
      content: "•";
      margin-right: 8px;
      color: #94a3b8;
      font-weight: 700;
    }
    .sigma-setor-contratante strong {
      color: #0f172a;
      font-weight: 700;
    }

    .sigma-pgto-antecipado {
      display: inline-flex;
      align-items: center;
      min-height: 21px;
      margin-top: 4px;
      padding: 2px 7px;
      border-radius: 999px;
      background: #fee2e2;
      color: #b91c1c;
      font-size: 9px;
      font-weight: 700;
      white-space: nowrap;
    }
    .sigma-grade tbody tr.sigma-grupo td {
      position: sticky;
      top: 33px;
      z-index: 10;
      padding: 7px 10px;
      border-top: 1px solid #cbd5e1;
      background: #e9eff7;
      color: #172033;
      font-size: 11px;
      font-weight: 700;
    }

    .sigma-id p { display: inline; margin: 0; color: #172033; font-size: 13px; font-weight: 700; }
    .sigma-id small { display: block; margin-top: 2px; color: #64748b; font-size: 11px; font-weight: 600; }
    .sigma-desc { max-width: 320px; color: #243247; font-size: 12px; font-weight: 600; }
    .sigma-fornecedor { max-width: 270px; font-size: 12px; font-weight: 600; }
    .sigma-tipo { white-space: nowrap; }
    .sigma-tipo-conteudo {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .sigma-tipo-img {
      width: 25px;
      max-height: 25px;
      object-fit: contain;
      flex: 0 0 auto;
    }
    .sigma-tipo-texto {
      overflow: hidden;
      max-width: 150px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sigma-tipo-extra {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: #7c3aed;
      font-size: 17px;
      flex: 0 0 auto;
    }
    .sigma-status-mini {
      display: inline-block;
      max-width: 112px;
      margin-top: 3px;
      padding: 2px 6px;
      overflow: hidden;
      border-radius: 999px;
      background: #e0f2fe;
      color: #075985;
      font-size: 8px;
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
      vertical-align: middle;
    }
    .sigma-data { white-space: nowrap; font-size: 12px; font-weight: 600; }
    /* A cor por faixa de vencimento é responsabilidade do Tampermonkey
       InfraDesk Assistente, evitando duas regras visuais diferentes. */
    .sigma-data.vencida,
    .sigma-data.hoje { color: inherit; }
    .sigma-valor { white-space: nowrap; color: #172033; font-family: "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 700; }

    .sigma-competencia {
      display: inline-flex;
      align-items: center;
      min-height: 23px;
      padding: 0 8px;
      border-radius: 999px;
      background: #e0e7ff;
      color: #3730a3;
      font-size: 10px;
      font-weight: 700;
      white-space: nowrap;
    }

    .sigma-owner {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 180px;
      min-height: 25px;
      padding: 0 8px;
      border: 1px solid #cbd5e1;
      border-radius: 999px;
      background: #fff;
      color: #475569;
      font-size: 10px;
      font-weight: 700;
      white-space: nowrap;
    }

    .sigma-owner button {
      width: 17px;
      height: 17px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: rgba(255,255,255,.28);
      color: inherit;
      line-height: 17px;
      cursor: pointer;
    }

    .sigma-owner button.sigma-owner-reservar {
      width: 19px;
      height: 19px;
      background: #2563eb;
      color: #fff;
      font-size: 15px;
      line-height: 18px;
      box-shadow: 0 2px 6px rgba(37,99,235,.28);
    }

    .sigma-owner button:hover:not(:disabled) {
      filter: brightness(1.08);
      transform: translateY(-1px);
    }

    .sigma-owner button:disabled {
      cursor: wait;
      opacity: .62;
    }

    .sigma-financeiro {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 35px !important;
      min-width: 35px !important;
      height: 31px !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 8px !important;
      background: var(--sigma-green) !important;
      color: #fff !important;
      font-size: 14px !important;
      cursor: pointer !important;
      box-shadow: 0 3px 9px rgba(18, 134, 93, .22) !important;
    }

    .sigma-financeiro:hover { background: #0b6b49 !important; }
    .sigma-financeiro:disabled,
    .sigma-financeiro.tm-finance-blocked {
      opacity: .35 !important;
      cursor: not-allowed !important;
      filter: grayscale(1) !important;
    }

    .sigma-observacoes td {
      padding: 5px 8px 6px !important;
      border-top: 1px solid #e2e8f0 !important;
      border-left: 2px solid #94a3b8 !important;
      border-right: 2px solid #94a3b8 !important;
      border-bottom: 2px solid #94a3b8 !important;
      border-radius: 0 0 7px 7px;
      background: #fff;
      box-shadow: 0 2px 4px rgba(15, 23, 42, .06);
    }
    .sigma-observacao {
      display: block;
      width: 100%;
      max-width: 100%;
      margin: 0;
      padding: 4px 8px;
      border-left: 3px solid #8b5cf6;
      border-radius: 4px;
      background: #f3e8ff;
      color: #6b21a8;
      font-size: 10px;
      line-height: 1.3;
    }
    .sigma-card-separador td {
      height: 9px;
      padding: 0 !important;
      border: 0 !important;
      background: transparent !important;
    }

    .sigma-vazio,
    .sigma-loading {
      padding: 60px 20px !important;
      color: #64748b !important;
      text-align: center !important;
      font-size: 13px !important;
    }

    .sigma-loading i { margin-right: 8px; color: #12865d; }

    /* Proteção visual caso uma versão antiga ainda esteja ativa. */
    #sigma-app .tm-op-inline { display: none !important; }

    #ModalDespesas { z-index: 999990 !important; }
    body > .modal-backdrop { z-index: 999980 !important; }
    #ModalDespesas > .modal-dialog {
      width: calc(100vw - 42px) !important;
      max-width: 1500px !important;
      height: calc(100vh - 24px) !important;
      margin: 12px auto !important;
    }
    #ModalDespesas > .modal-dialog > .modal-content {
      position: relative !important;
      height: 100% !important;
      border: 0 !important;
      border-radius: 13px !important;
      overflow: hidden !important;
    }
    #ModalDespesas > .modal-dialog > .modal-content > .modal-body {
      width: 100% !important;
      height: 100% !important;
      max-height: none !important;
      background: #f7f9fc !important;
    }
    #ModalDespesas > .modal-dialog > .modal-content > .modal-body.sigma-modal-body-novo {
      overflow: hidden !important;
      padding: 0 !important;
    }
    #ModalDespesas > .modal-dialog > .modal-content > .modal-body:not(.sigma-modal-body-novo) {
      overflow: auto !important;
      padding: 13px !important;
    }
    #ModalDespesas .sigma-modal-shell-carregando {
      height: 100%;
      overflow: auto;
      padding: 14px;
      background: #f7f9fc;
    }
    #ModalDespesas .sigma-modal-body-novo > form.form-financeiro {
      display: block;
      width: 100%;
      height: 100%;
      margin: 0;
    }
    #ModalDespesas .despesa-modal-layout {
      display: flex !important;
      flex-direction: column !important;
      width: 100% !important;
      height: 100% !important;
      max-height: 100% !important;
      min-height: 0 !important;
    }
    #ModalDespesas .despesa-modal-header,
    #ModalDespesas .despesa-modal-footer {
      flex: 0 0 auto !important;
    }
    #ModalDespesas .despesa-modal-scroll {
      flex: 1 1 auto !important;
      min-height: 0 !important;
      overflow-x: hidden !important;
      overflow-y: auto !important;
      overscroll-behavior: contain;
    }
    #ModalDespesas .sigma-modal-observacao {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      width: auto;
      min-width: 0;
      margin: 12px 15px 6px;
      padding: 8px 10px;
      border-left: 5px solid #8b5cf6;
      border-radius: 8px;
      background: #ead8ff;
      color: #5b21b6;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    #ModalDespesas .sigma-modal-observacao--carregando {
      margin: 0 0 12px;
    }
    #ModalDespesas .sigma-modal-observacao i {
      flex: 0 0 auto;
      margin-top: 2px;
      color: #7c3aed;
      font-size: 14px;
    }
    #ModalDespesas .sigma-modal-observacao-texto { min-width: 0; }
    #ModalDespesas .sigma-modal-observacao-texto strong {
      display: inline;
      margin-right: 4px;
      color: #4c1d95;
    }
    #ModalDespesas .btn-default { display: inline-block !important; }
    #ModalDespesas #btns-voltar { display: inline-flex !important; align-items: center; }
    #ModalDespesas .dropdown-menu { z-index: 1000100 !important; }
    #ModalDespesas .select2-container, #ModalDespesas .select2-dropdown { z-index: 1000200 !important; }
    #ModalDespesas #financeiro-observacao {
      border: 2px solid #8b5cf6 !important;
      background: #faf7ff !important;
      font-weight: 700 !important;
    }

    #sigma-modal-salvando {
      position: absolute;
      inset: 0;
      z-index: 1000300;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(15, 23, 42, .72);
      backdrop-filter: blur(2px);
    }
    #sigma-modal-salvando.ativo { display: flex; }
    #sigma-modal-salvando .sigma-salvando-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      min-width: 300px;
      max-width: 520px;
      padding: 22px 26px;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 14px;
      background: #ffffff;
      color: #172033;
      text-align: center;
      box-shadow: 0 24px 70px rgba(0,0,0,.34);
    }
    #sigma-modal-salvando .sigma-salvando-icone {
      color: #12865d;
      font-size: 34px;
    }
    #sigma-modal-salvando strong { font-size: 15px; }
    #sigma-modal-salvando small {
      color: #64748b;
      font-size: 11px;
      line-height: 1.45;
    }

    #sigma-toast {
      position: fixed;
      right: 18px;
      bottom: 55px;
      z-index: 2000000;
      display: none;
      max-width: 430px;
      padding: 11px 14px;
      border-radius: 10px;
      background: #0f172a;
      color: #fff;
      box-shadow: 0 14px 35px rgba(0,0,0,.27);
      font-size: 11px;
      font-weight: 600;
    }
    #sigma-toast.erro { background: #991b1b; }
    #sigma-toast.sucesso { background: #166534; }

    @media (max-width: 1450px) {
      .sigma-filtros { padding-bottom: 7px; }
    }
  </style>
</head>
<body>
  <div id="sigma-app">
    <header class="sigma-topo">
      <div class="sigma-marca">
        <span class="sigma-marca-icone"><i class="fa-solid fa-money-check-dollar"></i></span>
        <span>
          <strong>Painel Financeiro Unificado</strong>
          <small>Agendamento e pendências do InfraDesk • carregamento por aba • v${CONFIG.versao}</small>
        </span>
      </div>
      <div class="sigma-topo-acoes">
        <div class="sigma-abas" role="tablist" aria-label="Filas do painel">
          <button class="sigma-aba ativo" type="button" data-aba-painel="agendar"><i class="fa-regular fa-calendar-check"></i> Agendar pagamento</button>
          <button class="sigma-aba" type="button" data-aba-painel="pendentes"><i class="fa-solid fa-inbox"></i> Pendentes</button>
        </div>
        <span class="sigma-usuario" id="sigma-usuario"><i class="fa-solid fa-user"></i> Identificando usuário...</span>
        <button class="sigma-btn" id="sigma-atualizar" type="button"><i class="fa-solid fa-rotate"></i> Atualizar InfraDesk</button>
        <button class="sigma-btn" id="sigma-gerar-relatorio" type="button"><i class="fa-solid fa-print"></i> Gerar relatório</button>
        <a class="sigma-btn" href="/backend/despesas" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i> Tela original</a>
      </div>
    </header>

    <section class="sigma-filtros">
      <div class="sigma-filtros-linha">
        <div class="sigma-campo">
          <label>Buscar ID, documento, descrição ou fornecedor</label>
          <input id="sigma-busca" type="search" placeholder="Digite para filtrar instantaneamente...">
        </div>
        <div class="sigma-campo">
          <label>Competência</label>
          <select id="sigma-filtro-competencia"><option value="">Todas</option></select>
        </div>
        <div class="sigma-campo">
          <label>Setor Contratante</label>
          <select id="sigma-filtro-setor"><option value="">Todos</option></select>
        </div>
        <div class="sigma-campo">
          <label>Fornecedor</label>
          <select id="sigma-filtro-fornecedor"><option value="">Todos</option></select>
        </div>
        <div class="sigma-campo">
          <label>Tipo de documento</label>
          <select id="sigma-filtro-tipo"><option value="">Todos</option></select>
        </div>
        <div class="sigma-campo">
          <label>Responsável</label>
          <select id="sigma-filtro-owner"><option value="">Todos</option></select>
        </div>
        <div class="sigma-campo">
          <label>Organizar por</label>
          <select id="sigma-organizacao">
            <option value="competencia">Competência → vencimento</option>
            <option value="fornecedor">Fornecedor → competência</option>
            <option value="tipo">Tipo → competência</option>
            <option value="responsavel">Responsável → competência</option>
            <option value="vencimento">Vencimento direto</option>
          </select>
        </div>
      </div>
    </section>

    <section class="sigma-resumo">
      <div class="sigma-chips">
        <button class="sigma-chip ativo" type="button" data-situacao="todas">Todas <b id="sigma-total">0</b></button>
        <button class="sigma-chip" type="button" data-situacao="livres">Livres + minhas <b id="sigma-livres">0</b></button>
        <button class="sigma-chip" type="button" data-situacao="minhas">Minhas <b id="sigma-minhas">0</b></button>
        <button class="sigma-chip" type="button" data-situacao="reservadas">Reservadas <b id="sigma-reservadas">0</b></button>
        <button class="sigma-chip" type="button" data-situacao="vencidas">Vencidas <b id="sigma-vencidas">0</b></button>
      </div>
      <span id="sigma-status-carregamento">Preparando painel...</span>
    </section>

    <main class="sigma-grade-wrap">
      <table class="sigma-grade" id="sigma-tabela">
        <thead>
          <tr>
            <th style="width:225px">Nº Documento</th>
            <th>Descrição</th>
            <th>Fornecedor</th>
            <th style="width:165px">Tipo</th>
            <th style="width:95px">Emissão</th>
            <th style="width:95px">Vencimento</th>
            <th style="width:110px">Valor</th>
            <th style="width:155px">Responsável</th>
            <th style="width:58px;text-align:center">Abrir</th>
          </tr>
        </thead>
        <tbody id="sigma-corpo-tabela">
          <tr><td colspan="9" class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Carregando fila financeira...</td></tr>
        </tbody>
      </table>
    </main>
  </div>

  <div id="ModalDespesas" class="modal fade" tabindex="-1" role="dialog" aria-hidden="true">
    <div class="modal-dialog modal-xl modal-despesas-dialog" role="document">
      <div class="modal-content">
        <div class="modal-body sigma-modal-body-novo">
          <div class="sigma-modal-shell-carregando">
            <div class="sigma-modal-observacao sigma-modal-observacao--carregando" id="sigma-modal-observacao">
              <i class="fa-solid fa-comment-dots"></i>
              <span class="sigma-modal-observacao-texto"><strong>Observação:</strong> Carregando...</span>
            </div>
            <div class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Aguardando despesa...</div>
          </div>
        </div>
        <div id="sigma-modal-salvando" aria-live="polite" aria-hidden="true">
          <div class="sigma-salvando-card">
            <i class="fa-solid fa-circle-notch fa-spin sigma-salvando-icone"></i>
            <strong id="sigma-salvando-titulo">Gravando no InfraDesk...</strong>
            <small id="sigma-salvando-detalhe">Aguarde a confirmação antes de fechar esta janela.</small>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="sigma-toast"></div>

  <script src="/js/jquery-2.1.1.js"></script>
  <script src="/js/bootstrap.min.js"></script>
</body>
</html>`;

    const novoDocumento = new DOMParser().parseFromString(html, "text/html");

    // Scripts inseridos com innerHTML não executam. Eles são carregados
    // explicitamente em prepararPainel(), com tratamento de erro.
    novoDocumento.querySelectorAll("script").forEach(function (script) {
      script.remove();
    });

    document.documentElement.lang = "pt-BR";
    document.title = "Painel Financeiro • InfraDesk";
    document.head.innerHTML = novoDocumento.head.innerHTML;
    document.body.className = "";
    document.body.removeAttribute("style");
    document.body.innerHTML = novoDocumento.body.innerHTML;
  }

  // =========================================================
  // UTILITARIOS
  // =========================================================
  function log(...args) {
    console.log(PREFIXO, ...args);
  }

  function texto(valor) {
    return String(valor == null ? "" : valor).replace(/\s+/g, " ").trim();
  }

  function normalizar(valor) {
    return texto(valor)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function escaparHtml(valor) {
    return String(valor == null ? "" : valor)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escaparCss(valor) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(valor == null ? "" : valor));
    }
    return String(valor == null ? "" : valor).replace(/["\\]/g, "\\$&");
  }

  function paginaWindow() {
    return typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  }

  function esperar(condicao, limiteMs = 20000, intervalo = 60) {
    return new Promise(function (resolve, reject) {
      const inicio = Date.now();
      const verificar = function () {
        try {
          const valor = condicao();
          if (valor) {
            resolve(valor);
            return;
          }
        } catch (_) {}

        if (Date.now() - inicio > limiteMs) {
          reject(new Error("Tempo esgotado ao preparar a tela."));
          return;
        }
        setTimeout(verificar, intervalo);
      };
      verificar();
    });
  }

  function toast(mensagem, tipo = "") {
    const el = document.getElementById("sigma-toast");
    if (!el) return;
    el.textContent = mensagem;
    el.className = tipo;
    el.style.display = "block";
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () {
      el.style.display = "none";
    }, 4200);
  }

  function parseDataBr(valor) {
    const match = texto(valor).match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
    if (!match) return null;
    let ano = Number(match[3]);
    if (ano < 100) ano += 2000;
    const data = new Date(ano, Number(match[2]) - 1, Number(match[1]));
    if (Number.isNaN(data.getTime())) return null;
    return data;
  }

  function chaveCompetencia(data) {
    if (!data) return "Sem competência";
    return String(data.getMonth() + 1).padStart(2, "0") + "/" + data.getFullYear();
  }

  function chaveData(data) {
    return data ? data.getTime() : Number.MAX_SAFE_INTEGER;
  }

  function inicioHoje() {
    const agora = new Date();
    return new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  }

  function diasPara(data) {
    if (!data) return null;
    const alvo = new Date(data.getFullYear(), data.getMonth(), data.getDate());
    return Math.round((alvo.getTime() - inicioHoje().getTime()) / 86400000);
  }

  function corUsuario(nome) {
    nome = texto(nome);
    if (!nome) return "#ffffff";
    if (CONFIG.coresUsuarios[nome]) return CONFIG.coresUsuarios[nome];
    let hash = 0;
    const key = normalizar(nome);
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(hash) % 360} 68% 44%)`;
  }

  function mesmaPessoa(a, b) {
    return normalizar(a) && normalizar(a) === normalizar(b);
  }

  // =========================================================
  // INICIALIZACAO
  // =========================================================
  async function iniciarPainel() {
    await esperar(function () {
      return document.body && paginaWindow().jQuery && paginaWindow().jQuery.fn;
    });

    iniciarFilaMetadados();
    configurarEventosDaTela();
    atualizarAbasPainel();
    forcarFiltrosNativos();
    criarObservadorDoModal();

    // Antes da consulta restauramos somente o que já possui opções fixas:
    // organização, busca e situação. Os filtros dependentes dos dados
    // serão restaurados uma única vez após todas as páginas terminarem.
    restaurarPreferenciasPainel(true);

    // Cada conexão em tempo real já entrega o estado inicial completo.
    // Assim evitamos fazer um GET e baixar o mesmo conteúdo novamente
    // ao abrir o EventSource logo em seguida.
    await Promise.all([
      conectarRealtimeReservas(),
      conectarRealtimeEstados(),
      carregarTodasDespesas(),
    ]);

    // HISTORICO_SEM_APAGAR_V5_3_3:
    // A limpeza anterior removia conclusões antigas de estado/by_id. Como
    // esses registros contêm ações e usuários históricos, NÃO apagamos nada
    // automaticamente. A validade de 12h continua sendo respeitada apenas
    // na leitura da fila por estaFinalizadaRecentemente().
    // Não chamar limparEstadosFirebaseExpirados().

    reconstruirOpcoesFiltros();
    restaurarPreferenciasPainel(false);
    state.filtrosProntos = true;
    state.inicializando = false;

    // Reenvia em segundo plano qualquer conclusão que o InfraDesk confirmou,
    // mas cuja atualização do Firebase ficou pendente por falha de rede.
    agendarSincronizacaoFirebase(0);

    renderizar();
    state.renderPendente = false;
  }

  function forcarFiltrosNativos() {
    const filtros = document.querySelector("#sigma-app .sigma-filtros");
    if (!filtros) return;

    let agendado = false;
    const limparSelect2 = function () {
      if (state.destruindoSelect2) return;
      state.destruindoSelect2 = true;

      try {
        const root = paginaWindow();
        const $ = root.jQuery || root.$ || window.jQuery || window.$;

        filtros.querySelectorAll("select").forEach(function (select) {
          if ($ && $.fn && typeof $.fn.select2 === "function" && select.classList.contains("select2-hidden-accessible")) {
            try { $(select).select2("destroy"); } catch (_) {}
          }

          // Evita realimentar o MutationObserver com alterações de class
          // desnecessárias: um filtro nativo não precisa ser refeito.
          if (select.classList.contains("select2-hidden-accessible")) {
            select.classList.remove("select2-hidden-accessible");
          }
          for (const atributo of ["data-select2-id", "tabindex", "aria-hidden"]) {
            if (select.hasAttribute(atributo)) select.removeAttribute(atributo);
          }
          for (const propriedade of ["position", "width"]) {
            if (select.style.getPropertyValue(propriedade)) select.style.removeProperty(propriedade);
          }

          const proximo = select.nextElementSibling;
          if (proximo && proximo.classList && proximo.classList.contains("select2")) {
            proximo.remove();
          }
        });

        filtros.querySelectorAll(".select2-container").forEach(function (container) {
          container.remove();
        });
      } finally {
        state.destruindoSelect2 = false;
      }
    };

    const agendarLimpeza = function () {
      if (agendado) return;
      agendado = true;
      requestAnimationFrame(function () {
        agendado = false;
        limparSelect2();
      });
    };

    limparSelect2();
    const observer = new MutationObserver(agendarLimpeza);
    observer.observe(filtros, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }


  // =========================================================
  // RELATORIO_FINANCEIRO_PDF
  // CTRL + F: RELATORIO_FINANCEIRO_PDF
  //
  // Gera uma página A4 paisagem usando EXATAMENTE as despesas que
  // estão visíveis pelos filtros atuais. O navegador faz a impressão
  // ou "Salvar como PDF"; não há biblioteca de PDF nem nova consulta.
  // =========================================================
  function valorBRLNumero(valor) {
    const limpo = texto(valor)
      .replace(/R\$\s*/gi, "")
      .replace(/\./g, "")
      .replace(",", ".")
      .replace(/[^\d.-]/g, "");
    const numero = Number(limpo);
    return Number.isFinite(numero) ? numero : 0;
  }

  function nomeCriadorRelatorio(item) {
    const fluxo = item && item.fluxo ? item.fluxo : {};
    return texto(fluxo.criado && fluxo.criado.usuario ? fluxo.criado.usuario : "") || "—";
  }

  function resumoFiltrosRelatorio() {
    const partes = [];
    const busca = valorFiltro("sigma-busca");
    const competencia = valorFiltro("sigma-filtro-competencia");
    const setor = valorFiltro("sigma-filtro-setor");
    const fornecedor = valorFiltro("sigma-filtro-fornecedor");
    const tipo = valorFiltro("sigma-filtro-tipo");
    const responsavel = valorFiltro("sigma-filtro-owner");
    const situacao = situacaoAtual();

    if (busca) partes.push("Busca: " + busca);
    if (competencia) partes.push("Competência: " + competencia);
    if (setor) partes.push("Setor: " + setor);
    if (fornecedor) partes.push("Fornecedor: " + fornecedor);
    if (tipo) partes.push("Tipo: " + tipo);
    if (responsavel) partes.push("Responsável: " + (responsavel === "__livre__" ? "Sem usuário" : responsavel));
    if (situacao && situacao !== "todas") partes.push("Situação: " + situacao);

    return partes.length ? partes.join(" • ") : "Sem filtros adicionais";
  }

  function abrirRelatorioFinanceiro() {
    const lista = despesasVisiveis().slice();
    const organizacao = valorFiltro("sigma-organizacao") || "competencia";
    ordenarLista(lista, organizacao);

    if (!lista.length) {
      toast("Não há despesas visíveis para gerar o relatório.", "erro");
      return;
    }

    const janela = window.open("", "_blank");
    if (!janela) {
      toast("O navegador bloqueou a janela do relatório. Libere pop-ups para o InfraDesk.", "erro");
      return;
    }

    try { janela.opener = null; } catch (_) {}

    const total = lista.reduce(function (soma, item) {
      return soma + valorBRLNumero(item.valor);
    }, 0);

    const totalFormatado = total.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });

    const linhas = lista.map(function (item) {
      return `
        <tr>
          <td class="numero">${escaparHtml(item.id || "—")}</td>
          <td>${escaparHtml(nomeCriadorRelatorio(item))}</td>
          <td class="setor">${escaparHtml(item.setorContratante || "—")}</td>
          <td><span class="status">${escaparHtml(item.statusTexto || "—")}</span></td>
          <td>${escaparHtml(item.numeroDocumento || "—")}</td>
          <td class="fornecedor">${escaparHtml(item.fornecedor || "—")}</td>
          <td class="valor">${escaparHtml(item.valor || "—")}</td>
          <td class="data">${escaparHtml(item.vencimentoTexto || "—")}</td>
        </tr>`;
    }).join("");

    const geradoEm = new Date().toLocaleString("pt-BR");
    const tituloAba = nomeAba(state.abaAtual);
    const filtros = resumoFiltrosRelatorio();

    const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Relatório Financeiro • InfraDesk</title>
  <style>
    @page { size: A4 landscape; margin: 9mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f3f6f9;
      color: #334155;
      font-family: "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 11px;
    }
    .pagina {
      width: 100%;
      padding: 18px;
    }
    .topo {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 12px;
      padding: 14px 16px;
      border: 1px solid #dbe5ef;
      border-radius: 8px;
      background: #fff;
    }
    h1 {
      margin: 0 0 4px;
      color: #1c84c6;
      font-size: 20px;
      font-weight: 700;
    }
    .subtitulo { color: #64748b; font-size: 11px; }
    .meta { color: #64748b; text-align: right; line-height: 1.6; white-space: nowrap; }
    .filtros {
      margin-bottom: 10px;
      padding: 8px 10px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      background: #fff;
      color: #475569;
    }
    .acoes {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 10px;
    }
    button {
      height: 34px;
      padding: 0 14px;
      border: 0;
      border-radius: 6px;
      background: #1c84c6;
      color: #fff;
      font: 700 11px "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
      cursor: pointer;
    }
    .tabela-wrap {
      overflow: hidden;
      border: 1px solid #dbe5ef;
      border-radius: 7px;
      background: #fff;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th {
      padding: 8px 7px;
      border-bottom: 2px solid #dbe5ef;
      background: #fff;
      color: #1c84c6;
      font-size: 10px;
      font-weight: 700;
      text-align: left;
    }
    td {
      padding: 7px;
      border-bottom: 1px solid #e7edf4;
      color: #475569;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    tbody tr:nth-child(even) td { background: #fbfcfe; }
    tbody tr:last-child td { border-bottom: 0; }
    .numero { width: 72px; font-weight: 700; color: #1e293b; }
    .setor { width: 23%; }
    .fornecedor { width: 19%; }
    .valor { width: 92px; white-space: nowrap; font-weight: 700; color: #1e293b; }
    .data { width: 88px; white-space: nowrap; }
    .status {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 999px;
      background: #e0f2fe;
      color: #075985;
      font-size: 9px;
      font-weight: 700;
    }
    .rodape {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-top: 10px;
      padding: 9px 11px;
      border: 1px solid #dbe5ef;
      border-radius: 6px;
      background: #fff;
      font-weight: 600;
    }
    @media print {
      body { background: #fff; }
      .pagina { padding: 0; }
      .acoes { display: none !important; }
      .topo, .filtros, .tabela-wrap, .rodape { break-inside: avoid; box-shadow: none; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="pagina">
    <div class="topo">
      <div>
        <h1>Relatório Financeiro • InfraDesk</h1>
        <div class="subtitulo">${escaparHtml(tituloAba)} • visão atual do Painel Financeiro</div>
      </div>
      <div class="meta">
        <div><strong>${lista.length}</strong> despesa(s)</div>
        <div>Gerado em ${escaparHtml(geradoEm)}</div>
      </div>
    </div>

    <div class="filtros"><strong>Filtros:</strong> ${escaparHtml(filtros)}</div>

    <div class="acoes">
      <button type="button" onclick="window.print()">Imprimir / Salvar PDF</button>
    </div>

    <div class="tabela-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:72px">Chamado</th>
            <th style="width:110px">Criador</th>
            <th style="width:23%">Setor</th>
            <th style="width:105px">Status</th>
            <th style="width:92px">Nº documento</th>
            <th style="width:19%">Fornecedor</th>
            <th style="width:92px">Valor</th>
            <th style="width:88px">Vencimento</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>

    <div class="rodape">
      <span>Total de documentos: ${lista.length}</span>
      <span>Valor bruto total: ${escaparHtml(totalFormatado)}</span>
    </div>
  </div>
</body>
</html>`;

    janela.document.open();
    janela.document.write(html);
    janela.document.close();
  }

  function configurarEventosDaTela() {
    const ids = [
      "sigma-busca",
      "sigma-filtro-competencia",
      "sigma-filtro-setor",
      "sigma-filtro-fornecedor",
      "sigma-filtro-tipo",
      "sigma-filtro-owner",
      "sigma-organizacao",
    ];

    ids.forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener(id === "sigma-busca" ? "input" : "change", function () {
        if (!state.restaurandoPreferencias) salvarPreferenciasPainel();
        if (!state.filtrosProntos || state.carregando) return;
        if (id === "sigma-busca") {
          agendarRender(140);
        } else {
          agendarRender(0);
        }
      });
    });

    document.querySelectorAll("[data-aba-painel]").forEach(function (botao) {
      botao.addEventListener("click", function () {
        const aba = texto(botao.dataset.abaPainel);
        if (!aba || aba === state.abaAtual || state.carregando) return;
        void trocarAbaPainel(aba);
      });
    });

    document.querySelectorAll("[data-situacao]").forEach(function (botao) {
      botao.addEventListener("click", function () {
        document.querySelectorAll("[data-situacao]").forEach(function (outro) {
          outro.classList.remove("ativo");
        });
        botao.classList.add("ativo");
        salvarPreferenciasPainel();
        renderizar();
      });
    });

    document.getElementById("sigma-atualizar").addEventListener("click", async function () {
      if (state.carregando) return;
      state.cacheAbas[state.abaAtual] = null;
      await carregarTodasDespesas();
      reconstruirOpcoesFiltros();
      restaurarPreferenciasPainel(false);
      renderizar();
    });

    const botaoRelatorio = document.getElementById("sigma-gerar-relatorio");
    if (botaoRelatorio) {
      botaoRelatorio.addEventListener("click", abrirRelatorioFinanceiro);
    }

    document.addEventListener("click", function (evento) {
      const reservar = evento.target.closest("[data-reservar-id]");
      if (reservar) {
        evento.preventDefault();
        evento.stopPropagation();
        evento.stopImmediatePropagation();
        void reservarDiretoPainel(reservar);
        return;
      }

      const liberar = evento.target.closest("[data-liberar-id]");
      if (liberar) {
        evento.preventDefault();
        evento.stopPropagation();
        evento.stopImmediatePropagation();
        void liberarReserva(liberar.dataset.liberarId, liberar);
        return;
      }

      const financeiro = evento.target.closest(".sigma-financeiro");
      if (financeiro) {
        evento.preventDefault();
        evento.stopPropagation();
        evento.stopImmediatePropagation();
        const id = texto(financeiro.dataset.sigmaId);
        state.itemModal = state.despesas.find(function (item) { return item.id === id; }) || null;
        atualizarCabecalhoModal(state.itemModal);
        void abrirFinanceiroPainel(financeiro);
      }
    }, true);
  }

  // =========================================================
  // CARREGAR_FILA_PAGINADA
  // Usa a página normal /backend/despesas, que pagina em blocos.
  // Nenhuma dessas páginas é desenhada na tela.
  // =========================================================
  // =========================================================
  // ABAS_DO_PAINEL
  // CTRL + F: ABAS_DO_PAINEL
  // Agendar pagamento carrega primeiro. Pendentes (R + A) só
  // consulta o InfraDesk quando o usuário clicar na aba.
  // =========================================================
  function statusDaAba(aba) {
    const chave = aba === "pendentes" ? "pendentes" : "agendar";
    return (CONFIG.statusAbas[chave] || [CONFIG.statusFilaFixo]).slice();
  }

  function nomeAba(aba) {
    return aba === "pendentes" ? "Pendentes" : "Agendar pagamento";
  }

  function montarUrlFonte(pagina, status) {
    const url = new URL("/backend/despesas", window.location.origin);
    const params = {
      setor_id: "",
      status: texto(status) || CONFIG.statusFilaFixo,
      tipo_data: "V",
      data_intervalo: `${CONFIG.periodoInicial} - ${CONFIG.periodoFinal}`,
      nfe_id: "",
      tipo_doc: "",
      descricao: "",
      departamento_setor_id: "",
      tipo: "",
      plano_conta_id: "",
      natureza_operacao_id: "",
      parcela: "",
      tipo_entrada: "",
      "show-descricao": "0",
      sort: "data_vencimento",
      direction: "asc",
    };
    Object.keys(params).forEach(function (chave) { url.searchParams.set(chave, params[chave]); });
    if (pagina > 1) url.searchParams.set("page", String(pagina));
    return url.toString();
  }

  async function trocarAbaPainel(aba) {
    aba = aba === "pendentes" ? "pendentes" : "agendar";
    if (aba === state.abaAtual) return;

    salvarPreferenciasPainel();
    state.abaAtual = aba;
    atualizarAbasPainel();

    const cache = state.cacheAbas[aba];
    if (Array.isArray(cache)) {
      state.despesas = cache.slice();
      agendarCapturaMetadadosPainel();
      reconstruirOpcoesFiltros();
      restaurarPreferenciasPainel(false);
      renderizar();
      atualizarStatus(`${state.despesas.length} despesa(s) em ${nomeAba(aba)} • dados já carregados`);
      return;
    }

    await carregarTodasDespesas();
    reconstruirOpcoesFiltros();
    restaurarPreferenciasPainel(false);
    renderizar();
  }

  function atualizarAbasPainel() {
    document.querySelectorAll("[data-aba-painel]").forEach(function (botao) {
      const ativa = botao.dataset.abaPainel === state.abaAtual;
      botao.classList.toggle("ativo", ativa);
      botao.setAttribute("aria-selected", ativa ? "true" : "false");
      botao.disabled = !!state.carregando;
    });
  }

  async function carregarTodasDespesas() {
    state.carregando = true;
    const botao = document.getElementById("sigma-atualizar");
    if (botao) botao.disabled = true;
    atualizarAbasPainel();

    const abaCarregando = state.abaAtual;
    const statuses = statusDaAba(abaCarregando);
    const descricaoStatus = abaCarregando === "pendentes"
      ? "1 • A Revisar Despesa + 2 • A Aprovar Gestor"
      : "6 • A Agendar Pgto.";

    atualizarStatus(`Carregando ${descricaoStatus}...`);
    document.getElementById("sigma-corpo-tabela").innerHTML =
      '<tr><td colspan="9" class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Consultando o InfraDesk sem renderizar as páginas...</td></tr>';

    try {
      const mapa = new Map();
      let paginasConsultadas = 0;
      let contextoInstalado = false;

      for (let indiceStatus = 0; indiceStatus < statuses.length; indiceStatus++) {
        const status = statuses[indiceStatus];
        const primeira = await buscarPagina(1, status);

        if (!contextoInstalado) {
          instalarContextoUsuario(primeira.doc);
          contextoInstalado = true;
        }

        const totalPaginas = obterTotalPaginas(primeira.doc);
        paginasConsultadas += totalPaginas;
        primeira.itens.forEach(function (item) {
          item.statusCodigo = status;
          mapa.set(item.id, item);
        });

        atualizarStatus(
          `${nomeAba(abaCarregando)} • status ${status} • página 1 de ${totalPaginas} • ${mapa.size} despesas`
        );

        let proxima = 2;
        let concluidas = 1;
        const workers = [];
        const quantidadeWorkers = Math.min(CONFIG.paginasSimultaneas, Math.max(0, totalPaginas - 1));

        for (let w = 0; w < quantidadeWorkers; w++) {
          workers.push((async function () {
            while (true) {
              const pagina = proxima++;
              if (pagina > totalPaginas) return;
              const resultado = await buscarPagina(pagina, status);
              resultado.itens.forEach(function (item) {
                item.statusCodigo = status;
                mapa.set(item.id, item);
              });
              concluidas++;
              atualizarStatus(
                `${nomeAba(abaCarregando)} • status ${status} • ${concluidas}/${totalPaginas} páginas • ${mapa.size} despesas`
              );
            }
          })());
        }

        await Promise.all(workers);
      }

      const carregadas = Array.from(mapa.values());
      state.cacheAbas[abaCarregando] = carregadas.slice();

      // Se o usuário não trocou de aba durante a consulta, esta passa a ser
      // a lista ativa. A aba Pendentes só chega aqui depois do primeiro clique.
      if (state.abaAtual === abaCarregando) {
        state.despesas = carregadas;
        // Captura DEPOIS da nova lista estar pronta; apenas as reservadas.
        agendarCapturaMetadadosPainel();
      }

      atualizarStatus(
        `${carregadas.length} despesa(s) em ${nomeAba(abaCarregando)} • ${paginasConsultadas} página(s) consultada(s)`
      );
      log("Fila carregada", abaCarregando, carregadas.length);
    } catch (falha) {
      console.error(PREFIXO, falha);
      atualizarStatus("Erro ao carregar a fila");
      toast("Não consegui carregar a fila do InfraDesk: " + texto(falha.message || falha), "erro");
    } finally {
      state.carregando = false;
      if (botao) botao.disabled = false;
      atualizarAbasPainel();
    }
  }

  async function buscarPagina(pagina, status) {
    const resposta = await fetch(montarUrlFonte(pagina, status), {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Requested-With": "SigmaPainelFinanceiro" },
    });
    if (!resposta.ok) {
      throw new Error(`InfraDesk retornou HTTP ${resposta.status} na página ${pagina} do status ${status}.`);
    }
    const html = await resposta.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return { doc: doc, itens: extrairDespesas(doc) };
  }

  function localizarTabelaFinanceira(doc) {
    const linha = doc.querySelector("table tbody tr.tr-index:not(.expandir)");
    if (linha) return linha.closest("table");

    const botao = doc.querySelector('button[onclick*="/backend/despesas/financeiro/"]');
    return botao ? botao.closest("table") : null;
  }

  function obterTotalPaginas(doc) {
    const tabela = localizarTabelaFinanceira(doc);
    const textoPagina = texto(tabela && tabela.querySelector(".paginator") ? tabela.querySelector(".paginator").textContent : "");
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
  // EXTRAIR_DESPESAS_ENRIQUECIDAS
  // CTRL + F: EXTRAIR_DESPESAS_ENRIQUECIDAS
  // Lê fluxo, pagamento antecipado, plano final, documento,
  // emissão/vencimento e ignora competência nativa + encargos.
  // =========================================================
  function extrairDespesas(doc) {
    const tabela = localizarTabelaFinanceira(doc);
    if (!tabela || !tabela.tBodies.length) return [];

    const itens = [];
    let observacoesPendentes = [];
    let itemAtual = null;

    Array.from(tabela.tBodies[0].children).forEach(function (tr) {
      const alerta = tr.querySelector(".alert");
      const principal = tr.classList.contains("tr-index") && !tr.classList.contains("expandir");

      if (!principal) {
        if (alerta) {
          const obs = texto(alerta.textContent);
          if (obs) observacoesPendentes.push(obs);
          return;
        }

        if (itemAtual && tr.classList.contains("expandir")) {
          extrairComplementosDespesa(itemAtual, tr);
        }
        return;
      }

      const celulas = tr.children;
      if (celulas.length < 6) return;

      const id = texto(celulas[0].querySelector("p") ? celulas[0].querySelector("p").textContent : "");
      if (!/^\d+$/.test(id)) return;

      const descricao = texto(celulas[1].textContent);
      const tipo = texto(celulas[2].textContent);
      const imagemTipo = celulas[2].querySelector("img.icone-tipo-documento");
      const imagemTipoSrc = imagemTipo ? texto(imagemTipo.getAttribute("src")) : "";
      const marcadoresTipo = Array.from(celulas[2].querySelectorAll("i")).map(function (icone) {
        return {
          classes: classesIconeSeguras(icone.getAttribute("class") || ""),
          titulo: texto(icone.getAttribute("data-original-title") || icone.getAttribute("title") || ""),
        };
      }).filter(function (marcador) {
        return marcador.classes || marcador.titulo;
      });

      const fornecedorEl = celulas[3].querySelector("[data-original-title]");
      const fornecedor = texto((fornecedorEl && fornecedorEl.getAttribute("data-original-title")) || celulas[3].textContent);
      const antecipadoEl = Array.from(celulas[3].querySelectorAll(".badge")).find(function (badge) {
        return /antecipado/i.test(texto(badge.textContent));
      });
      const pagamentoAntecipado = !!antecipadoEl;

      // O InfraDesk agora pode trazer Emissão + Competência + Vencimento.
      // A competência nativa é ignorada no card; o vencimento é sempre a
      // última data disponível na célula.
      const datas = texto(celulas[4].textContent).match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || [];
      const emissaoTexto = datas[0] || "";
      const vencimentoTexto = datas.length >= 2 ? datas[datas.length - 1] : datas[0] || "";
      const emissao = parseDataBr(emissaoTexto);
      const vencimento = parseDataBr(vencimentoTexto);

      // Pega somente o Valor Bruto. O valor de Encargos/Tributos não entra
      // no painel, conforme a finalidade desta fila.
      const valorEl = celulas[5].querySelector('[data-original-title="Valor Bruto"]')
        || celulas[5].querySelector("b");
      const valor = texto(valorEl ? valorEl.textContent : celulas[5].textContent);

      const statusEl = celulas[0].querySelector(".badge");
      const statusTexto = texto(statusEl ? statusEl.textContent : "");

      const botaoFinanceiro = tr.querySelector('button[onclick*="/backend/despesas/financeiro/"]');
      const financeiroDisponivel = !!(
        botaoFinanceiro
        && !botaoFinanceiro.classList.contains("disabled")
        && !botaoFinanceiro.hasAttribute("disabled")
      );
      const onclickFinanceiro = financeiroDisponivel ? (botaoFinanceiro.getAttribute("onclick") || "") : "";
      const financeMatch = onclickFinanceiro.match(/\.load\(['"]([^'"]+)['"]\)/i);
      const financeUrl = financeMatch ? financeMatch[1].replace(/&amp;/g, "&") : "";

      const linkChamado = tr.querySelector('a[href*="/backend/chamados/criar?despesa_id="]');
      const detalhesChamado = extrairDetalhesChamado(linkChamado ? linkChamado.getAttribute("href") : "");

      const item = {
        id: id,
        numeroDocumento: detalhesChamado.numeroDocumento,
        descricao: descricao,
        tipo: tipo,
        imagemTipoSrc: imagemTipoSrc,
        marcadoresTipo: marcadoresTipo,
        statusTexto: statusTexto,
        fornecedor: fornecedor,
        pagamentoAntecipado: pagamentoAntecipado,
        emissao: emissao,
        emissaoTexto: emissaoTexto,
        vencimento: vencimento,
        vencimentoTexto: vencimentoTexto,
        competencia: chaveCompetencia(emissao),
        valor: valor,
        planoConta: detalhesChamado.planoConta,
        setorContratante: detalhesChamado.setorContratante,
        fluxo: {},
        observacoes: observacoesPendentes.slice(),
        financeUrl: financeUrl,
      };

      itens.push(item);
      itemAtual = item;
      observacoesPendentes = [];
    });

    itens.forEach(function (item) {
      item.busca = normalizar([
        item.id,
        item.numeroDocumento,
        item.descricao,
        item.tipo,
        item.statusTexto,
        item.fornecedor,
        item.valor,
        item.planoConta,
        item.setorContratante,
        item.pagamentoAntecipado ? "pagamento antecipado adiantamento" : "",
        Object.keys(item.fluxo || {}).map(function (chave) {
          const etapa = item.fluxo[chave] || {};
          return [chave, etapa.usuario, etapa.data].join(" ");
        }).join(" "),
        (item.marcadoresTipo || []).map(function (m) { return m.titulo; }).join(" "),
      ].join(" "));
    });

    return itens;
  }

  function extrairComplementosDespesa(item, tr) {
    if (!item || !tr) return;

    // Histórico das etapas. Mostramos somente o fluxo útil:
    // Criado/Lançado, Revisado, Aprovado, Fiscal e Agendado.
    Array.from(tr.querySelectorAll("strong")).forEach(function (strong) {
      const titulo = normalizar(texto(strong.textContent));
      let chave = "";
      if (titulo === "lancado") chave = "criado";
      else if (titulo === "revisado") chave = "revisado";
      else if (titulo === "aprovado") chave = "aprovado";
      else if (titulo === "fiscal") chave = "fiscal";
      else if (titulo === "agendado") chave = "agendado";
      if (!chave) return;

      const bloco = strong.parentElement;
      if (!bloco) return;

      const clone = bloco.cloneNode(true);
      Array.from(clone.querySelectorAll("strong, i")).forEach(function (el) { el.remove(); });
      const conteudo = texto(clone.textContent);
      const dataMatch = conteudo.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}:\d{2}\b/);
      const data = texto(dataMatch ? dataMatch[0] : "");
      const usuario = texto(conteudo.replace(dataMatch ? dataMatch[0] : "", ""));

      if (usuario && !/^[-\s]+$/.test(usuario)) {
        item.fluxo[chave] = {
          usuario: usuario,
          data: data && data !== "--" ? data : "",
        };
      }
    });

    const textoLinha = texto(tr.textContent);

    if (!item.numeroDocumento && /N[º°o]?\s*Documento\s*:/i.test(textoLinha)) {
      const matchDoc = textoLinha.match(/N[º°o]?\s*Documento\s*:\s*([^\s]+)/i);
      if (matchDoc) item.numeroDocumento = texto(matchDoc[1]);
    }

    if (/Plano(?:s)?\s+de\s+Conta/i.test(textoLinha)) {
      const plano = extrairUltimoPlanoConta(textoLinha);
      if (plano) item.planoConta = plano;
    }

    if (/Setor\s+Contratante\s*:/i.test(textoLinha)) {
      const matchSetor = textoLinha.match(/Setor\s+Contratante\s*:\s*(.*?)(?=\s+Rateio\s*:|$)/i);
      if (matchSetor) item.setorContratante = texto(matchSetor[1]);
    }
  }

  function classesIconeSeguras(valor) {
    return String(valor || "")
      .split(/\s+/)
      .filter(function (classe) {
        return /^(?:fa|fas|far|fal|fab|fa-solid|fa-regular|fa-brands|fa-[a-z0-9-]+)$/i.test(classe);
      })
      .join(" ");
  }

  function extrairDetalhesChamado(href) {
    const retorno = {
      numeroDocumento: "",
      planoConta: "",
      setorContratante: "",
    };
    if (!href) return retorno;

    try {
      const detalhes = new URL(href, window.location.origin).searchParams.get("detalhes") || "";
      const textoDetalhes = detalhes.replace(/<[^>]+>/g, " ").replace(/\|/g, " | ");

      const matchDoc = textoDetalhes.match(/Doc\s*N[º°o]?\s*:\s*([^|]+)/i);
      retorno.numeroDocumento = texto(matchDoc ? matchDoc[1] : "");

      const plano = extrairUltimoPlanoConta(textoDetalhes);
      if (plano) retorno.planoConta = plano;

      const matchSetor = textoDetalhes.match(/Setor\s+Contratante\s*:\s*([^|]+)/i);
      retorno.setorContratante = texto(matchSetor ? matchSetor[1] : "");
    } catch (_) {}

    return retorno;
  }

  function extrairUltimoPlanoConta(valor) {
    const bruto = texto(String(valor || "").replace(/\|/g, " "));
    if (!bruto) return "";

    // Procura contas analíticas (5 blocos numéricos) e escolhe a última.
    // Ex.: 4.02.002.0004.00013 - Despesas De Trade Marketing
    const regex = /(\d+(?:\.\d+){4})\s*-\s*(.*?)(?=\s+-\s+\d+(?:\.\d+){4}\b|\s*\||$)/g;
    let match;
    let ultimo = "";
    while ((match = regex.exec(bruto))) {
      const codigo = texto(match[1]);
      let descricao = texto(match[2])
        .replace(/\bSetor\s+Contratante\s*:.*$/i, "")
        .replace(/\bDescri[cç][aã]o\s*:.*$/i, "")
        .trim();
      if (codigo && descricao) ultimo = `${codigo} - ${descricao}`;
    }

    // Fallback mais permissivo para o HTML expandido, no qual o texto pode
    // estar sem separadores "|" depois que o DOM é normalizado.
    if (!ultimo) {
      const matches = Array.from(bruto.matchAll(/(\d+(?:\.\d+){4})\s*-\s*([^-]+?)(?=\s+\d+(?:\.\d+){3,4}\s*-|$)/g));
      if (matches.length) {
        const escolhido = matches[matches.length - 1];
        ultimo = `${texto(escolhido[1])} - ${texto(escolhido[2])}`;
      }
    }

    return texto(ultimo);
  }

  function extrairNumeroDocumento(href) {
    return extrairDetalhesChamado(href).numeroDocumento;
  }

  // =========================================================
  // METADADOS_DA_LINHA_NORMAL
  // Lê exclusivamente os campos necessários à base de dados persistentes.
  // As linhas expandidas continuam no DOM mesmo quando visualmente fechadas.
  // =========================================================
  function extrairMetadadosDaLinhaNormal(tr, id) {
    if (!tr || !/^\d+$/.test(texto(id))) return null;
    const celulas = tr.children || [];
    if (celulas.length < 6) return null;

    const fornecedorEl = celulas[3].querySelector("[data-original-title]");
    const valorEl = celulas[5].querySelector('[data-original-title="Valor Bruto"]')
      || celulas[5].querySelector("b");
    const datas = texto(celulas[4].textContent).match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || [];
    const item = {
      id: id,
      tipo: texto(celulas[2].textContent),
      fornecedor: texto((fornecedorEl && fornecedorEl.getAttribute("data-original-title")) || celulas[3].textContent),
      valor: texto(valorEl ? valorEl.textContent : celulas[5].textContent),
      vencimentoTexto: datas.length ? datas[datas.length - 1] : "",
      fluxo: {},
    };

    let proxima = tr.nextElementSibling;
    let lidas = 0;
    while (proxima && lidas++ < 12 && proxima.classList.contains("expandir-" + id)) {
      extrairComplementosDespesa(item, proxima);
      proxima = proxima.nextElementSibling;
    }
    return item;
  }

  // =========================================================
  // CONTEXTO_DO_USUARIO
  // Identifica o usuário pela página real consultada no InfraDesk.
  // =========================================================
  function instalarContextoUsuario(doc) {
    const nomeEl = doc.querySelector(".profile-element strong.font-bold, .nav-header strong.font-bold");
    const setorEl = doc.querySelector(".profile-element small, .nav-header .text-muted small");
    let nome = texto(nomeEl ? nomeEl.textContent : "").replace(/[▾▼]/g, "").trim();
    const setor = texto(setorEl ? setorEl.textContent : "");
    const html = doc.documentElement ? doc.documentElement.innerHTML : "";
    const idMatch = html.match(/avatar_usuario_(\d+)|\/avatar\/(\d+)\//i);

    if (nome) state.usuario.nome = nome;
    state.usuario.setor = setor;
    state.usuario.id = idMatch ? texto(idMatch[1] || idMatch[2]) : "";

    try {
      if (state.usuario.nome) {
        localStorage.setItem("sigma-painel-financeiro-ultimo-usuario", state.usuario.nome);
      }
    } catch (_) {}

    document.documentElement.dataset.sigmaUsuarioLogado = state.usuario.nome;
    paginaWindow().__SIGMA_USUARIO_LOGADO__ = Object.assign({}, state.usuario);
    document.getElementById("sigma-usuario").innerHTML =
      `<i class="fa-solid fa-user"></i> ${escaparHtml(state.usuario.nome || "Usuário não identificado")}`;

    restaurarPreferenciasPainel(true);
  }

  // =========================================================
  // FIREBASE
  // Reserva: responsável atual por cada despesa.
  // Estado: registra conclusão ou retorno após o InfraDesk confirmar.
  // =========================================================
  function firebaseUrl(caminho) {
    return CONFIG.firebaseBase.replace(/\/+$/, "") + "/" + String(caminho).replace(/^\/+/, "") + ".json";
  }

  function gmRequest(opcoes) {
    return new Promise(function (resolve, reject) {
      const req = {
        method: opcoes.method || "GET",
        url: opcoes.url,
        headers: opcoes.headers || {},
        data: opcoes.data == null ? null : opcoes.data,
        timeout: opcoes.timeout || 30000,
        onload: resolve,
        onerror: function (erro) { reject(erro || new Error("Erro de rede")); },
        ontimeout: function () { reject(new Error("Tempo esgotado no Firebase")); },
      };

      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest(req);
        return;
      }
      if (typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function") {
        const retorno = GM.xmlHttpRequest(req);
        if (retorno && typeof retorno.then === "function") retorno.then(resolve).catch(reject);
        return;
      }
      reject(new Error("GM_xmlhttpRequest não está disponível."));
    });
  }

  // =========================================================
  // DADOS_PERSISTENTES_FIREBASE_V5_3
  // Dados para auditoria/BI separados de reservas e estados temporários.
  // Só grava linhas reservadas, ao reservar ou após concluir pelo painel.
  // A fila em localStorage reenvia falhas de rede sem travar o InfraDesk.
  // =========================================================

  function formatarDataHoraFinanceira(valor) {
    const v = texto(valor);
    const match = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!match) return v;
    const ano = match[3].length === 2 ? "20" + match[3] : match[3];
    return [match[1].padStart(2, "0"), match[2].padStart(2, "0"), ano].join("/")
      + " " + [match[4].padStart(2, "0"), match[5], match[6]].join(":");
  }

  function formatarDataFinanceira(valor) {
    const v = texto(valor);
    const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!m) return v;
    return m[1].padStart(2, "0") + "/" + m[2].padStart(2, "0") + "/"
      + (m[3].length === 2 ? "20" + m[3] : m[3]);
  }

  function valorBrutoNumericoFinanceiro(valor) {
    const limpo = texto(valor).replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
    if (!limpo || !/^-?\d+(?:\.\d+)?$/.test(limpo)) return null;
    const n = Number(limpo);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }

  function montarDadosPersistentes(item, responsavel) {
    if (!item || !/^\d+$/.test(texto(item.id))) return null;
    const fluxo = item.fluxo || {};
    const criado = fluxo.criado || {};
    const aprovado = fluxo.aprovado || {};
    const valor = valorBrutoNumericoFinanceiro(item.valor);
    const dados = { id: texto(item.id) };

    // O responsável é a última pessoa que assumiu a despesa. Não zeramos
    // esse campo quando a reserva é liberada: ele permanece para o histórico.
    if (texto(responsavel)) dados.responsavel = texto(responsavel);
    if (texto(criado.data)) dados.criadoEm = formatarDataHoraFinanceira(criado.data);
    if (texto(criado.usuario)) dados.criadoPor = texto(criado.usuario);
    if (texto(aprovado.data)) dados.aprovadoEm = formatarDataHoraFinanceira(aprovado.data);
    if (texto(aprovado.usuario)) dados.aprovadoPor = texto(aprovado.usuario);
    if (texto(item.tipo)) dados.tipoDocumento = texto(item.tipo);
    if (texto(item.fornecedor)) dados.fornecedor = texto(item.fornecedor);
    if (valor !== null) dados.valorBruto = valor;
    if (texto(item.vencimentoTexto)) dados.vencimento = formatarDataFinanceira(item.vencimentoTexto);

    return Object.keys(dados).length > 1 ? dados : null;
  }

  function iniciarFilaMetadados() {
    if (filaMetadados.iniciada) return;
    filaMetadados.iniciada = true;
    try {
      const fila = JSON.parse(localStorage.getItem(CHAVE_FILA_METADADOS) || "{}");
      if (fila && typeof fila === "object" && !Array.isArray(fila)) filaMetadados.pendentes = fila;
    } catch (_) {}
    try {
      const eventos = JSON.parse(localStorage.getItem(CHAVE_FILA_EVENTOS) || "{}");
      if (eventos && typeof eventos === "object" && !Array.isArray(eventos)) filaMetadados.eventos = eventos;
    } catch (_) {}
    if (Object.keys(filaMetadados.pendentes).length || Object.keys(filaMetadados.eventos).length) {
      agendarEnvioMetadados(600);
    }
  }

  function salvarFilaMetadados() {
    try {
      if (Object.keys(filaMetadados.pendentes).length) {
        localStorage.setItem(CHAVE_FILA_METADADOS, JSON.stringify(filaMetadados.pendentes));
      } else {
        localStorage.removeItem(CHAVE_FILA_METADADOS);
      }
    } catch (falha) {
      console.warn(PREFIXO, "Fila local de metadados indisponível", falha);
    }
    try {
      if (Object.keys(filaMetadados.eventos).length) {
        localStorage.setItem(CHAVE_FILA_EVENTOS, JSON.stringify(filaMetadados.eventos));
      } else {
        localStorage.removeItem(CHAVE_FILA_EVENTOS);
      }
    } catch (falha) {
      console.warn(PREFIXO, "Fila local de eventos indisponível", falha);
    }
  }

  // Cada ação efetivamente confirmada gera um evento único. A gravação é
  // feita por PUT com ID estável, permitindo repetição sem eventos duplicados.
  // Nunca usamos DELETE nos dois novos caminhos de histórico.
  function registrarEventoHistorico(id, acao, usuario, responsavelAntes, responsavelDepois) {
    id = texto(id);
    if (!/^\d+$/.test(id)) return;
    iniciarFilaMetadados();
    const ts = Date.now();
    const chave = "e" + ts.toString(36) + "_" + Math.random().toString(36).slice(2, 12);
    const evento = {
      id: id,
      acao: texto(acao),
      realizadoPor: texto(usuario && usuario.nome) || "Não identificado",
      realizadoPorId: texto(usuario && usuario.id),
      realizadoPorLogin: texto(usuario && usuario.login),
      responsavelAntes: texto(responsavelAntes),
      responsavelDepois: texto(responsavelDepois),
      ts: ts,
      dataHora: new Date(ts).toISOString(),
    };
    filaMetadados.eventos[chave] = { id: id, evento: evento };
    salvarFilaMetadados();
    agendarEnvioMetadados(400);
  }

  function registrarMetadadosDespesa(item, responsavel) {
    iniciarFilaMetadados();
    const dados = montarDadosPersistentes(item, responsavel);
    if (!dados) return;
    const id = dados.id;
    // Completa campos de uma coleta anterior; não apaga data de aprovação
    // quando um HTML parcial chega sem a linha expandida.
    const anterior = filaMetadados.pendentes[id];
    const composto = Object.assign({}, anterior && anterior.dados || {}, dados);
    const assinatura = JSON.stringify(composto);
    if (filaMetadados.ultimoSnapshot[id] === assinatura && !anterior) return;
    if (anterior && JSON.stringify(anterior.dados) === assinatura) return;

    filaMetadados.ultimoSnapshot[id] = assinatura;
    filaMetadados.pendentes[id] = { dados: composto };
    salvarFilaMetadados();
    agendarEnvioMetadados(500);
  }

  function agendarEnvioMetadados(atraso) {
    if (filaMetadados.timer) clearTimeout(filaMetadados.timer);
    filaMetadados.timer = setTimeout(function () {
      filaMetadados.timer = null;
      void enviarMetadadosPendentes();
    }, Math.max(0, Number(atraso || 0)));
  }

  async function enviarMetadadosPendentes() {
    if (filaMetadados.enviando) return;
    filaMetadados.enviando = true;
    let falhou = false;
    try {
      const ids = Object.keys(filaMetadados.pendentes).slice(0, 30);
      for (const id of ids) {
        const registro = filaMetadados.pendentes[id];
        if (!registro || !registro.dados) { delete filaMetadados.pendentes[id]; continue; }
        const dados = registro.dados;
        try {
          const url = firebaseUrl(CONFIG.firebaseDados + "/" + encodeURIComponent(id));
          // Consulta o estado salvo antes de escrever. Várias abas/dispositivos
          // não devem regravar as mesmas informações a cada carregamento.
          const leitura = await gmRequest({ method: "GET", url: url, timeout: 12000 });
          if (!leitura || leitura.status < 200 || leitura.status >= 300) {
            throw new Error("Leitura dos dados: HTTP " + (leitura ? leitura.status : "sem resposta"));
          }
          const remoto = parseJsonSeguro(leitura.responseText || "null", null);
          const anterior = remoto && typeof remoto === "object" && !Array.isArray(remoto)
            ? remoto : {};
          const alteracoes = {};
          Object.keys(dados).forEach(function (campo) {
            if (!Object.prototype.hasOwnProperty.call(anterior, campo)
                || JSON.stringify(anterior[campo]) !== JSON.stringify(dados[campo])) {
              alteracoes[campo] = dados[campo];
            }
          });
          // PATCH apenas dos campos diferentes, preservando dados antigos.
          // atualizadoEm muda somente quando algo da despesa realmente mudou.
          if (Object.keys(alteracoes).length) {
            alteracoes.atualizadoEm = Date.now();
            const resposta = await gmRequest({
              method: "PATCH", url: url,
              headers: { "Content-Type": "application/json" },
              data: JSON.stringify(alteracoes), timeout: 12000,
            });
            if (!resposta || resposta.status < 200 || resposta.status >= 300) {
              throw new Error("Gravação dos dados: HTTP " + (resposta ? resposta.status : "sem resposta"));
            }
          }
          // Se houve nova coleta durante a requisição, preserve a versão nova.
          if (filaMetadados.pendentes[id] === registro) delete filaMetadados.pendentes[id];
          filaMetadados.errosConsecutivos = 0;
        } catch (falha) {
          falhou = true;
          filaMetadados.errosConsecutivos++;
          console.warn(PREFIXO, "Não consegui guardar os dados da despesa " + id, falha);
          break;
        }
      }
      // Eventos independentes dos dados: uma falha em uma despesa não deve
      // bloquear a trilha das ações de outras despesas.
      const chaves = Object.keys(filaMetadados.eventos).slice(0, 30);
      for (const chave of chaves) {
        const registro = filaMetadados.eventos[chave];
        if (!registro || !registro.id || !registro.evento) {
          delete filaMetadados.eventos[chave];
          continue;
        }
        try {
          const resposta = await gmRequest({
            method: "PUT",
            url: firebaseUrl(CONFIG.firebaseHistorico + "/" + encodeURIComponent(registro.id)
              + "/" + encodeURIComponent(chave)),
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(registro.evento),
            timeout: 12000,
          });
          if (!resposta || resposta.status < 200 || resposta.status >= 300) {
            throw new Error("HTTP " + (resposta ? resposta.status : "sem resposta"));
          }
          if (filaMetadados.eventos[chave] === registro) delete filaMetadados.eventos[chave];
          filaMetadados.errosConsecutivos = 0;
        } catch (falha) {
          falhou = true;
          filaMetadados.errosConsecutivos++;
          console.warn(PREFIXO, "Não consegui arquivar o evento " + chave, falha);
          break;
        }
      }
      salvarFilaMetadados();
    } finally {
      filaMetadados.enviando = false;
      if (Object.keys(filaMetadados.pendentes).length || Object.keys(filaMetadados.eventos).length) {
        const atraso = falhou
          ? Math.min(5 * 60 * 1000, 10000 * Math.pow(2, Math.min(filaMetadados.errosConsecutivos - 1, 5)))
          : 700;
        agendarEnvioMetadados(atraso);
      }
    }
  }

  function agendarCapturaMetadadosPainel() {
    // Não varre milhares de despesas a cada evento SSE. Somente a lista
    // visível e somente as que têm dono de reserva.
    if (modoPainel === false) return;
    if (filaMetadados.timerCaptura) clearTimeout(filaMetadados.timerCaptura);
    filaMetadados.timerCaptura = setTimeout(function () {
      filaMetadados.timerCaptura = null;
      (state.despesas || []).forEach(function (item) {
        const dono = donoReservaNoMapa(state.reservas, item.id);
        if (dono) registrarMetadadosDespesa(item, dono);
      });
    }, 220);
  }

  function donoReserva(id) {
    return donoReservaNoMapa(state.reservas, id);
  }

  // =========================================================
  // RESERVA_FIREBASE_SEGURA
  // Para localizar depois, use CTRL + F e procure por:
  // RESERVA_FIREBASE_SEGURA
  //
  // O ETag funciona como uma senha de versão do registro. Se duas pessoas
  // tentarem reservar ao mesmo tempo, somente a primeira grava. A segunda
  // recebe o responsável atualizado em vez de sobrescrevê-lo.
  // =========================================================
  function obterCabecalhoResposta(resposta, nome) {
    const procurado = String(nome || "").toLowerCase();
    const linhas = String(resposta && resposta.responseHeaders || "").split(/\r?\n/);
    for (const linha of linhas) {
      const posicao = linha.indexOf(":");
      if (posicao < 0) continue;
      if (linha.slice(0, posicao).trim().toLowerCase() === procurado) {
        return linha.slice(posicao + 1).trim();
      }
    }
    return "";
  }

  function parseJsonSeguro(valor, padrao) {
    try {
      return JSON.parse(valor || "");
    } catch (_) {
      return padrao;
    }
  }

  async function lerReservaComVersao(id) {
    const resposta = await gmRequest({
      method: "GET",
      url: firebaseUrl(CONFIG.firebaseReservas + "/" + encodeURIComponent(id)),
      headers: {
        "Accept": "application/json",
        "X-Firebase-ETag": "true",
      },
      timeout: 12000,
    });

    if (!resposta || resposta.status < 200 || resposta.status >= 300) {
      throw new Error("Firebase não confirmou a leitura da reserva.");
    }

    return {
      item: parseJsonSeguro(resposta.responseText || "null", null),
      etag: obterCabecalhoResposta(resposta, "etag"),
    };
  }

  function payloadReserva(usuario) {
    const payload = {
      operador: texto(usuario && usuario.nome),
      ts: Date.now(),
    };
    const usuarioId = texto(usuario && usuario.id);
    if (usuarioId) payload.usuarioId = usuarioId;
    return payload;
  }

  async function reservarDespesaFirebaseSeguro(id, usuario, opcoes) {
    id = texto(id);
    opcoes = opcoes || {};
    const nome = texto(usuario && usuario.nome);
    if (!id || !nome) {
      return { ok: false, codigo: "usuario", mensagem: "Não consegui identificar o usuário logado." };
    }

    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const leitura = await lerReservaComVersao(id);
      const owner = donoItemReserva(leitura.item);

      if (opcoes.donoEsperado != null && normalizar(owner) !== normalizar(opcoes.donoEsperado)) {
        return { ok: false, codigo: "alterada", owner: owner, item: leitura.item };
      }

      if (owner && mesmaPessoa(owner, nome)) {
        // Já é minha: nenhuma nova escrita, nenhum timestamp desnecessário.
        return { ok: true, codigo: "ja_minha", owner: owner, item: leitura.item };
      }

      if (owner && !opcoes.permitirAssumir) {
        return { ok: false, codigo: "ocupada", owner: owner, item: leitura.item };
      }

      const payload = payloadReserva(usuario);
      const headers = { "Content-Type": "application/json" };
      if (leitura.etag) headers["If-Match"] = leitura.etag;

      const resposta = await gmRequest({
        method: "PUT",
        url: firebaseUrl(CONFIG.firebaseReservas + "/" + encodeURIComponent(id)),
        headers: headers,
        data: JSON.stringify(payload),
        timeout: 12000,
      });

      if (resposta && resposta.status === 412) continue;
      if (!resposta || resposta.status < 200 || resposta.status >= 300) {
        throw new Error("Firebase não confirmou a reserva.");
      }
      registrarEventoHistorico(id, owner ? "transferencia" : "reserva", usuario, owner, nome);
      return { ok: true, codigo: owner ? "assumida" : "reservada", owner: nome, item: payload };
    }

    const atual = await lerReservaComVersao(id);
    const ownerAtual = donoItemReserva(atual.item);
    return { ok: false, codigo: "alterada", owner: ownerAtual, item: atual.item };
  }

  async function liberarReservaFirebaseSeguro(id, usuario, opcoes) {
    id = texto(id);
    opcoes = opcoes || {};
    if (!id) return { ok: false, codigo: "id", mensagem: "Despesa inválida." };

    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const leitura = await lerReservaComVersao(id);
      const owner = donoItemReserva(leitura.item);

      if (!owner) return { ok: true, codigo: "ja_livre", owner: "", item: null };
      if (opcoes.donoEsperado != null && normalizar(owner) !== normalizar(opcoes.donoEsperado)) {
        return { ok: false, codigo: "alterada", owner: owner, item: leitura.item };
      }
      if (opcoes.tsMaximoReserva != null && Number(leitura.item && leitura.item.ts || 0)
          > Number(opcoes.tsMaximoReserva)) {
        return { ok: false, codigo: "alterada", owner: owner, item: leitura.item };
      }

      const nomeAtual = texto(usuario && usuario.nome);
      if (!opcoes.permitirOutro && (!nomeAtual || !mesmaPessoa(owner, nomeAtual))) {
        return { ok: false, codigo: "ocupada", owner: owner, item: leitura.item };
      }

      const headers = {};
      if (leitura.etag) headers["If-Match"] = leitura.etag;
      const resposta = await gmRequest({
        method: "DELETE",
        url: firebaseUrl(CONFIG.firebaseReservas + "/" + encodeURIComponent(id)),
        headers: headers,
        timeout: 12000,
      });

      if (resposta && resposta.status === 412) continue;
      if (!resposta || resposta.status < 200 || resposta.status >= 300) {
        throw new Error("Firebase não confirmou a liberação.");
      }
      // Toda liberação EXPLÍCITA, mesmo pelo próprio operador, é auditada.
      registrarEventoHistorico(id, "liberacao", usuario, owner, "");
      return { ok: true, codigo: "liberada", owner: "", item: null };
    }

    const atual = await lerReservaComVersao(id);
    const ownerAtual = donoItemReserva(atual.item);
    return { ok: false, codigo: "alterada", owner: ownerAtual, item: atual.item };
  }

  function aplicarResultadoReservaPainel(id, resultado) {
    if (!resultado) return;
    if (donoItemReserva(resultado.item)) {
      state.reservas[id] = resultado.item;
    } else {
      delete state.reservas[id];
    }
    state.reservandoIds.delete(id);
    const owner = donoItemReserva(resultado.item);
    if (owner) {
      const item = itemDespesaPorId(id);
      if (item) registrarMetadadosDespesa(item, owner);
    }
    renderizar();
  }

  async function reservarDiretoPainel(botao) {
    const id = texto(botao && botao.dataset.reservarId);
    if (!id || state.reservandoIds.has(id)) return;

    state.reservandoIds.add(id);
    botao.disabled = true;

    try {
      if (!state.usuario.nome) {
        throw new Error("Não consegui identificar o usuário logado.");
      }

      const resultado = await reservarDespesaFirebaseSeguro(
        id,
        state.usuario,
        { permitirAssumir: false }
      );
      aplicarResultadoReservaPainel(id, resultado);

      if (!resultado.ok) {
        toast(mensagemFalhaReserva(resultado), "erro");
        return;
      }

      toast(`Despesa ${id} reservada para ${state.usuario.nome}.`, "sucesso");
    } catch (falha) {
      toast("Não consegui reservar: " + texto(falha.message || falha), "erro");
    } finally {
      state.reservandoIds.delete(id);
      if (botao.isConnected) botao.disabled = false;
    }
  }

  async function liberarReserva(id, botao) {
    if (!id || state.reservandoIds.has(id)) return;
    const dono = donoReserva(id);
    if (!dono) return;
    const mensagem = mesmaPessoa(dono, state.usuario.nome)
      ? `Liberar a despesa ${id}?`
      : `Remover a reserva de ${dono} na despesa ${id}?`;
    if (!window.confirm(mensagem)) return;

    state.reservandoIds.add(id);
    if (botao) botao.disabled = true;

    try {
      const resultado = await liberarReservaFirebaseSeguro(
        id,
        state.usuario,
        { permitirOutro: true, donoEsperado: dono }
      );
      aplicarResultadoReservaPainel(id, resultado);
      if (!resultado.ok) throw new Error(mensagemFalhaReserva(resultado));
      toast(`Despesa ${id} liberada.`, "sucesso");
    } catch (falha) {
      toast("Não consegui liberar: " + texto(falha.message || falha), "erro");
    } finally {
      state.reservandoIds.delete(id);
      if (botao && botao.isConnected) botao.disabled = false;
    }
  }

  async function abrirFinanceiroPainel(botao) {
    const id = texto(botao && botao.dataset.sigmaId);
    if (!id || state.abrindoIds.has(id)) return;

    state.abrindoIds.add(id);
    botao.disabled = true;

    try {
      if (!state.usuario.nome) {
        throw new Error("Não consegui identificar o usuário logado.");
      }

      const resultado = await reservarDespesaFirebaseSeguro(
        id,
        state.usuario,
        { permitirAssumir: false }
      );

      aplicarResultadoReservaPainel(id, resultado);

      if (!resultado.ok) {
        toast(mensagemFalhaReserva(resultado), "erro");
        return;
      }

      const item = itemDespesaPorId(id);
      if (!item || !item.financeUrl) {
        throw new Error("O InfraDesk não informou o endereço do formulário financeiro.");
      }

      state.itemModal = item;
      atualizarCabecalhoModal(item);
      agendarRender(0);

      garantirDependenciasModal().catch(function (falha) {
        console.warn(PREFIXO, "Dependência do modal", falha);
      });

      const $ = paginaWindow().jQuery;
      const modal = $("#ModalDespesas");
      const modalBody = corpoPrincipalModal();
      if (!modalBody) throw new Error("O corpo do modal Financeiro não foi encontrado.");

      modal.modal("show");
      $(modalBody)
        .html('<div class="sigma-modal-shell-carregando"><div class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Carregando formulário financeiro...</div></div>')
        .load(item.financeUrl, function (_resposta, status, xhr) {
          if (status === "error") {
            $(modalBody).html(
              '<div class="sigma-modal-shell-carregando"><div class="sigma-vazio" style="color:#991b1b!important">'
              + '<i class="fa-solid fa-triangle-exclamation"></i><br>'
              + 'Não consegui carregar o formulário Financeiro'
              + (xhr && xhr.status ? ` (HTTP ${xhr.status})` : "")
              + '.</div></div>'
            );
            toast("Não consegui carregar o Financeiro desta despesa.", "erro");
            return;
          }
          void processarFormularioModal();
        });
    } catch (falha) {
      toast("Não consegui abrir o financeiro: " + texto(falha.message || falha), "erro");
    } finally {
      state.abrindoIds.delete(id);
      if (botao.isConnected) {
        const owner = donoReserva(id);
        botao.disabled = !!owner && !mesmaPessoa(owner, state.usuario.nome);
      }
    }
  }

  // =========================================================
  // SINCRONIZACAO_FINAL_COM_FIREBASE
  // O InfraDesk é a fonte principal da verdade. Depois que ele confirma,
  // a despesa sai da tela imediatamente. O Firebase é sincronizado em
  // segundo plano e nunca transforma uma gravação já concluída em erro.
  // =========================================================
  const CHAVE_PENDENCIAS_FIREBASE = "sigma-painel-financeiro-pendencias-firebase-v1";

  function carregarPendenciasFirebase() {
    try {
      const valor = JSON.parse(localStorage.getItem(CHAVE_PENDENCIAS_FIREBASE) || "{}");
      return valor && typeof valor === "object" ? valor : {};
    } catch (_) {
      return {};
    }
  }

  function salvarPendenciasFirebase(pendencias) {
    try {
      localStorage.setItem(CHAVE_PENDENCIAS_FIREBASE, JSON.stringify(pendencias || {}));
    } catch (_) {}
  }

  function criarPayloadEstadoFinal(item, resetar) {
    return {
      status: resetar ? "retornada" : "concluida",
      etapa: resetar || "",
      usuario: state.usuario.nome || "",
      login: state.usuario.login || "",
      ts: Date.now(),
      competencia: item ? item.competencia : "",
      fornecedor: item ? item.fornecedor : "",
      tipo_documento: item ? item.tipo : "",
      valor: item ? item.valor : "",
    };
  }

  function guardarPendenciaFirebase(id, payload) {
    const pendencias = carregarPendenciasFirebase();
    pendencias[id] = {
      payload: payload,
      tentativas: Number(pendencias[id] && pendencias[id].tentativas || 0),
      atualizadoEm: Date.now(),
    };
    salvarPendenciasFirebase(pendencias);
  }

  function removerPendenciaFirebase(id) {
    const pendencias = carregarPendenciasFirebase();
    if (!Object.prototype.hasOwnProperty.call(pendencias, id)) return;
    delete pendencias[id];
    salvarPendenciasFirebase(pendencias);
  }

  // ESTADO_FINAL_SEM_SOBRESCREVER_OPERADOR_V5_3_4:
  // Retransmissões não podem substituir uma conclusão MAIS RECENTE de
  // outro operador. O estado por ID é somente o último estado; o histórico
  // completo está nos eventos imutáveis em historico/by_id.
  async function gravarEstadoFinalComVersao(id, payload) {
    const url = firebaseUrl(CONFIG.firebaseEstadoPainel + "/" + encodeURIComponent(id));
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const leitura = await gmRequest({
        method: "GET", url: url,
        headers: { "Accept": "application/json", "X-Firebase-ETag": "true" },
        timeout: 12000,
      });
      if (!leitura || leitura.status < 200 || leitura.status >= 300) {
        throw new Error("Firebase não confirmou a leitura do estado final.");
      }
      const remoto = parseJsonSeguro(leitura.responseText || "null", null);
      if (remoto && Number(remoto.ts || 0) >= Number(payload.ts || 0)) {
        return remoto;
      }
      const headers = { "Content-Type": "application/json" };
      const etag = obterCabecalhoResposta(leitura, "etag");
      if (!etag) throw new Error("Sem ETag; atualização suspensa para proteger o operador histórico.");
      headers["If-Match"] = etag;
      const resposta = await gmRequest({
        method: "PUT", url: url, headers: headers,
        data: JSON.stringify(payload), timeout: 12000,
      });
      if (resposta && resposta.status === 412) continue;
      if (!resposta || resposta.status < 200 || resposta.status >= 300) {
        throw new Error("Firebase não confirmou a gravação do estado final.");
      }
      return payload;
    }
    throw new Error("Concorrência na gravação do estado final; será tentada novamente.");
  }

  async function sincronizarUmaPendenciaFirebase(id, registro) {
    const payload = registro && registro.payload ? registro.payload : registro;
    if (!id || !payload) return false;

    // Grava condicionalmente, sem substituir uma atribuição mais recente.
    const estadoPreservado = await gravarEstadoFinalComVersao(id, payload);

    // REGRA_RESERVA_PERMANENTE_V5_3_5:
    // Ao salvar a conclusão no estado, NÃO excluir o operador da reserva.
    // Nunca apagar a reserva apenas porque o chamado saiu da fila financeira.
    state.estados[id] = estadoPreservado;
    removerPendenciaFirebase(id);
    return true;
  }

  function agendarSincronizacaoFirebase(atraso) {
    if (state.firebaseRetryTimer) clearTimeout(state.firebaseRetryTimer);
    state.firebaseRetryTimer = setTimeout(function () {
      state.firebaseRetryTimer = null;
      void sincronizarPendenciasFirebase();
    }, Math.max(0, Number(atraso || 0)));
  }

  // SEGURANCA_PENDENCIA_ANTIGA_V5_3_3
  // Uma pendência guardada meses atrás NÃO é um evento novo. Depois que as
  // regras do Firebase foram liberadas, versões anteriores reenviavam esses
  // dados ao estado ativo e tentavam liberar reservas de hoje. Não fazemos
  // mais nenhuma dessas operações para pendências vencidas. Permanecem no
  // localStorage original, sem modificação, para importação histórica manual.
  function pendenciaOperacionalRecente(registro) {
    const payload = registro && registro.payload ? registro.payload : registro;
    const ts = Number(payload && payload.ts || 0);
    const idade = Date.now() - ts;
    return Number.isFinite(ts) && ts > 0 && idade >= -60000
      && idade <= CONFIG.validadeEstadoFinalMs;
  }

  async function sincronizarPendenciasFirebase() {
    if (state.sincronizandoFirebase) return;

    const pendencias = carregarPendenciasFirebase();
    const ids = Object.keys(pendencias).filter(function (id) {
      return pendenciaOperacionalRecente(pendencias[id]);
    });
    if (!ids.length) {
      const antigas = Object.keys(pendencias).length;
      if (antigas) {
        console.info(PREFIXO, antigas + " pendência(s) antiga(s) preservada(s) localmente, "
          + "sem reenviar à fila atual nem liberar reservas. Nenhum dado foi apagado.");
      }
      return;
    }

    state.sincronizandoFirebase = true;
    try {
      for (const id of ids) {
        try {
          await sincronizarUmaPendenciaFirebase(id, pendencias[id]);
        } catch (falha) {
          const atuais = carregarPendenciasFirebase();
          if (atuais[id]) {
            atuais[id].tentativas = Number(atuais[id].tentativas || 0) + 1;
            atuais[id].atualizadoEm = Date.now();
            salvarPendenciasFirebase(atuais);
          }
          console.warn(PREFIXO, `Sincronização Firebase pendente para a despesa ${id}.`, falha);
        }
      }
    } finally {
      state.sincronizandoFirebase = false;

      // Apenas pendências recentes são repetidas; as antigas ficam intactas
      // no armazenamento local, sem gerar escritas contínuas no Firebase.
      const restantes = carregarPendenciasFirebase();
      const registros = Object.values(restantes).filter(pendenciaOperacionalRecente);
      if (registros.length) {
        const maiorTentativa = registros.reduce(function (maior, registro) {
          return Math.max(maior, Number(registro && registro.tentativas || 0));
        }, 0);
        const proximoAtraso = Math.min(
          5 * 60 * 1000,
          15000 * Math.pow(2, Math.min(maiorTentativa, 4))
        );
        agendarSincronizacaoFirebase(proximoAtraso);
      }
    }
  }

  function gravarEstadoFinal(item, resetar) {
    if (!item || !item.id) return null;

    const payload = criarPayloadEstadoFinal(item, resetar);

    // Salva a trilha do documento sem alterar a reserva permanente do operador.
    // O envio possui uma fila local para repetir falhas.
    registrarMetadadosDespesa(item, donoReserva(item.id) || state.usuario.nome);
    registrarEventoHistorico(item.id, resetar ? "retorno" : "conclusao", state.usuario,
      donoReserva(item.id), donoReserva(item.id));

    // Atualiza a tela imediatamente após a confirmação do InfraDesk.
    // A sincronização remota é idempotente e será repetida até funcionar.
    state.estados[item.id] = payload;
    // Reserva mantida: o gráfico continua atribuindo ao operador original.
    guardarPendenciaFirebase(item.id, payload);
    agendarSincronizacaoFirebase(0);

    return payload;
  }

  function conectarRealtimeReservas() {
    return conectarRealtimePainel(
      CONFIG.firebaseReservas,
      state.reservas,
      "eventosReserva",
      "reservas"
    );
  }

  function conectarRealtimeEstados() {
    return conectarRealtimePainel(
      CONFIG.firebaseEstadoPainel,
      state.estados,
      "eventosEstado",
      "estados"
    );
  }

  function conectarRealtimePainel(caminho, alvo, propriedade, rotulo) {
    return new Promise(function (resolve) {
      let resolvido = false;
      const concluir = function () {
        if (resolvido) return;
        resolvido = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(concluir, 4000);

      try {
        if (state[propriedade]) state[propriedade].close();
        const es = new EventSource(firebaseUrl(caminho));
        const receber = function (evento) {
          aplicarEventoFirebase(evento.data, alvo);
          concluir();
        };
        es.addEventListener("put", receber);
        es.addEventListener("patch", receber);
        es.onerror = function () {};
        state[propriedade] = es;
      } catch (falha) {
        console.warn(PREFIXO, "Realtime " + rotulo, falha);
        concluir();
      }
    });
  }

  function aplicarEventoFirebase(raw, alvo) {
    try {
      const evento = JSON.parse(raw || "{}");
      const caminho = String(evento.path || "");
      const data = evento.data;
      // Reconnects/SSE idempotentes não devem reconstruir a tabela inteira.
      const estadoAnterior = JSON.stringify(alvo);
      if (caminho === "/" || caminho === "") {
        Object.keys(alvo).forEach(function (k) { delete alvo[k]; });
        if (data && typeof data === "object") Object.assign(alvo, data);
      } else {
        const partes = caminho.replace(/^\/+/, "").split("/").filter(Boolean);
        const id = partes[0];
        if (!id) return;
        if (partes.length === 1) {
          if (data == null) delete alvo[id]; else alvo[id] = data;
        } else {
          if (!alvo[id] || typeof alvo[id] !== "object") alvo[id] = {};
          if (data == null) delete alvo[id][partes[1]]; else alvo[id][partes[1]] = data;
        }
      }
      if (JSON.stringify(alvo) === estadoAnterior) return;
      if (alvo === state.reservas) agendarCapturaMetadadosPainel();
      if (!state.inicializando && state.filtrosProntos) {
        atualizarOpcoesResponsavel();
        agendarRender(60);
      } else {
        state.renderPendente = true;
      }
    } catch (_) {}
  }

  function estaFinalizadaRecentemente(id) {
    const registro = state.estados[id];
    if (!registro || typeof registro !== "object") return false;
    const ts = Number(registro.ts || 0);
    if (!ts || Date.now() - ts > CONFIG.validadeEstadoFinalMs) return false;
    return registro.status === "concluida" || registro.status === "retornada";
  }

  async function limparEstadosFirebaseExpirados() {
    const chaveUltimaLimpeza = "sigma-painel-financeiro-limpeza-estados-v1";
    const agora = Date.now();

    try {
      const ultima = Number(localStorage.getItem(chaveUltimaLimpeza) || 0);
      if (ultima && agora - ultima < 6 * 60 * 60 * 1000) return;
    } catch (_) {}

    // Mantém uma margem adicional além das 12 horas usadas pela interface.
    const limite = agora - Math.max(CONFIG.validadeEstadoFinalMs * 2, 24 * 60 * 60 * 1000);
    const patch = {};

    Object.keys(state.estados).forEach(function (id) {
      const registro = state.estados[id];
      const ts = Number(registro && registro.ts || 0);
      if (ts && ts < limite) patch[id] = null;
    });

    const ids = Object.keys(patch);
    if (!ids.length) {
      if (Object.keys(state.estados).length) {
        try { localStorage.setItem(chaveUltimaLimpeza, String(agora)); } catch (_) {}
      }
      return;
    }

    try {
      const resposta = await gmRequest({
        method: "PATCH",
        url: firebaseUrl(CONFIG.firebaseEstadoPainel),
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(patch),
        timeout: 15000,
      });
      if (!resposta || resposta.status < 200 || resposta.status >= 300) return;

      ids.forEach(function (id) { delete state.estados[id]; });
      try { localStorage.setItem(chaveUltimaLimpeza, String(agora)); } catch (_) {}
    } catch (falha) {
      console.warn(PREFIXO, "Limpeza dos estados temporários", falha);
    }
  }

  // =========================================================
  // FILTROS_E_ORGANIZACAO
  // =========================================================
  function valorFiltro(id) {
    const el = document.getElementById(id);
    return el ? texto(el.value) : "";
  }

  function situacaoAtual() {
    const ativo = document.querySelector("[data-situacao].ativo");
    return ativo ? ativo.dataset.situacao : "todas";
  }

  function despesasVisiveis() {
    const busca = normalizar(valorFiltro("sigma-busca"));
    const competencia = valorFiltro("sigma-filtro-competencia");
    const setor = valorFiltro("sigma-filtro-setor");
    const fornecedor = valorFiltro("sigma-filtro-fornecedor");
    const tipo = valorFiltro("sigma-filtro-tipo");
    const ownerFiltro = valorFiltro("sigma-filtro-owner");
    const situacao = situacaoAtual();

    return state.despesas.filter(function (item) {
      if (estaFinalizadaRecentemente(item.id)) return false;
      const owner = donoReserva(item.id);
      const dias = diasPara(item.vencimento);

      if (busca && !item.busca.includes(busca)) return false;
      if (competencia && item.competencia !== competencia) return false;
      if (setor && item.setorContratante !== setor) return false;
      if (fornecedor && item.fornecedor !== fornecedor) return false;
      if (tipo && item.tipo !== tipo) return false;
      if (ownerFiltro === "__livre__" && owner) return false;
      if (ownerFiltro && ownerFiltro !== "__livre__" && owner !== ownerFiltro) return false;

      // Para o usuário que está trabalhando, "Livres" significa:
      // despesas sem responsável + despesas já assumidas por ele próprio.
      if (situacao === "livres" && owner && !mesmaPessoa(owner, state.usuario.nome)) return false;
      if (situacao === "minhas" && !mesmaPessoa(owner, state.usuario.nome)) return false;
      if (situacao === "reservadas" && !owner) return false;
      if (situacao === "vencidas" && !(dias != null && dias < 0)) return false;
      return true;
    });
  }

  function reconstruirOpcoesFiltros() {
    preencherSelect("sigma-filtro-competencia", state.despesas.map(function (i) { return i.competencia; }), "Todas", ordenarCompetencias);
    preencherSelectSetorComContagem();
    preencherSelectFornecedorComContagem();
    preencherSelect("sigma-filtro-tipo", state.despesas.map(function (i) { return i.tipo; }), "Todos");
    atualizarOpcoesResponsavel();
  }

  // =========================================================
  // CONTAGEM_NO_FILTRO_SETOR_CONTRATANTE
  // CTRL + F: CONTAGEM_NO_FILTRO_SETOR_CONTRATANTE
  // Igual ao fornecedor: mostra SETOR (quantidade) sem alterar o VALUE.
  // A contagem respeita todos os outros filtros e ignora somente Setor.
  // =========================================================
  function despesasParaContagemSetor() {
    const busca = normalizar(valorFiltro("sigma-busca"));
    const competencia = valorFiltro("sigma-filtro-competencia");
    const fornecedor = valorFiltro("sigma-filtro-fornecedor");
    const tipo = valorFiltro("sigma-filtro-tipo");
    const ownerFiltro = valorFiltro("sigma-filtro-owner");
    const situacao = situacaoAtual();

    return state.despesas.filter(function (item) {
      if (estaFinalizadaRecentemente(item.id)) return false;
      const owner = donoReserva(item.id);
      const dias = diasPara(item.vencimento);

      if (busca && !item.busca.includes(busca)) return false;
      if (competencia && item.competencia !== competencia) return false;
      if (fornecedor && item.fornecedor !== fornecedor) return false;
      if (tipo && item.tipo !== tipo) return false;
      if (ownerFiltro === "__livre__" && owner) return false;
      if (ownerFiltro && ownerFiltro !== "__livre__" && owner !== ownerFiltro) return false;
      if (situacao === "livres" && owner && !mesmaPessoa(owner, state.usuario.nome)) return false;
      if (situacao === "minhas" && !mesmaPessoa(owner, state.usuario.nome)) return false;
      if (situacao === "reservadas" && !owner) return false;
      if (situacao === "vencidas" && !(dias != null && dias < 0)) return false;
      return true;
    });
  }

  function preencherSelectSetorComContagem() {
    const select = document.getElementById("sigma-filtro-setor");
    if (!select) return;

    const atual = select.value;
    const itens = despesasParaContagemSetor();
    const contagens = new Map();

    itens.forEach(function (item) {
      const nome = texto(item.setorContratante) || "Sem setor";
      contagens.set(nome, (contagens.get(nome) || 0) + 1);
    });

    const nomes = Array.from(contagens.keys()).sort(function (a, b) {
      return a.localeCompare(b, "pt-BR");
    });

    select.innerHTML = `<option value="">Todos (${itens.length})</option>` + nomes.map(function (nome) {
      return `<option value="${escaparHtml(nome)}">${escaparHtml(nome)} (${contagens.get(nome) || 0})</option>`;
    }).join("");

    if (Array.from(select.options).some(function (option) { return option.value === atual; })) {
      select.value = atual;
    }
  }

  // =========================================================
  // CONTAGEM_NO_FILTRO_FORNECEDOR
  // Mostra FORNECEDOR (10), mas mantém o VALUE somente com o nome.
  // A contagem respeita os demais filtros ativos e ignora apenas a
  // seleção atual de fornecedor.
  // =========================================================
  function despesasParaContagemFornecedor() {
    const busca = normalizar(valorFiltro("sigma-busca"));
    const competencia = valorFiltro("sigma-filtro-competencia");
    const setor = valorFiltro("sigma-filtro-setor");
    const tipo = valorFiltro("sigma-filtro-tipo");
    const ownerFiltro = valorFiltro("sigma-filtro-owner");
    const situacao = situacaoAtual();

    return state.despesas.filter(function (item) {
      if (estaFinalizadaRecentemente(item.id)) return false;
      const owner = donoReserva(item.id);
      const dias = diasPara(item.vencimento);

      if (busca && !item.busca.includes(busca)) return false;
      if (competencia && item.competencia !== competencia) return false;
      if (setor && item.setorContratante !== setor) return false;
      if (tipo && item.tipo !== tipo) return false;
      if (ownerFiltro === "__livre__" && owner) return false;
      if (ownerFiltro && ownerFiltro !== "__livre__" && owner !== ownerFiltro) return false;
      if (situacao === "livres" && owner && !mesmaPessoa(owner, state.usuario.nome)) return false;
      if (situacao === "minhas" && !mesmaPessoa(owner, state.usuario.nome)) return false;
      if (situacao === "reservadas" && !owner) return false;
      if (situacao === "vencidas" && !(dias != null && dias < 0)) return false;
      return true;
    });
  }

  function preencherSelectFornecedorComContagem() {
    const select = document.getElementById("sigma-filtro-fornecedor");
    if (!select) return;

    const atual = select.value;
    const itens = despesasParaContagemFornecedor();
    const contagens = new Map();

    itens.forEach(function (item) {
      const nome = texto(item.fornecedor) || "Sem fornecedor";
      contagens.set(nome, (contagens.get(nome) || 0) + 1);
    });

    const nomes = Array.from(contagens.keys()).sort(function (a, b) {
      return a.localeCompare(b, "pt-BR");
    });

    select.innerHTML = `<option value="">Todos (${itens.length})</option>` + nomes.map(function (nome) {
      return `<option value="${escaparHtml(nome)}">${escaparHtml(nome)} (${contagens.get(nome) || 0})</option>`;
    }).join("");

    if (Array.from(select.options).some(function (option) { return option.value === atual; })) {
      select.value = atual;
    }
  }

  function atualizarOpcoesResponsavel() {
    const selectOwner = document.getElementById("sigma-filtro-owner");
    if (!selectOwner) return;

    const atual = selectOwner.value;
    const owners = Object.keys(state.reservas).map(donoReserva).filter(Boolean);
    const unicos = Array.from(new Set(owners)).sort(function (a, b) { return a.localeCompare(b, "pt-BR"); });
    selectOwner.innerHTML = '<option value="">Todos</option><option value="__livre__">Sem usuário</option>' +
      unicos.map(function (nome) { return `<option value="${escaparHtml(nome)}">${escaparHtml(nome)}</option>`; }).join("");
    if (Array.from(selectOwner.options).some(function (o) { return o.value === atual; })) {
      selectOwner.value = atual;
    }
  }

  function preencherSelect(id, valores, textoTodos, comparador) {
    const select = document.getElementById(id);
    const atual = select.value;
    const unicos = Array.from(new Set(valores.filter(Boolean)));
    unicos.sort(comparador || function (a, b) { return a.localeCompare(b, "pt-BR"); });
    select.innerHTML = `<option value="">${textoTodos}</option>` + unicos.map(function (v) {
      return `<option value="${escaparHtml(v)}">${escaparHtml(v)}</option>`;
    }).join("");
    if (Array.from(select.options).some(function (o) { return o.value === atual; })) select.value = atual;
  }

  function ordenarCompetencias(a, b) {
    const converter = function (v) {
      const m = String(v).match(/^(\d{2})\/(\d{4})$/);
      return m ? Number(m[2]) * 100 + Number(m[1]) : 999999;
    };
    return converter(a) - converter(b);
  }

  // =========================================================
  // PREFERENCIAS_LOCAIS_POR_USUARIO
  // Guarda todos os campos, a organização e o chip selecionado.
  // Para localizar depois, use CTRL + F e procure por:
  // PREFERENCIAS_LOCAIS_POR_USUARIO
  // =========================================================
  function nomeUsuarioPreferencias() {
    if (state.usuario.nome) return state.usuario.nome;
    try {
      return localStorage.getItem("sigma-painel-financeiro-ultimo-usuario") || "usuario";
    } catch (_) {
      return "usuario";
    }
  }

  function chavePreferenciasPainel() {
    return "sigma-painel-financeiro-filtros-v2:"
      + normalizar(nomeUsuarioPreferencias())
      + ":"
      + (state.abaAtual === "pendentes" ? "pendentes" : "agendar");
  }

  function lerPreferenciasPainel() {
    try {
      const bruto = localStorage.getItem(chavePreferenciasPainel());
      const dados = bruto ? JSON.parse(bruto) : null;
      return dados && typeof dados === "object" ? dados : {};
    } catch (_) {
      return {};
    }
  }

  function salvarPreferenciasPainel() {
    if (state.restaurandoPreferencias) return;

    const dados = {
      busca: valorFiltro("sigma-busca"),
      competencia: valorFiltro("sigma-filtro-competencia"),
      setor: valorFiltro("sigma-filtro-setor"),
      fornecedor: valorFiltro("sigma-filtro-fornecedor"),
      tipo: valorFiltro("sigma-filtro-tipo"),
      responsavel: valorFiltro("sigma-filtro-owner"),
      organizacao: valorFiltro("sigma-organizacao") || "competencia",
      situacao: situacaoAtual() || "todas",
      salvoEm: Date.now(),
    };

    try {
      localStorage.setItem(chavePreferenciasPainel(), JSON.stringify(dados));
      localStorage.setItem("sigma-painel-financeiro-ultimo-usuario", nomeUsuarioPreferencias());
    } catch (_) {}
  }

  function aplicarValorSeDisponivel(id, valor) {
    const el = document.getElementById(id);
    if (!el || valor == null) return;

    if (el.tagName === "SELECT") {
      const existe = Array.from(el.options).some(function (option) { return option.value === String(valor); });
      if (!existe) return;
    }

    el.value = String(valor);
  }

  function restaurarPreferenciasPainel(somenteBasicos) {
    const dados = lerPreferenciasPainel();
    state.restaurandoPreferencias = true;

    try {
      aplicarValorSeDisponivel("sigma-busca", dados.busca || "");
      aplicarValorSeDisponivel("sigma-organizacao", dados.organizacao || "competencia");

      const situacao = dados.situacao || "todas";
      const botaoSituacao = document.querySelector(`[data-situacao="${escaparCss(situacao)}"]`);
      if (botaoSituacao) {
        document.querySelectorAll("[data-situacao]").forEach(function (botao) { botao.classList.remove("ativo"); });
        botaoSituacao.classList.add("ativo");
      }

      if (!somenteBasicos) {
        aplicarValorSeDisponivel("sigma-filtro-competencia", dados.competencia || "");
        aplicarValorSeDisponivel("sigma-filtro-setor", dados.setor || "");
        aplicarValorSeDisponivel("sigma-filtro-fornecedor", dados.fornecedor || "");
        aplicarValorSeDisponivel("sigma-filtro-tipo", dados.tipo || "");
        aplicarValorSeDisponivel("sigma-filtro-owner", dados.responsavel || "");
      }
    } finally {
      state.restaurandoPreferencias = false;
    }
  }

  // =========================================================
  // RENDERIZAR_TABELA
  // Uma única tabela é mantida para continuar compatível com o
  // Tampermonkey de trava por usuário.
  // =========================================================
  function agendarRender(atraso) {
    if (state.inicializando || state.carregando || !state.filtrosProntos) {
      state.renderPendente = true;
      return;
    }

    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(function () {
      state.renderPendente = false;
      renderizar();
    }, Number(atraso == null ? 60 : atraso));
  }

  function renderizar() {
    const corpo = document.getElementById("sigma-corpo-tabela");
    if (!corpo) return;

    preencherSelectSetorComContagem();
    preencherSelectFornecedorComContagem();
    atualizarContadores();
    const lista = despesasVisiveis();
    const organizacao = valorFiltro("sigma-organizacao") || "competencia";
    ordenarLista(lista, organizacao);

    if (!lista.length) {
      corpo.innerHTML = '<tr><td colspan="9" class="sigma-vazio"><i class="fa-regular fa-folder-open"></i><br>Nenhuma despesa encontrada com estes filtros.</td></tr>';
      return;
    }

    const quantidadePorGrupo = new Map();
    lista.forEach(function (item) {
      const grupo = obterGrupo(item, organizacao);
      quantidadePorGrupo.set(grupo, (quantidadePorGrupo.get(grupo) || 0) + 1);
    });

    let html = "";
    let grupoAnterior = null;
    lista.forEach(function (item) {
      const grupo = obterGrupo(item, organizacao);
      if (grupo !== grupoAnterior) {
        html += `<tr class="sigma-grupo"><td colspan="9">${escaparHtml(grupo)} <span style="color:#64748b;font-weight:700">• ${quantidadePorGrupo.get(grupo) || 0} despesa(s)</span></td></tr>`;
        grupoAnterior = grupo;
      }
      html += htmlDespesa(item);
    });

    corpo.innerHTML = html;
  }

  function ordenarLista(lista, modo) {
    lista.sort(function (a, b) {
      const ownerA = donoReserva(a.id) || "Sem usuário";
      const ownerB = donoReserva(b.id) || "Sem usuário";
      let primeiro = 0;

      if (modo === "competencia") primeiro = ordenarCompetencias(a.competencia, b.competencia);
      if (modo === "fornecedor") primeiro = a.fornecedor.localeCompare(b.fornecedor, "pt-BR") || ordenarCompetencias(a.competencia, b.competencia);
      if (modo === "tipo") primeiro = a.tipo.localeCompare(b.tipo, "pt-BR") || ordenarCompetencias(a.competencia, b.competencia);
      if (modo === "responsavel") primeiro = ownerA.localeCompare(ownerB, "pt-BR") || ordenarCompetencias(a.competencia, b.competencia);
      if (primeiro) return primeiro;
      return chaveData(a.vencimento) - chaveData(b.vencimento) || Number(a.id) - Number(b.id);
    });
  }

  function obterGrupo(item, modo) {
    if (modo === "fornecedor") return "Fornecedor: " + (item.fornecedor || "Sem fornecedor");
    if (modo === "tipo") return "Tipo: " + (item.tipo || "Sem tipo");
    if (modo === "responsavel") return "Responsável: " + (donoReserva(item.id) || "Sem usuário");
    if (modo === "vencimento") return "Fila por vencimento";
    return "Competência " + item.competencia;
  }

  // =========================================================
  // CARD_COMPACTO_DA_DESPESA
  // CTRL + F: CARD_COMPACTO_DA_DESPESA
  // Card fechado + ID/fluxo + dados + status/plano/setor + observação interna.
  // =========================================================
  function htmlDespesa(item) {
    const owner = donoReserva(item.id);
    const bloqueado = owner && !mesmaPessoa(owner, state.usuario.nome);
    const dias = diasPara(item.vencimento);
    const classeData = dias == null ? "" : dias < 0 ? "vencida" : dias === 0 ? "hoje" : "";
    const cor = corUsuario(owner);
    const textoOwner = owner || "Sem usuário";
    const reservando = state.reservandoIds.has(item.id);
    const acaoOwner = owner
      ? `<button type="button" data-liberar-id="${escaparHtml(item.id)}" title="${mesmaPessoa(owner, state.usuario.nome) ? "Liberar" : "Remover reserva de " + escaparHtml(owner)}" ${reservando ? "disabled" : ""}>×</button>`
      : `<button type="button" class="sigma-owner-reservar" data-reservar-id="${escaparHtml(item.id)}" title="Reservar para ${escaparHtml(state.usuario.nome || "o usuário logado")}" ${reservando ? "disabled" : ""}>+</button>`;

    const marcadores = (item.marcadoresTipo || []).map(function (marcador) {
      const classes = marcador.classes || "fa-solid fa-circle-info";
      return `<i class="${escaparHtml(classes)}" title="${escaparHtml(marcador.titulo || "Marcador especial")}"></i>`;
    }).join("");

    const tipoHtml = `<span class="sigma-tipo-conteudo">`
      + (item.imagemTipoSrc ? `<img class="sigma-tipo-img" src="${escaparHtml(item.imagemTipoSrc)}" alt="">` : "")
      + `<span class="sigma-tipo-texto" title="${escaparHtml(item.tipo)}">${escaparHtml(item.tipo)}</span>`
      + (marcadores ? `<span class="sigma-tipo-extra">${marcadores}</span>` : "")
      + `</span>`;

    const fluxo = item.fluxo || {};
    const fluxoHtml = [
      ["criado", "Criado por"],
      ["revisado", "Revisado por"],
      ["aprovado", "Aprovado por"],
      ["fiscal", "Fiscal"],
      ["agendado", "Agendado por"],
    ].map(function (par) {
      const etapa = fluxo[par[0]];
      if (!etapa || !etapa.usuario) return "";
      const tituloData = etapa.data ? ` title="${escaparHtml(etapa.data)}"` : "";
      return `<span class="sigma-fluxo"${tituloData}><strong>${escaparHtml(par[1])}:</strong> ${escaparHtml(etapa.usuario)}</span>`;
    }).filter(Boolean).join("");

    const antecipadoHtml = item.pagamentoAntecipado
      ? `<span class="sigma-pgto-antecipado"><i class="fa-solid fa-forward-fast"></i> Pgto Antecipado</span>`
      : "";

    let html = "";
    const temObservacao = !!(item.observacoes && item.observacoes.length);

    // Linha compacta do ID + pessoas que participaram do fluxo.
    html += `<tr class="tr-index sigma-despesa sigma-despesa-meta" data-sigma-id="${escaparHtml(item.id)}">
      <td colspan="9">
        <div class="sigma-meta-linha">
          <div class="sigma-meta-esquerda">
            <span class="sigma-numero-id">ID ${escaparHtml(item.id)}</span>
            ${fluxoHtml || '<span class="sigma-fluxo">Histórico ainda não informado</span>'}
          </div>
          <div class="sigma-meta-direita">
            <span class="sigma-owner" style="${owner ? `background:${cor};border-color:${cor};color:#fff` : ""}">${escaparHtml(textoOwner)}${acaoOwner}</span>
            ${item.financeUrl
              ? `<button type="button" class="btn btn-success btn-sm sigma-financeiro ${bloqueado ? "tm-finance-blocked disabled" : "tm-finance-free"}" data-sigma-id="${escaparHtml(item.id)}" data-sigma-finance-url="${escaparHtml(item.financeUrl)}" data-tm-blocked-by-user="${bloqueado ? "1" : "0"}" title="${bloqueado ? "Bloqueado: " + escaparHtml(owner) : "Abrir financeiro"}" ${bloqueado ? "disabled aria-disabled=\"true\"" : ""}><i class="fa-regular fa-money-bill-1"></i></button>`
              : ""}
          </div>
        </div>
      </td>
    </tr>`;

    // Dados principais. A competência nativa e os encargos não são exibidos.
    html += `<tr class="sigma-despesa-dados" data-sigma-id="${escaparHtml(item.id)}">
      <td class="sigma-id">${item.numeroDocumento ? `<small style="font-size:12px;color:#172033"><strong>Nº Doc:</strong> ${escaparHtml(item.numeroDocumento)}</small>` : '<small>—</small>'}</td>
      <td class="sigma-desc" title="${escaparHtml(item.descricao)}">${escaparHtml(item.descricao)}</td>
      <td class="sigma-fornecedor" title="${escaparHtml(item.fornecedor)}">${escaparHtml(item.fornecedor)}${antecipadoHtml}</td>
      <td class="sigma-tipo">${tipoHtml}</td>
      <td class="sigma-data">${escaparHtml(item.emissaoTexto)}</td>
      <td class="sigma-data ${classeData}" title="${dias == null ? "" : dias < 0 ? Math.abs(dias) + " dia(s) vencida" : dias + " dia(s)"}">${escaparHtml(item.vencimentoTexto)}</td>
      <td class="sigma-valor">${escaparHtml(item.valor)}</td>
      <td></td>
      <td></td>
    </tr>`;

    // Status + conta contábil + setor contratante ficam na mesma linha fina.
    html += `<tr class="sigma-despesa-rodape ${temObservacao ? "" : "sem-observacao"}" data-sigma-id="${escaparHtml(item.id)}">
      <td colspan="9">
        <div class="sigma-rodape-linha">
          ${item.statusTexto ? `<span class="sigma-status-mini" style="max-width:none;margin-top:0;font-size:10px">${escaparHtml(item.statusTexto)}</span>` : ""}
          ${item.planoConta ? `<span class="sigma-plano-conta"><strong>Plano de Contas:</strong> ${escaparHtml(item.planoConta)}</span>` : ""}
          ${item.setorContratante ? `<span class="sigma-setor-contratante"><strong>Setor Contratante:</strong> ${escaparHtml(item.setorContratante)}</span>` : ""}
        </div>
      </td>
    </tr>`;

    // A observação agora pertence claramente ao card e fecha sua borda.
    if (temObservacao) {
      html += `<tr class="sigma-observacoes" data-sigma-id="${escaparHtml(item.id)}"><td colspan="9">${item.observacoes.map(function (obs) {
        return `<span class="sigma-observacao">${escaparHtml(obs)}</span>`;
      }).join("")}</td></tr>`;
    }

    html += '<tr class="sigma-card-separador" aria-hidden="true"><td colspan="9"></td></tr>';

    return html;
  }

  function atualizarContadores() {
    const ativos = state.despesas.filter(function (item) { return !estaFinalizadaRecentemente(item.id); });
    const minhas = ativos.filter(function (item) { return mesmaPessoa(donoReserva(item.id), state.usuario.nome); }).length;
    const livresSemDono = ativos.filter(function (item) { return !donoReserva(item.id); }).length;
    const livres = livresSemDono + minhas;
    const reservadas = ativos.filter(function (item) { return !!donoReserva(item.id); }).length;
    const vencidas = ativos.filter(function (item) { const d = diasPara(item.vencimento); return d != null && d < 0; }).length;
    document.getElementById("sigma-total").textContent = ativos.length;
    document.getElementById("sigma-livres").textContent = livres;
    document.getElementById("sigma-minhas").textContent = minhas;
    document.getElementById("sigma-reservadas").textContent = reservadas;
    document.getElementById("sigma-vencidas").textContent = vencidas;
  }

  function atualizarStatus(mensagem) {
    const el = document.getElementById("sigma-status-carregamento");
    if (el) el.textContent = mensagem;
  }

  // =========================================================
  // MODAL_FINANCEIRO_REAL
  // O conteúdo vem do endpoint verdadeiro do InfraDesk.
  // O Tampermonkey Assistente atua no modal e usa a extensão somente como motor de PDF.
  // =========================================================
  function corpoPrincipalModal() {
    const conteudo = document.querySelector("#ModalDespesas > .modal-dialog > .modal-content");
    if (!conteudo) return null;

    return Array.from(conteudo.children).find(function (filho) {
      return filho.classList && filho.classList.contains("modal-body");
    }) || conteudo.querySelector(".modal-body");
  }

  function itemDespesaPorId(id) {
    id = texto(id);
    if (!id) return null;

    const encontrado = state.despesas.find(function (item) {
      return texto(item && item.id) === id;
    });
    if (encontrado) return encontrado;

    return state.itemModal && texto(state.itemModal.id) === id
      ? state.itemModal
      : null;
  }

  function criarFaixaObservacaoModal(form) {
    if (!form) return null;

    let faixa = document.getElementById("sigma-modal-observacao");
    if (faixa && form.contains(faixa)) return faixa;
    if (faixa) faixa.remove();

    faixa = document.createElement("div");
    faixa.className = "sigma-modal-observacao";
    faixa.id = "sigma-modal-observacao";
    faixa.innerHTML = `
      <i class="fa-solid fa-comment-dots"></i>
      <span class="sigma-modal-observacao-texto"><strong>Observação:</strong> Carregando...</span>
    `;

    const destino =
      form.querySelector(".despesa-modal-scroll") ||
      form.querySelector(".ctn-form") ||
      form;

    destino.insertBefore(faixa, destino.firstChild);
    return faixa;
  }

  function adaptarEstruturaModalAtual(form) {
    if (!form) return;

    const modal = form.closest("#ModalDespesas");
    const dialog = modal ? modal.querySelector(":scope > .modal-dialog") : null;
    const conteudo = dialog ? dialog.querySelector(":scope > .modal-content") : null;
    const body = corpoPrincipalModal();
    const layoutNovo = form.querySelector(".despesa-modal-layout");

    if (dialog) dialog.classList.add("modal-xl", "modal-despesas-dialog");
    if (body) body.classList.toggle("sigma-modal-body-novo", !!layoutNovo);
    if (modal) modal.dataset.sigmaLayoutFinanceiro = layoutNovo ? "novo" : "legado";

    // Remove somente o cabeçalho criado pelas versões antigas deste painel.
    // O formulário novo já possui seu próprio cabeçalho e botão de fechar.
    if (conteudo) {
      Array.from(conteudo.children).forEach(function (filho) {
        if (filho.classList && filho.classList.contains("sigma-modal-header-legado")) {
          filho.remove();
        }
      });
    }

    criarFaixaObservacaoModal(form);
  }

  function observacaoPrincipal(item) {
    if (!item || !Array.isArray(item.observacoes) || !item.observacoes.length) {
      return "Sem observação cadastrada para esta despesa.";
    }

    return item.observacoes
      .map(function (obs) { return texto(obs); })
      .filter(Boolean)
      .join(" | ");
  }

  function atualizarCabecalhoModal(item) {
    const alvo = document.querySelector("#sigma-modal-observacao .sigma-modal-observacao-texto");
    if (!alvo) return;

    const observacao = observacaoPrincipal(item);
    const id = item && item.id ? ` da despesa ${item.id}` : "";
    alvo.innerHTML = `<strong>Observação${escaparHtml(id)}:</strong> ${escaparHtml(observacao)}`;
  }

  function criarObservadorDoModal() {
    const body = corpoPrincipalModal();
    if (!body) return;
    state.modalObserver = new MutationObserver(function () {
      clearTimeout(criarObservadorDoModal.timer);
      criarObservadorDoModal.timer = setTimeout(function () {
        processarFormularioModal();
      }, 100);
    });
    state.modalObserver.observe(body, { childList: true, subtree: true });
  }

  async function processarFormularioModal() {
    const form = document.querySelector("#ModalDespesas form.form-financeiro");
    if (!form) return;
    const action = String(form.getAttribute("action") || "");
    const match = action.match(/\/backend\/despesas\/financeiro\/(\d+)/i);
    const id = match ? match[1] : "";
    const item = itemDespesaPorId(id);
    adaptarEstruturaModalAtual(form);
    if (item) {
      state.itemModal = item;
    }
    atualizarCabecalhoModal(item || { id: id, observacoes: [] });

    const campoLogin = form.querySelector('#pagamento-by, input[name="pagamento_by"]');
    const login = texto(campoLogin ? campoLogin.value : "");
    if (login) {
      state.usuario.login = login;
      document.documentElement.dataset.sigmaUsuarioLogin = login;
    }

    const observacao = form.querySelector("#financeiro-observacao");
    if (observacao) {
      observacao.placeholder = "Observação do pagamento ou obrigatória ao retornar uma etapa";

      // A observação do retorno deve ser escrita agora pelo usuário.
      // Nunca reaproveita a observação antiga exibida na fila.
      if (form.dataset.sigmaObservacaoNovaPreparada !== "1") {
        form.dataset.sigmaObservacaoNovaPreparada = "1";
        observacao.value = "";
        observacao.dispatchEvent(new Event("input", { bubbles: true }));
        observacao.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    try { await garantirDependenciasModal(); } catch (_) {}

    prepararRetornoSomenteNaTelaOriginal(form, id);

    // Clicar em Gravar sempre limpa qualquer retorno selecionado anteriormente.
    Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]')).forEach(function (botaoGravar) {
      const ehGravar = /gravar/i.test(texto(botaoGravar.textContent || botaoGravar.value || ""))
        || /fa-save/i.test(String(botaoGravar.innerHTML || ""));
      if (!ehGravar || botaoGravar.dataset.sigmaGravarPreparado === "1") return;

      botaoGravar.dataset.sigmaGravarPreparado = "1";
      botaoGravar.addEventListener("click", function () {
        const campoResetar = form.querySelector('[name="resetar"]');
        if (campoResetar) campoResetar.value = "";
        delete form.dataset.sigmaRetornoValor;
        delete form.dataset.sigmaEtapaRetorno;
      }, false);
    });

    if (form.dataset.sigmaAjaxInstalado !== "1") {
      form.dataset.sigmaAjaxInstalado = "1";
      form.addEventListener("submit", enviarFormularioViaAjax, false);
    }

    document.dispatchEvent(new CustomEvent("sigma:modal-financeiro-carregado", {
      detail: { despesaId: id, modalId: "ModalDespesas" },
    }));
  }

  async function garantirDependenciasModal() {
    if (state.dependenciasPromise) return state.dependenciasPromise;
    state.dependenciasPromise = (async function () {
      const w = paginaWindow();
      const $ = w.jQuery;
      incluirCss("sigma-sweetalert-css", "https://cdn.infradesk.app/css/plugins/sweetalert/sweetalert.css");
      incluirCss("sigma-select2-css", "https://cdnjs.cloudflare.com/ajax/libs/select2/4.0.13/css/select2.min.css");
      incluirCss("sigma-datepicker-css", "https://cdn.infradesk.app/css/plugins/datapicker/datepicker3.css");
      incluirCss("sigma-toastr-css", "https://cdn.infradesk.app/css/plugins/toastr/toastr.min.css");
      incluirCss("sigma-fileinput-css", "https://cdn.infradesk.app/css/plugins/fileinput/2fileinput.min.css");
      incluirCss("sigma-daterange-css", "https://cdn.infradesk.app/css/plugins/daterangepicker/daterangepicker-bs3.css");

      const scripts = [
        ["sigma-sweetalert-js", "https://cdn.infradesk.app/js/plugins/sweetalert/sweetalert.min.js", function () { return typeof w.swal === "function"; }],
        ["sigma-select2-js", "https://cdnjs.cloudflare.com/ajax/libs/select2/4.0.13/js/select2.min.js", function () { return $ && typeof $.fn.select2 === "function"; }],
        ["sigma-datepicker-js", "https://cdn.infradesk.app/js/plugins/datapicker/bootstrap-datepicker.js", function () { return $ && typeof $.fn.datepicker === "function"; }],
        ["sigma-datepicker-ptbr-js", "https://cdnjs.cloudflare.com/ajax/libs/bootstrap-datepicker/1.9.0/locales/bootstrap-datepicker.pt-BR.min.js", function () { return $ && $.fn.datepicker && $.fn.datepicker.dates && $.fn.datepicker.dates["pt-BR"]; }],
        ["sigma-toastr-js", "https://cdn.infradesk.app/js/plugins/toastr/toastr.min.js", function () { return typeof w.toastr === "object"; }],
        ["sigma-maskmoney-js", "https://cdn.infradesk.app/js/plugins/maskMoney/jquery.maskMoney.min.js", function () { return $ && typeof $.fn.maskMoney === "function"; }],
        ["sigma-maskedinput-js", "https://cdn.infradesk.app/js/jquery.maskedinput.min.js", function () { return $ && typeof $.fn.mask === "function"; }],
        ["sigma-fileinput-js", "https://cdn.infradesk.app/js/plugins/fileinput/2fileinput.min.js", function () { return $ && typeof $.fn.fileinput === "function"; }],
        ["sigma-moment-js", "https://cdn.infradesk.app/js/plugins/fullcalendar/moment.min.js", function () { return typeof w.moment === "function"; }],
        ["sigma-daterange-js", "https://cdn.infradesk.app/js/plugins/daterangepicker/daterangepicker.js", function () { return $ && typeof $.fn.daterangepicker === "function"; }],
      ];
      for (const item of scripts) await incluirScript(item[0], item[1], item[2]);
    })();
    try { await state.dependenciasPromise; } catch (falha) { state.dependenciasPromise = null; throw falha; }
  }

  function incluirCss(id, href) {
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id; link.rel = "stylesheet"; link.href = href;
    document.head.appendChild(link);
  }

  function incluirScript(id, src, pronto) {
    return new Promise(function (resolve, reject) {
      if (pronto && pronto()) { resolve(); return; }
      const existente = document.getElementById(id);
      if (existente) {
        existente.addEventListener("load", resolve, { once: true });
        existente.addEventListener("error", reject, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.id = id; script.src = src; script.async = false;
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener("error", function () { reject(new Error("Falha ao carregar " + src)); }, { once: true });
      document.head.appendChild(script);
    });
  }

  // =========================================================
  // GRAVAR_SEM_SAIR_DO_PAINEL
  // Respeita as validações que o formulário já instalou. Somente
  // quando elas permitem o envio, interceptamos e enviamos por fetch.
  // Depois da confirmação do InfraDesk, registra no Firebase.
  // =========================================================
  function urlPostFinanceiroEnxuta(form, id) {
    const postUrl = new URL(form.action, window.location.origin);
    const retorno = new URL("/backend/despesas", window.location.origin);

    // O redirect original costuma apontar para a fila inteira. Depois do POST,
    // o fetch acabava baixando novamente mais de cem despesas só para confirmar
    // o sucesso. Redirecionando para o próprio ID, a resposta fica minúscula.
    retorno.searchParams.set("status", "T");
    retorno.searchParams.set("tipo_data", "V");
    retorno.searchParams.set("data_intervalo", "");
    retorno.searchParams.set("nfe_id", id || "");
    retorno.searchParams.set("tipo_doc", "");
    retorno.searchParams.set("descricao", "");
    retorno.searchParams.set("departamento_setor_id", "");
    retorno.searchParams.set("tipo", "");
    retorno.searchParams.set("plano_conta_id", "");
    retorno.searchParams.set("natureza_operacao_id", "");
    retorno.searchParams.set("parcela", "");
    retorno.searchParams.set("tipo_entrada", "");
    retorno.searchParams.set("show-descricao", "0");

    postUrl.searchParams.set("redirect", retorno.pathname + retorno.search);
    return postUrl.toString();
  }

  // =========================================================
  // RETORNO_SEGURO_TELA_ORIGINAL
  // Para localizar depois, use CTRL + F e procure por:
  // RETORNO_SEGURO_TELA_ORIGINAL
  //
  // O retorno embutido foi desativado porque o backend do InfraDesk conclui
  // a despesa mesmo quando recebe resetar=F ou resetar=R pelo painel.
  // Este botão não envia POST, não altera etapa e não grava nada: apenas abre
  // a fila original já filtrada pela despesa para o retorno ser feito lá.
  // =========================================================
  function urlTelaOriginalParaRetorno(form, id) {
    const actionUrl = new URL(form.action || "/backend/despesas", window.location.origin);
    const redirectOriginal = texto(actionUrl.searchParams.get("redirect"));
    let url;

    try {
      url = new URL(redirectOriginal || "/backend/despesas", window.location.origin);
    } catch (_) {
      url = new URL("/backend/despesas", window.location.origin);
    }

    url.searchParams.delete(CONFIG.parametroPainel);
    url.searchParams.set("nfe_id", id || "");
    if (!url.searchParams.get("status")) url.searchParams.set("status", CONFIG.statusFilaFixo);
    if (!url.searchParams.get("tipo_data")) url.searchParams.set("tipo_data", "V");
    url.searchParams.set("show-descricao", "1");
    return url.toString();
  }

  function abrirRetornoNaTelaOriginal(form, id) {
    const url = urlTelaOriginalParaRetorno(form, id);
    const novaAba = window.open(url, "_blank");

    if (!novaAba) {
      toast("O navegador bloqueou a nova aba. Permita pop-ups para o InfraDesk e tente novamente.", "erro");
      return;
    }

    try { novaAba.opener = null; } catch (_) {}
    paginaWindow().jQuery("#ModalDespesas").modal("hide");
    toast(
      `Despesa ${id} aberta na tela original. Lá, abra o financeiro, escreva a observação e escolha a etapa de retorno.`,
      "sucesso"
    );
  }

  function prepararRetornoSomenteNaTelaOriginal(form, id) {
    const atual = form.querySelector("#btns-voltar");
    if (!atual) return;

    const campoResetar = form.querySelector('[name="resetar"]');
    if (campoResetar) campoResetar.value = "";

    Array.from(form.querySelectorAll(".dropdown-menu")).forEach(function (menu) {
      if (menu.querySelector('[id^="btn-reset-"]')) menu.remove();
    });

    const grupo = atual.closest(".btn-group");
    if (grupo) {
      grupo.classList.remove("open");
      Array.from(grupo.querySelectorAll(".dropdown-menu")).forEach(function (menu) {
        menu.remove();
      });
    }

    let botao = atual;
    if (atual.dataset.sigmaTelaOriginalPreparada !== "1") {
      botao = atual.cloneNode(true);
      atual.replaceWith(botao);
      botao.dataset.sigmaTelaOriginalPreparada = "1";
      botao.removeAttribute("data-toggle");
      botao.removeAttribute("aria-expanded");
      botao.setAttribute("type", "button");
      botao.title = "Abrir esta despesa na tela original para retornar com segurança";
      botao.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square"></i> Retornar na tela original';
      botao.addEventListener("click", function (evento) {
        evento.preventDefault();
        evento.stopImmediatePropagation();
        abrirRetornoNaTelaOriginal(form, id);
      }, true);
    }

    botao.style.setProperty("display", "inline-flex", "important");
    botao.hidden = false;

    const aviso = Array.from(form.querySelectorAll("p")).find(function (paragrafo) {
      return /retornar uma etapa/i.test(texto(paragrafo.textContent || ""));
    });
    if (aviso) {
      aviso.textContent = "Para retornar, abra a tela original, escreva uma nova observação e escolha a etapa por lá.";
      aviso.style.color = "#9a0000";
      aviso.style.fontWeight = "700";
    }
  }

  // =========================================================
  // RETORNO_AUTOMATICO_DESATIVADO
  // Para localizar depois, use CTRL + F e procure por:
  // RETORNO_DE_ETAPA_NATIVO
  //
  // O InfraDesk usa o mesmo formulário para gravar e para retornar. A única
  // diferença é o campo oculto "resetar":
  // F = Revisar Fiscal, A = Aprovar Despesa, R = Revisar Despesa (Início).
  //
  // O retorno usa a ação e o método EXATOS do formulário original. Não troca
  // o redirect, não força _method e não usa o caminho otimizado da gravação.
  // A única intervenção é garantir o código F/A/R, apontar temporariamente o
  // formulário para um iframe oculto e clicar no botão original outra vez.
  // Assim o onclick original e o submitter original continuam participando.
  // =========================================================
  function enviarRetornoEtapaNativo(form, id, codigoRetorno, botaoRetorno) {
    // Proteção definitiva: este transporte não pode mais enviar nada.
    return Promise.reject(new Error("Retorno automático desativado; use a tela original."));

    /* Código antigo mantido abaixo apenas como histórico interno da versão. */
    return new Promise(function (resolve, reject) {
      codigoRetorno = texto(codigoRetorno);
      if (!codigoRetorno || !botaoRetorno) {
        reject(new Error("A etapa ou o botão original de retorno não foi identificado."));
        return;
      }

      const campoResetar = form.querySelector('[name="resetar"]');
      if (!campoResetar) {
        reject(new Error("O formulário do InfraDesk não possui o campo de retorno."));
        return;
      }

      campoResetar.disabled = false;
      campoResetar.value = codigoRetorno;
      campoResetar.dispatchEvent(new Event("input", { bubbles: true }));
      campoResetar.dispatchEvent(new Event("change", { bubbles: true }));

      const iframe = document.createElement("iframe");
      const nome = "sigma-retorno-nativo-" + id + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      iframe.name = nome;
      iframe.id = nome;
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.cssText = "position:fixed!important;width:1px!important;height:1px!important;left:-99999px!important;top:-99999px!important;border:0!important;opacity:0!important;pointer-events:none!important;";

      let enviado = false;
      let finalizado = false;
      const alvoAnterior = form.getAttribute("target");
      const timeout = setTimeout(function () {
        finalizar();
        reject(new Error("O InfraDesk demorou mais de 90 segundos para responder ao retorno de etapa."));
      }, 90000);

      function finalizar() {
        if (finalizado) return;
        finalizado = true;
        clearTimeout(timeout);
        delete form.dataset.sigmaDisparoRetornoNativo;
        delete form.dataset.sigmaRetornoNativoEmCurso;
        if (alvoAnterior == null) form.removeAttribute("target");
        else form.setAttribute("target", alvoAnterior);
        setTimeout(function () {
          try { iframe.remove(); } catch (_) {}
        }, 500);
      }

      iframe.addEventListener("load", function () {
        if (!enviado || finalizado) return;

        setTimeout(function () {
          if (finalizado) return;
          try {
            const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
            if (!doc || !doc.documentElement) return;

            const finalUrl = iframe.contentWindow && iframe.contentWindow.location
              ? String(iframe.contentWindow.location.href || "")
              : "";
            const html = doc.documentElement.outerHTML || "";
            if (!html || finalUrl === "about:blank") return;

            finalizar();
            resolve({ doc: doc, html: html, finalUrl: finalUrl });
          } catch (falha) {
            finalizar();
            reject(new Error("Não consegui ler a confirmação do retorno de etapa: " + texto(falha.message || falha)));
          }
        }, 120);
      });

      document.body.appendChild(iframe);

      requestAnimationFrame(function () {
        try {
          // Reaplica no último instante; o onclick original fará o mesmo.
          campoResetar.disabled = false;
          campoResetar.value = codigoRetorno;
          const conferencia = new FormData(form);
          if (texto(conferencia.get("resetar")) !== codigoRetorno) {
            throw new Error("O código da etapa não entrou no formulário. Nada foi enviado.");
          }

          form.setAttribute("target", nome);
          form.dataset.sigmaRetornoNativoEmCurso = "1";
          form.dataset.sigmaDisparoRetornoNativo = "1";
          enviado = true;

          // Não alteramos action, method, enctype, redirect nem _method.
          // O clique original executa o onclick e a submissão padrão da página.
          botaoRetorno.click();
        } catch (falha) {
          finalizar();
          reject(new Error("Não consegui enviar o retorno de etapa: " + texto(falha.message || falha)));
        } finally {
          delete form.dataset.sigmaDisparoRetornoNativo;
        }
      });
    });
  }

  async function executarRetornoEtapaOriginal(form, botaoRetorno, codigoRetorno, etapaRetorno) {
    // Proteção definitiva: nenhuma opção do painel pode chamar este fluxo.
    return;

    if (!form || form.dataset.sigmaEnviando === "1") return;

    const observacao = form.querySelector("#financeiro-observacao");
    if (!texto(observacao ? observacao.value : "")) {
      const root = paginaWindow();
      if (typeof root.swal === "function") {
        root.swal("Escreva uma nova observação para justificar o retorno.");
      } else {
        window.alert("Escreva uma nova observação para justificar o retorno.");
      }
      if (observacao) observacao.focus();
      return;
    }

    const campoResetar = form.querySelector('[name="resetar"]');
    codigoRetorno = texto(codigoRetorno);
    if (!campoResetar || !codigoRetorno) {
      toast("Não consegui identificar a etapa escolhida. Feche o modal e abra novamente.", "erro");
      return;
    }

    const match = String(form.action || "").match(/\/backend\/despesas\/financeiro\/(\d+)/i);
    const id = match ? match[1] : "";
    const item = itemDespesaPorId(id);

    if (!id) {
      toast("Não consegui identificar a despesa deste formulário.", "erro");
      return;
    }

    form.dataset.sigmaEnviando = "1";

    try {
      const reserva = await reservarDespesaFirebaseSeguro(
        id,
        state.usuario,
        { permitirAssumir: false }
      );
      if (donoItemReserva(reserva.item)) {
        state.reservas[id] = reserva.item;
      } else {
        delete state.reservas[id];
      }
      if (!reserva.ok) {
        renderizar();
        throw new Error(mensagemFalhaReserva(reserva));
      }
    } catch (falhaReserva) {
      form.dataset.sigmaEnviando = "0";
      toast("Não consegui confirmar a reserva: " + texto(falhaReserva.message || falhaReserva), "erro");
      return;
    }

    campoResetar.disabled = false;
    campoResetar.value = codigoRetorno;
    campoResetar.dispatchEvent(new Event("input", { bubbles: true }));
    campoResetar.dispatchEvent(new Event("change", { bubbles: true }));

    state.salvandoId = id;
    form.dataset.sigmaAcaoAtual = "retorno";
    mostrarEstadoGravacao(
      form,
      id,
      true,
      `Retornando despesa ${id}...`,
      `Enviando para ${etapaRetorno || "a etapa selecionada"} pelo botão original do InfraDesk.`
    );
    atualizarStatus(`Retornando a despesa ${id} no InfraDesk...`);

    const avisoDemora = setTimeout(function () {
      mostrarEstadoGravacao(
        form,
        id,
        true,
        `O InfraDesk ainda está retornando a despesa ${id}...`,
        "O clique original foi acionado. Não clique novamente enquanto aguardamos a resposta."
      );
    }, 3500);

    try {
      const retornoNativo = await enviarRetornoEtapaNativo(
        form,
        id,
        codigoRetorno,
        botaoRetorno
      );
      const html = retornoNativo.html || "";
      const doc = retornoNativo.doc || new DOMParser().parseFromString(html, "text/html");
      const formularioRetornado = doc.querySelector(`form.form-financeiro[action*="/financeiro/${id}"]`);

      if (formularioRetornado) {
        const areaFormulario = formularioRetornado.parentElement || formularioRetornado;
        const erroDoFormulario = areaFormulario.querySelector(".alert-danger, .error-message, .form-error, .has-error");
        const mensagem = texto(
          erroDoFormulario
            ? erroDoFormulario.textContent
            : "O InfraDesk devolveu o formulário. Confira a observação e os campos obrigatórios."
        );
        restaurarFormularioRetornado(doc, formularioRetornado);
        throw new Error(mensagem || "O InfraDesk devolveu o formulário para correção.");
      }

      mostrarEstadoGravacao(
        form,
        id,
        true,
        "InfraDesk confirmou o retorno.",
        "Atualizando a fila e sincronizando a equipe."
      );

      if (item) gravarEstadoFinal(item, codigoRetorno);
      state.despesas = state.despesas.filter(function (d) { return d.id !== id; });
      state.cacheAbas[state.abaAtual] = state.despesas.slice();
      paginaWindow().jQuery("#ModalDespesas").modal("hide");
      reconstruirOpcoesFiltros();
      renderizar();

      toast(`Despesa ${id} retornada para ${etapaRetorno || "a etapa escolhida"}.`, "sucesso");
      atualizarStatus(`${state.despesas.length} despesas restantes na fila`);
    } catch (falha) {
      console.error(PREFIXO, "Retorno de etapa pelo botão original", falha);
      toast(
        "Não consegui confirmar o retorno da etapa: " + texto(falha.message || falha)
        + " Consulte a despesa no InfraDesk antes de tentar novamente.",
        "erro"
      );
      atualizarStatus(`Falha ao confirmar o retorno da despesa ${id}`);
    } finally {
      clearTimeout(avisoDemora);
      state.salvandoId = "";
      mostrarEstadoGravacao(form, id, false);

      const overlay = document.getElementById("sigma-modal-salvando");
      if (overlay) {
        overlay.classList.remove("ativo");
        overlay.setAttribute("aria-hidden", "true");
      }

      form.dataset.sigmaEnviando = "0";
      delete form.dataset.sigmaAcaoAtual;
      delete form.dataset.sigmaDisparoRetornoNativo;
      delete form.dataset.sigmaRetornoNativoEmCurso;
      campoResetar.value = "";
      Array.from(document.querySelectorAll('#ModalDespesas button, #ModalDespesas input[type="submit"]')).forEach(function (botao) {
        botao.disabled = false;
      });
    }
  }

  function mostrarEstadoGravacao(form, id, ativo, titulo, detalhe) {
    const overlay = document.getElementById("sigma-modal-salvando");
    const tituloEl = document.getElementById("sigma-salvando-titulo");
    const detalheEl = document.getElementById("sigma-salvando-detalhe");

    if (overlay) {
      overlay.classList.toggle("ativo", !!ativo);
      overlay.setAttribute("aria-hidden", ativo ? "false" : "true");
    }
    if (tituloEl && titulo) tituloEl.textContent = titulo;
    if (detalheEl && detalhe) detalheEl.textContent = detalhe;

    if (!form) return;
    const botao = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]')).find(function (el) {
      return /gravar/i.test(texto(el.textContent || el.value || "")) || /fa-save/i.test(String(el.innerHTML || ""));
    });

    if (!botao) return;
    if (ativo) {
      if (!botao.dataset.sigmaTextoOriginal) {
        botao.dataset.sigmaTextoOriginal = botao.tagName.toLowerCase() === "input" ? botao.value : botao.innerHTML;
      }
      const textoProcessando = form.dataset.sigmaAcaoAtual === "retorno"
        ? "Retornando..."
        : "Gravando...";
      if (botao.tagName.toLowerCase() === "input") {
        botao.value = textoProcessando;
      } else {
        botao.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${textoProcessando}`;
      }
    } else if (botao.dataset.sigmaTextoOriginal) {
      if (botao.tagName.toLowerCase() === "input") {
        botao.value = botao.dataset.sigmaTextoOriginal;
      } else {
        botao.innerHTML = botao.dataset.sigmaTextoOriginal;
      }
      delete botao.dataset.sigmaTextoOriginal;
    }
  }

  async function enviarFormularioViaAjax(evento) {
    const form = evento.currentTarget;

    // Os validadores nativos do InfraDesk foram registrados antes.
    // Se algum deles impediu o envio, não fazemos nada.
    if (evento.defaultPrevented) return;
    if (form.dataset.sigmaEnviando === "1") {
      evento.preventDefault();
      return;
    }

    evento.preventDefault();
    evento.stopPropagation();
    form.dataset.sigmaEnviando = "1";

    const match = String(form.action || "").match(/\/backend\/despesas\/financeiro\/(\d+)/i);
    const id = match ? match[1] : "";
    const item = itemDespesaPorId(id);

    if (!id) {
      form.dataset.sigmaEnviando = "0";
      toast("Não consegui identificar a despesa. Nada foi enviado nem registrado.", "erro");
      return;
    }

    try {
      const reserva = await reservarDespesaFirebaseSeguro(
        id,
        state.usuario,
        { permitirAssumir: false }
      );
      if (donoItemReserva(reserva.item)) {
        state.reservas[id] = reserva.item;
      } else {
        delete state.reservas[id];
      }
      if (!reserva.ok) {
        form.dataset.sigmaEnviando = "0";
        renderizar();
        toast(mensagemFalhaReserva(reserva), "erro");
        return;
      }
    } catch (falhaReserva) {
      form.dataset.sigmaEnviando = "0";
      toast("Não consegui confirmar a reserva: " + texto(falhaReserva.message || falhaReserva), "erro");
      return;
    }

    // Este listener cuida somente do botão Gravar. Retornos são tratados pelo
    // clique original das opções F/A/R e nunca passam por este fetch.
    const campoResetarGravacao = form.querySelector('[name="resetar"]');
    if (campoResetarGravacao) campoResetarGravacao.value = "";
    const botoes = Array.from(form.querySelectorAll("button, input[type=submit]"));
    botoes.forEach(function (b) { b.disabled = true; });
    state.salvandoId = id;
    form.dataset.sigmaAcaoAtual = "gravacao";

    mostrarEstadoGravacao(
      form,
      id,
      true,
      `Gravando despesa ${id}...`,
      "Enviando os dados ao InfraDesk. A resposta usa uma consulta reduzida para ser mais rápida."
    );
    atualizarStatus(`Gravando despesa ${id} no InfraDesk...`);

    let avisoDemora = setTimeout(function () {
      mostrarEstadoGravacao(
        form,
        id,
        true,
        `O InfraDesk ainda está processando a despesa ${id}...`,
        "O clique foi recebido. Não clique novamente; estamos aguardando a confirmação do servidor."
      );
    }, 3500);

    try {
      const resposta = await fetch(urlPostFinanceiroEnxuta(form, id), {
        method: "POST",
        credentials: "same-origin",
        body: new FormData(form),
        cache: "no-store",
      });
      const html = await resposta.text();
      if (!resposta.ok) throw new Error(`InfraDesk retornou HTTP ${resposta.status}.`);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const formularioRetornado = doc.querySelector(`form.form-financeiro[action*="/financeiro/${id}"]`);

      // Quando o próprio formulário volta, o InfraDesk recusou algum campo.
      // Nesse caso recolocamos a resposta dentro do modal e não alteramos o
      // Firebase nem removemos a despesa da fila.
      if (formularioRetornado) {
        const areaFormulario = formularioRetornado.parentElement || formularioRetornado;
        const erroDoFormulario = areaFormulario.querySelector(".alert-danger, .error-message, .form-error, .has-error");
        const mensagem = texto(erroDoFormulario ? erroDoFormulario.textContent : "O InfraDesk devolveu o formulário. Confira os campos obrigatórios.");

        restaurarFormularioRetornado(doc, formularioRetornado);
        throw new Error(mensagem || "O InfraDesk devolveu o formulário para correção.");
      }

      mostrarEstadoGravacao(
        form,
        id,
        true,
        "InfraDesk confirmou. Atualizando a equipe...",
        "Gravação confirmada. Atualizando a fila e sincronizando a equipe em segundo plano."
      );

      // O InfraDesk já confirmou neste ponto. A despesa sai da fila agora;
      // o Firebase sincroniza em segundo plano e possui fila local de repetição.
      gravarEstadoFinal(item || {
        id: id,
        competencia: "",
        fornecedor: "",
        tipo: "",
        valor: "",
      }, "");
      state.despesas = state.despesas.filter(function (d) { return d.id !== id; });
      state.cacheAbas[state.abaAtual] = state.despesas.slice();
      paginaWindow().jQuery("#ModalDespesas").modal("hide");
      reconstruirOpcoesFiltros();
      renderizar();

      toast(`Despesa ${id} gravada e concluída com sucesso.`, "sucesso");
      atualizarStatus(`${state.despesas.length} despesas restantes na fila`);
    } catch (falha) {
      console.error(PREFIXO, "Gravação", falha);
      toast("Não consegui confirmar a gravação: " + texto(falha.message || falha), "erro");
      atualizarStatus(`Falha ao gravar a despesa ${id}`);
    } finally {
      clearTimeout(avisoDemora);
      state.salvandoId = "";

      // Destrava sempre, inclusive quando o formulário original foi substituído
      // pela resposta do InfraDesk durante uma validação.
      mostrarEstadoGravacao(form, id, false);
      const overlay = document.getElementById("sigma-modal-salvando");
      if (overlay) {
        overlay.classList.remove("ativo");
        overlay.setAttribute("aria-hidden", "true");
      }

      form.dataset.sigmaEnviando = "0";
      delete form.dataset.sigmaAcaoAtual;
      delete form.dataset.sigmaEtapaRetorno;
      delete form.dataset.sigmaRetornoValor;
      const campoResetarFinal = form.querySelector('[name="resetar"]');
      if (campoResetarFinal) campoResetarFinal.value = "";
      botoes.forEach(function (b) { b.disabled = false; });
      Array.from(document.querySelectorAll('#ModalDespesas button, #ModalDespesas input[type="submit"]')).forEach(function (b) {
        b.disabled = false;
      });
    }
  }

  function substituirConteudoModalExecutandoScripts(modalBody, html) {
    if (!modalBody) return;

    const root = paginaWindow();
    const $ = root.jQuery || root.$ || window.jQuery || window.$;

    if ($ && $.fn) {
      // append(html) passa pelo mesmo mecanismo usado pelo .load() do
      // InfraDesk e executa novamente os scripts do fragmento devolvido.
      $(modalBody).empty().append(String(html || ""));
      return;
    }

    // Proteção de último recurso. O processamento do formulário ainda ocorre,
    // mesmo que os componentes visuais nativos não possam ser reinicializados.
    modalBody.innerHTML = String(html || "");
  }

  function restaurarFormularioRetornado(doc, formularioRetornado) {
    const modalBody = corpoPrincipalModal();
    if (!modalBody || !formularioRetornado) return;

    const corpoResposta = doc && doc.body ? doc.body : null;
    const respostaPareceFragmento = corpoResposta
      && !doc.querySelector("#wrapper, nav.navbar, .navbar-default, .sigma-topo")
      && corpoResposta.innerHTML.length < 250000;

    let conteudo;

    if (respostaPareceFragmento) {
      conteudo = corpoResposta.innerHTML;
    } else {
      const avisos = Array.from(doc.querySelectorAll(".alert, .error-message, .form-error"))
        .filter(function (el) {
          return el === formularioRetornado || formularioRetornado.contains(el) || el.compareDocumentPosition(formularioRetornado) & Node.DOCUMENT_POSITION_FOLLOWING;
        })
        .slice(-4)
        .map(function (el) { return el.outerHTML; })
        .join("");
      conteudo = avisos + formularioRetornado.outerHTML;
    }

    substituirConteudoModalExecutandoScripts(modalBody, conteudo);

    setTimeout(function () {
      processarFormularioModal();
    }, 0);
  }

  function mostrarErroFatal(falha) {
    const mensagem = texto(falha && (falha.message || falha)) || "Erro desconhecido ao iniciar o painel.";
    const corpo = document.getElementById("sigma-corpo-tabela");

    if (corpo) {
      corpo.innerHTML = `<tr><td colspan="9" class="sigma-vazio" style="color:#b91c1c!important">
        <i class="fa-solid fa-triangle-exclamation"></i><br>
        <strong>O painel não conseguiu iniciar.</strong><br>
        <small>${escaparHtml(mensagem)}</small><br><br>
        <button type="button" class="sigma-btn" style="background:#991b1b" onclick="location.reload()">Tentar novamente</button>
      </td></tr>`;
      atualizarStatus("O painel não conseguiu iniciar");
      return;
    }

    // Última proteção: nunca deixar a aba em branco, mesmo se a falha
    // acontecer antes da estrutura principal ser criada.
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:30px;background:#eef2f7;font-family:"Open Sans","Helvetica Neue",Helvetica,Arial,sans-serif">
        <div style="max-width:720px;padding:24px;border-radius:14px;background:#fff;box-shadow:0 16px 40px rgba(15,23,42,.16);color:#991b1b">
          <h2 style="margin:0 0 12px">O Painel Financeiro não conseguiu iniciar</h2>
          <p style="color:#475569">${escaparHtml(mensagem)}</p>
          <button type="button" onclick="location.reload()" style="height:38px;padding:0 14px;border:0;border-radius:8px;background:#0f172a;color:#fff;font-weight:800;cursor:pointer">Tentar novamente</button>
        </div>
      </div>`;
  }
})();
