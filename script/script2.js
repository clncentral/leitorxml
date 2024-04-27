document.addEventListener("DOMContentLoaded", function() {
    const topicosDiv = document.getElementById("topicos");
    const colunas = []; // Array para armazenar as colunas criadas

    // Função para criar uma nova coluna
    function criarNovaColuna() {
        const novaColuna = document.createElement("div");
        novaColuna.classList.add("column"); // Adiciona a classe "column"
        topicosDiv.appendChild(novaColuna);
        colunas.push(novaColuna); // Adiciona a nova coluna ao array de colunas
        return novaColuna;
    }

    // Função para adicionar um novo tópico
    function adicionarTopico(titulo, link, data) {
        // Verifica se é necessário criar uma nova coluna
        if (colunas.length === 0 || colunas[colunas.length - 1].children.length >= 10) {
            criarNovaColuna(); // Cria uma nova coluna
        }

        // Encontra a coluna com o menor número de tópicos
        let colunaMenosCheia = colunas.reduce((acumulador, coluna) => 
            (acumulador.children.length < coluna.children.length) ? acumulador : coluna);

        const novoTopico = document.createElement("div");
        novoTopico.classList.add("topico");
        const icone = document.createElement("span");
        icone.textContent = "•"; // Caractere especial
        icone.style.marginRight = "5px"; // Espaçamento entre o ícone e o título
        novoTopico.appendChild(icone);
        const novoLink = document.createElement("a");
        novoLink.href = link;
        novoLink.textContent = titulo;
        novoLink.target = "_blank";
        novoTopico.appendChild(novoLink);

        const hoje = new Date();
        const umaSemanaEmMillis = 3 * 24 * 60 * 60 * 1000;
        const dataTopico = new Date(data);
        if (hoje - dataTopico <= umaSemanaEmMillis) {
            novoTopico.classList.add("novo");
        }

        colunaMenosCheia.appendChild(novoTopico); // Adiciona o tópico à coluna menos cheia
    }

    // Exemplo de adição de tópicos
    adicionarTopico("Travessuras Noturnas", "hist/travessuras_noturnas.html", "2024-04-26");
    adicionarTopico("A Floresta dos Trabalhos", "hist/a_selva.html", "2024-04-24");
    adicionarTopico("Sapinho Surdo", "hist/sapo_surdo.html", "2024-04-22");
    adicionarTopico("Formiga desmotivada", "hist/a_demissao_da_formiga.html", "2024-04-20");
    // Adicionar mais tópicos conforme necessário
});
