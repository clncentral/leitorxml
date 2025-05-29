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
        const dataTopico = new Date(data);
        const hoje = new Date();

        // Verifica se a data do tópico é maior que a data atual
        if (dataTopico > hoje) {
            return; // Não adiciona o tópico se a data for futura
        }

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

        // Define o símbolo do ícone com base na data do tópico
        const umaSemanaEmMillis = 4 * 24 * 60 * 60 * 1000;
        if (hoje - dataTopico <= umaSemanaEmMillis) {
            icone.textContent = "⇒"; // Símbolo para tópicos recentes
			novoTopico.classList.add("novo");
        } else {
            icone.textContent = "⇓"; // Símbolo para tópicos antigos
			novoTopico.classList.add("velho");
        }
        
        icone.style.marginRight = "5px"; // Espaçamento entre o ícone e o título
        novoTopico.appendChild(icone);
        const novoLink = document.createElement("a");
        novoLink.href = link;
        novoLink.textContent = titulo;
        novoLink.target = "_blank";
        novoTopico.appendChild(novoLink);

        colunaMenosCheia.appendChild(novoTopico); // Adiciona o tópico à coluna menos cheia
    }

    // Exemplo de adição de tópicos
	 // Exemplo de adição de tópicos
	/*
	adicionarTopico("A Morte de Arthur", "hist/cap12.html", "2024-06-12");
	adicionarTopico("Mordred", "hist/cap11.html", "2024-06-11");
	adicionarTopico("Coração de Cavaleiro", "hist/cap10.html", "2024-06-10");
	adicionarTopico("O Retorno de Nimueh", "hist/cap9.html", "2024-06-07");
	adicionarTopico("Os Primeiros Desafios", "hist/cap8.html", "2024-06-06");
	adicionarTopico("A Canção da Vingança", "hist/cap7.html", "2024-06-05");
	adicionarTopico("A Chegada de Merlin", "hist/cap6.html", "2024-06-04");
	adicionarTopico("O Nascimento de Merlin", "hist/cap5.html", "2024-06-03");
	adicionarTopico("O Crescimento de Arthur", "hist/cap4.html", "2024-05-31");
	adicionarTopico("A Grande Purgação", "hist/cap3.html", "2024-05-29");
	adicionarTopico("A Ascensão de Uther", "hist/cap2.html", "2024-05-28");
	adicionarTopico("A Lenda de Cornelius Sigan", "hist/cap1.html", "2024-05-27");
	adicionarTopico("Ilha perdida", "hist/icaro.html", "2024-05-10");
	adicionarTopico("Jornada da Criatividade", "hist/lira.html", "2024-05-08");
	adicionarTopico("\"O Canudo\"", "hist/empresa.html", "2024-05-07");
	adicionarTopico("A Lição do Riacho", "hist/riacho.html", "2024-05-06");
	adicionarTopico("Acessibilidade", "hist/acessibilidade.html", "2024-05-04");
	adicionarTopico("Imortais", "hist/imortais.html", "2024-05-03");
	adicionarTopico("A cidade nas nuvens", "hist/a_cidade_nas_nuvens.html", "2024-05-02");
	adicionarTopico("O Preço da Fúria", "hist/o_preco_da_furia.html", "2024-04-30");
	adicionarTopico("Travessuras Noturnas", "hist/travessuras_noturnas.html", "2024-04-27");
	adicionarTopico("A Floresta dos Trabalhos", "hist/a_selva.html", "2024-04-24");
	adicionarTopico("Sapinho Surdo", "hist/sapo_surdo.html", "2024-04-22");
	adicionarTopico("Formiga desmotivada", "https://open.spotify.com/playlist/5wMbIGMnM1Dpj2BcCHZZlO", "2024-04-20");
	
	
	
	*/
	adicionarTopico("Consulta CNPJ", "hist/cnpj.html", "2024-05-09");
	adicionarTopico("Google", "https://www.google.com.br/?hl=pt-BR", "2024-05-08");
	adicionarTopico("Youtube", "https://www.youtube.com/", "2024-05-08");
	adicionarTopico("Youtube", "https://m.youtube.com/", "2024-05-08");
	adicionarTopico("SpotFy", "https://open.spotify.com/playlist/5wMbIGMnM1Dpj2BcCHZZlO", "2024-04-20");
	adicionarTopico("Radio", "hist/radio.html", "2024-04-22");
	adicionarTopico("Ler PDF", "hist/novo6.html", "2024-04-22");
	
    // Adicionar mais tópicos conforme necessário
});
