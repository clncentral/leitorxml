document.addEventListener("DOMContentLoaded", function() {
    const topicosDiv = document.getElementById("topicos");
    const colunas = {}; // objeto para armazenar as colunas por nome

    // Lista de colunas fixas
    const nomesColunas = ["Links Úteis", "Contratos", "Manuais", "Favoritos"];

    // Função para criar uma coluna com título
    function criarColuna(nome) {
        const colunaContainer = document.createElement("div");
        colunaContainer.classList.add("column");

        const titulo = document.createElement("h3");
        titulo.textContent = nome;
        titulo.classList.add("titulo-coluna");

        colunaContainer.appendChild(titulo);
        topicosDiv.appendChild(colunaContainer);

        colunas[nome] = colunaContainer;
    }

    // Criar as 5 colunas iniciais
    nomesColunas.forEach(nome => criarColuna(nome));

    // Função para adicionar um novo tópico em uma coluna específica
    function adicionarTopico(colunaNome, titulo, link, data) {
        const dataTopico = new Date(data);
        const hoje = new Date();

        if (dataTopico > hoje) {
            return; // não adiciona tópicos com data futura
        }

        // Se a coluna não existir, cria automaticamente
        if (!colunas[colunaNome]) {
            criarColuna(colunaNome);
        }

        const novaColuna = colunas[colunaNome];

        const novoTopico = document.createElement("div");
        novoTopico.classList.add("topico");

        const icone = document.createElement("span");
        const quatroDias = 4 * 24 * 60 * 60 * 1000;

        if (hoje - dataTopico <= quatroDias) {
            icone.textContent = "⇒"; // recente
            novoTopico.classList.add("novo");
        } else {
            icone.textContent = "⇓"; // antigo
            novoTopico.classList.add("velho");
        }

        icone.style.marginRight = "5px";
        novoTopico.appendChild(icone);

        const novoLink = document.createElement("a");
        novoLink.href = link;
        novoLink.textContent = titulo;
        novoLink.target = "_blank";

        novoTopico.appendChild(novoLink);
        novaColuna.appendChild(novoTopico);
    }

    // 🌟 Exemplo de uso
    adicionarTopico("Links Úteis", "Consulta CNPJ", "hist/cnpj.html", "2024-05-09");
    adicionarTopico("Links Úteis", "Descubra a Loja", "https://clncentral.github.io/leitorxml/hist/novo6.html", "2024-05-08");
    adicionarTopico("Links Úteis", "Leitor de Boleto", "https://clncentral.github.io/leitorxml/hist/boletos.html", "2024-05-08");
	adicionarTopico("Links Úteis", "Leitor de Texto com voz", "https://clncentral.github.io/leitorxml/hist/leitor-tts-portugues.html", "2024-05-08");

    // 🌟 Tópicos da coluna "Contratos"
	adicionarTopico("Contratos", "Contratos Financeiros", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-financeiro/7964", "2025-10-27");
	adicionarTopico("Contratos", "Consumo de Água", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-financeiro-consumo-de-agua/7978", "2024-04-22");
	adicionarTopico("Contratos", "Consumo de Energia Elétrica", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-financeiro-consumo-de-energia-eletrica/8003", "2024-04-22");
	adicionarTopico("Contratos", "Consumo de Gás Canalizado", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-financeiro-consumo-de-gas-canalizado/8023", "2024-04-22");
	adicionarTopico("Contratos", "Doação Financeira", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-financeiro-doacao-financeira/8039", "2024-04-22");
	adicionarTopico("Contratos", "Outras Despesas", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-financeiro-outras-despesas/8120", "2024-04-22");
	adicionarTopico("Contratos", "Pagamento de Aluguel de Equipamento", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-finande-equipamento/11993", "2024-04-22");
	adicionarTopico("Contratos", "Pagamento de Aluguel de Imóvel", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-finanguel-de-imovel/12026", "2024-04-22");
	adicionarTopico("Contratos", "Pagamento de Royalties", "https://ajuda.bluesoft.com.br/sistema/novidade/contrato-financeiro-pagamento-de-royalties/45478", "2024-04-22");
	adicionarTopico("Contratos", "Tomada de Serviço de Comunicação ou Telecomunicação", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-finanelecomunicacao/12043", "2024-04-22");
	adicionarTopico("Contratos", "Tomada de Serviço de Fornecedor Internacional", "https://ajuda.bluesoft.com.br/modulo-financeiro/despesa-para-tomada-de-servico-de-fornecedor-internacional/10538", "2024-04-22");
	adicionarTopico("Contratos", "Tomada de serviço de Meio de Pagamento", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-financeiro-tomada-de-servico-de-meio-de-pagamento/12106", "2024-04-22");
	adicionarTopico("Contratos", "Tomada de Serviço de Prestador Municipal", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-financeiro-tomada-de-servico-de-prestador-municipal/12137", "2024-04-22");
	adicionarTopico("Contratos", "Tomada de Serviço de Profissionais Liberais/Autônomos", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-financeiro-tomada-de-servico-de-profissionais-liberaisautonomos/12159", "2024-04-22");
	adicionarTopico("Contratos", "Tomada de Serviço Estadual", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-financeiro-tomada-de-servico-estadual/12171", "2024-04-22");
	adicionarTopico("Contratos", "Tomada de Serviços de Transporte", "https://ajuda.bluesoft.com.br/modulo-financeiro/contrato-finanelecomunicacao/12043", "2024-04-22");


    // 🌟 Tópicos da coluna "Manuais"
	adicionarTopico("Manuais", "Energia Elétrica (modelo 55)", "https://ajuda.bluesoft.com.br/modulo-estoques-e-nf-e/recebimento-de-mercadorias-nota-fiscal-eletronica-de-energia-eletrica-modelo-55/55903", "2024-04-22");
	adicionarTopico("Manuais", "Compra de Ativo Imobilizado", "https://ajuda.bluesoft.com.br/faq/compra-de-ativo-imobilizado", "2024-04-22");
	adicionarTopico("Manuais", "Classificacao Ativos Imobilizados", "blue/Classificacao_Ativos_Imobilizados.xlsx", "2024-04-22");
	adicionarTopico("Manuais", "Correção Despesa para Ativo", "blue/CorrecaoDespesaAtivo.docx", "2024-04-22");
	adicionarTopico("Manuais", "Cadastro Ativo Imobilizado", "blue/cadastroAtivo.docx", "2024-04-22");
	adicionarTopico("Manuais", "Pedido de Compra Ativo - Danfe", "https://ajuda.bluesoft.com.br/faq/compra-de-ativo-imobilizado", "2024-04-22");
	adicionarTopico("Manuais", "Venda Ativo", "blue/VendaAtivo.pdf", "2024-04-22");
	adicionarTopico("Manuais", "Venda Energia", "blue/Venda-de-Energia.pdf", "2024-04-22");


    adicionarTopico("Favoritos", "Spotify", "https://open.spotify.com/", "2024-04-22");
    adicionarTopico("Favoritos", "Rádio Online", "hist/radio.html", "2024-04-20");
	adicionarTopico("Favoritos", "Despesas", "hist/despesas.html", "2024-04-20");
});









