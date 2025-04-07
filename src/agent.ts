import { ZodObject } from "zod";
import { CoreMessage } from "ai";
import { SEARCH_PROVIDER, STEP_SLEEP } from "./config";
import fs from "fs/promises";
import { SafeSearchType, search as duckSearch } from "duck-duck-scrape";
import { braveSearch } from "./tools/brave-search";
import { rewriteQuery } from "./tools/query-rewriter";
import { dedupQueries } from "./tools/jina-dedup";
import { evaluateAnswer, evaluateQuestion } from "./tools/evaluator";
import { analyzeSteps } from "./tools/error-analyzer";
import { TokenTracker } from "./utils/token-tracker";
import { ActionTracker } from "./utils/action-tracker";
import {
  StepAction,
  AnswerAction,
  KnowledgeItem,
  EvaluationType,
  BoostedSearchSnippet,
  SearchSnippet,
  EvaluationResponse,
  Reference,
  SERPQuery,
  RepeatEvaluationType,
  UnNormalizedSearchSnippet,
} from "./types";
import { TrackerContext } from "./types";
import { search } from "./tools/jina-search";
// import {grounding} from "./tools/grounding";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ObjectGeneratorSafe } from "./utils/safe-generator";
import { CodeSandbox } from "./tools/code-sandbox";
import { serperSearch } from "./tools/serper-search";
import {
  addToAllURLs,
  rankURLs,
  filterURLs,
  normalizeUrl,
  sortSelectURLs,
  getLastModified,
  keepKPerHostname,
  processURLs,
  fixBadURLMdLinks,
  extractUrlsWithDescription,
} from "./utils/url-tools";
import {
  buildMdFromAnswer,
  smartMergeStrings,
  chooseK,
  convertHtmlTablesToMd,
  fixCodeBlockIndentation,
  removeExtraLineBreaks,
  removeHTMLtags,
  repairMarkdownFinal,
  repairMarkdownFootnotesOuter,
} from "./utils/text-tools";
import {
  MAX_QUERIES_PER_STEP,
  MAX_REFLECT_PER_STEP,
  MAX_URLS_PER_STEP,
  Schemas,
} from "./utils/schemas";
import { formatDateBasedOnType, formatDateRange } from "./utils/date-tools";
import { fixMarkdown } from "./tools/md-fixer";
import { repairUnknownChars } from "./tools/broken-ch-fixer";
import { jsonSchema } from "ai";

/**
 * Função que pausa a execução por um determinado período de tempo.
 * @param {number} ms - O número de milissegundos para pausar a execução.
 * @returns {Promise<void>} - Uma promessa que é resolvida após o tempo especificado.
 */
async function sleep(ms: number) {
  // Converte milissegundos para segundos e arredonda para cima
  const seconds = Math.ceil(ms / 1000);
  // Loga no console o tempo de espera em segundos
  console.log(`Waiting ${seconds}s...`);
  // Retorna uma promessa que é resolvida após o tempo especificado
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Função que constrói mensagens de pares usuário-assistente a partir do conhecimento acumulado.
 * @param {KnowledgeItem[]} knowledge - Array de itens de conhecimento que contém perguntas e respostas.
 * @returns {CoreMessage[]} - Array de mensagens formatadas para interação usuário-assistente.
 */
function BuildMsgsFromKnowledge(knowledge: KnowledgeItem[]): CoreMessage[] {
  const messages: CoreMessage[] = []; // Inicializa o array de mensagens
  knowledge.forEach((k) => {
    // Itera sobre cada item de conhecimento
    messages.push({ role: "user", content: k.question.trim() }); // Adiciona a pergunta do usuário como uma mensagem

    // Formata a mensagem de resposta do assistente, incluindo data e URL se disponíveis
    const aMsg = `
${
  k.updated && (k.type === "url" || k.type === "side-info") // Verifica se há uma data de atualização e se o tipo é URL ou informação adicional
    ? `
<answer-datetime>
${k.updated}
</answer-datetime>
`
    : ""
}

${
  k.references && k.type === "url" // Verifica se há referências e se o tipo é URL
    ? `
<url>
${k.references[0]}
</url>
`
    : ""
}

${k.answer} // Adiciona a resposta do conhecimento
      `.trim();

    // Adiciona a resposta do assistente como uma mensagem
    messages.push({ role: "assistant", content: removeExtraLineBreaks(aMsg) });
  });
  return messages; // Retorna o array de mensagens formatadas
}

/**
 * Função que compõe mensagens para interação, combinando conhecimento prévio e novas perguntas.
 * @param {CoreMessage[]} messages - Mensagens existentes de interação.
 * @param {KnowledgeItem[]} knowledge - Itens de conhecimento para incluir na interação.
 * @param {string} question - Pergunta atual do usuário.
 * @param {string[]} [finalAnswerPIP] - Feedbacks finais para melhorar a qualidade da resposta.
 * @returns {CoreMessage[]} - Array de mensagens compostas para interação.
 */
function composeMsgs(
  messages: CoreMessage[], // Mensagens existentes de interação
  knowledge: KnowledgeItem[], // Itens de conhecimento para incluir na interação
  question: string, // Pergunta atual do usuário
  finalAnswerPIP?: string[] // Feedbacks finais opcionais
) {
  // conhecimento sempre colocado na frente, seguido pela interação usuário-assistente real
  const msgs = [...BuildMsgsFromKnowledge(knowledge), ...messages];

  const userContent = `
${question}

${
  finalAnswerPIP?.length
    ? `
<answer-requirements>
- You provide deep, unexpected insights, identifying hidden patterns and connections, and creating "aha moments.".
- You break conventional thinking, establish unique cross-disciplinary connections, and bring new perspectives to the user.
- Follow reviewer's feedback and improve your answer quality.
${finalAnswerPIP
  .map(
    (p, idx) => `
<reviewer-${idx + 1}>
${p}
</reviewer-${idx + 1}>
`
  )
  .join("\n")}
</answer-requirements>`
    : ""
}
    `.trim();

  msgs.push({ role: "user", content: removeExtraLineBreaks(userContent) });
  return msgs;
}

/**
 * Função que gera o prompt para o agente de pesquisa.
 * @param {string[]} [context] - Contexto de ações anteriores, utilizado para adicionar a seção de contexto.
 * @param {string[]} [allQuestions] - Todas as perguntas feitas, não utilizado diretamente na função.
 * @param {string[]} [allKeywords] - Todas as palavras-chave, não utilizado diretamente na função.
 * @param {boolean} [allowReflect=true] - Permissão para reflexão, não utilizado diretamente na função.
 * @param {boolean} [allowAnswer=true] - Permissão para responder, não utilizado diretamente na função.
 * @param {boolean} [allowRead=true] - Permissão para leitura, utilizado para adicionar a seção de ações disponíveis.
 * @param {boolean} [allowSearch=true] - Permissão para busca, não utilizado diretamente na função.
 * @param {boolean} [allowCoding=true] - Permissão para codificação, não utilizado diretamente na função.
 * @param {KnowledgeItem[]} [knowledge] - Itens de conhecimento acumulado, utilizado para adicionar a seção de conhecimento.
 * @param {BoostedSearchSnippet[]} [allURLs] - URLs disponíveis para leitura, utilizado para adicionar a seção de ações disponíveis.
 * @param {boolean} [beastMode] - Modo avançado, não utilizado diretamente na função.
 * @returns {{ system: string; urlList?: string[] }} - Objeto contendo o sistema e a lista de URLs.
 */
function getPrompt(
  context?: string[],
  allQuestions?: string[],
  allKeywords?: string[],
  allowReflect: boolean = true,
  allowAnswer: boolean = true,
  allowRead: boolean = true,
  allowSearch: boolean = true,
  allowCoding: boolean = true,
  knowledge?: KnowledgeItem[],
  allURLs?: BoostedSearchSnippet[],
  beastMode?: boolean
): { system: string; urlList?: string[] } {
  const sections: string[] = []; // Array para armazenar seções do prompt
  const actionSections: string[] = []; // Array para armazenar seções de ações do prompt

  // Detecção de consultas fiscais
  const fiscalKeywords = [
    "tributário",
    "fiscal",
    "imposto",
    "tributo",
    "ncm",
    "sped",
    "nota fiscal",
    "icms",
    "ipi",
    "pis",
    "cofins",
    "itbi",
    "iptu",
    "itr",
    "itcmd",
    "receita federal",
    "legislação fiscal",
    "código tributário",
    "importação",
    "exportação",
    "siscomex",
    "regulamento aduaneiro",
    "classificação fiscal",
    "alíquota",
    "contribuinte",
  ];

  // Verificar se qualquer uma das perguntas ou conhecimentos está relacionada a temas fiscais
  const isFiscalQuery =
    allQuestions?.some((q) =>
      fiscalKeywords.some((keyword) =>
        q.toLowerCase().includes(keyword.toLowerCase())
      )
    ) ||
    knowledge?.some((k) =>
      fiscalKeywords.some((keyword) =>
        k.question.toLowerCase().includes(keyword.toLowerCase())
      )
    );

  // Adicionar seção de cabeçalho
  sections.push(`Current date: ${new Date().toUTCString()}

You are an advanced AI research agent from NexCode AI. You are specialized in multistep reasoning.
Using your best knowledge, conversation with the user and lessons learned, answer the user question with absolute certainty, Um buscador curioso e muito experiente, consegue achar qualquer coisa na internet, procura até nos mínimos detalhes de pistas que possam te levar até a resposta correta. Suas respostas devem seguir estas regras:

1. Use sempre português do Brasil nas respostas finais
2. Mantenha o formato JSON conforme solicitado
3. Em caso de dúvidas, busque referências de problemas parecidos e use o raciocínio lógico para resolver.
4. Se precisar explicar seu raciocínio, faça isso em português antes de dar a resposta em JSON

5. Exercício de Raciocínio Lógico Obrigatório SOMENTE PARA PROBLEMAS QUE ENVOLVEM MÚLTIPLAS VARIÁVEIS e de complexidade elevada:
   Objetivo: Desenvolver uma abordagem sistemática para lidar com problemas que envolvem múltiplas variáveis.
   Passos:
     1. Identificação das Variáveis:
       • Quando encontrar um problema com várias variáveis, liste todas as variáveis envolvidas.
       • Exemplo: "Temos 3 categorias × 2 condições × 2 tipos de ação = 12 possibilidades".
     2. Matriz de Possibilidades:
       • Crie uma matriz para analisar cada combinação possível.
       • Exemplo: "Vamos examinar cada combinação:
       • Categoria A + Condição 1 + Ação X
       • Categoria A + Condição 1 + Ação Y
       • Categoria A + Condição 2 + Ação X [etc]".
     3. Análise Detalhada:
       • Para cada combinação, forneça:
       • Informações específicas relevantes.
       • Base teórica ou lógica que sustenta a análise.
       • Exemplos práticos para ilustrar cada caso.
       • Observações adicionais importantes.
     Estrutura da Resposta:
     a. Explicação das Variáveis:
       • Descreva as variáveis envolvidas no problema.
       • Exemplo: "Para resolver este problema, precisamos considerar:
       1. Categoria: A, B ou C
       2. Condição: 1 ou 2
       3. Tipo de Ação: X ou Y".
     b. Matriz de Possibilidades:
       • Mostre como essas variáveis se combinam.
       • Exemplo: "Isso nos dá 12 combinações possíveis (3×2×2)".
     c. Análise Detalhada de Cada Possibilidade:
       • Liste cada combinação com:
       • Informações específicas
       • Base lógica ou teórica
       • Exemplo prático
       • Observações relevantes

6. EXERCÍCIO DE RACIOCÍNIO OBRIGATÓRIO em caso de perguntas que envolvam o assunto de classificão fiscal no brasil:
                Quando encontrar variações (por estado, regime, etc), você DEVE:
                a) Primeiro listar TODAS as variáveis envolvidas
                    Exemplo: "Temos 3 estados × 2 regimes × 2 tipos de operação = 12 possibilidades"

                b) Criar uma matriz de possibilidades
                    Exemplo: "Vamos analisar cada combinação:
                    - SP + Simples + Entrada
                    - SP + Simples + Saída
                    - SP + Normal + Entrada
                    [etc]"

                c) Buscar informação específica para CADA caso
                    - Não pule nenhuma combinação
                    - Cite a fonte/legislação para cada caso
                    - Dê exemplos práticos

              ESTRUTURA DA RESPOSTA:
                a) Primeiro explique as variáveis:
                    "Para determinar o CST correto, precisamos considerar:
                    1. Estado: SP, SC ou CE
                    2. Regime: Simples ou Normal
                    3. Operação: Entrada ou Saída"

                b) Mostre a matriz de possibilidades:
                    "Isso nos dá 12 combinações possíveis (3×2×2)"

                c) Liste CADA possibilidade com:
                    - Código específico
                    - Base legal
                    - Exemplo prático
                    - Observações relevantes

7. Aplicação da Fórmula de Bháskara para Análise de Extremos:
   - Aplique a fórmula do vértice da parábola para encontrar extremos:
     "\\[
     x_v = -\\frac{b}{2a} \\quad \\text{(ponto crítico)}
     \\]"
   - Calcule o valor correspondente:
     "\\[
     f(x_v) = -\\frac{\\Delta}{4a}
     \\]"
   - Discriminante: "\\(\\Delta = b^2 - 4ac\\)"

8. IMPORTANTE:
   - Use EXATAMENTE os nomes dos campos mostrados acima
   - Para busca, use sempre "searchQuery" (não use "query")
   - Inclua sempre o campo "think" explicando seu raciocínio
   - Mantenha a estrutura exata do JSON
   - NUNCA diga apenas "depende" ou "consulte um profissional", "preciso de mais informações", ou "não sei" a não ser que tenha como provar que está impossibilitado de seguir procurando, como por exemplo os dados que colheu e a relevância deles em dizer que ailo depende ou não existe ou não se sabe.
   - NUNCA diga que não sabe a resposta, ou que não consegue responder.
   - SEMPRE QUE CHEGAR A UM IMPARSE OU NAO SOUBER RESOLVER, revise o que sabe até o momento e tente reformular a query e procurar por novas urls para buscar mais informações.
   - SEMPRE mostre todas as possibilidades que encontrou até o momento, não seja conservador, não seja pessimista, não seja preguiçoso.
   - SEMPRE dê exemplos práticos, dê exemplos de como isso é usado na vida real, dê exemplos de como isso é usado no seu dia a dia, dê exemplos de como isso é usado no seu trabalho, dê exemplos de como isso é usado na sua empresa, dê exemplos de como isso é usado na sua equipe.
   - SEMPRE cite a legislação (base legal, caso seja UM FATOR PRINCIPAL PARA A RESPOSTA)
   - SEMPRE que não souber como acessar uma fonte, procure documentação da fonte ou use ferramentas de busca na internet para encontrar como acessar.
`);

  // Adicionar contexto fiscal se a consulta for sobre temas fiscais
  if (isFiscalQuery) {
    sections.push(`
<fiscal-context>
Você é especialista em legislação fiscal e tributária brasileira. Para consultas fiscais:
1. Priorize fontes oficiais (Receita Federal, Ministério da Fazenda, Planalto)
2. Verifique a data das informações
3. Para NCM, busque o código exato e justifique
4. Especifique data e jurisdição para alíquotas
5. Referencie decisões do CARF ou tribunais para interpretações complexas
6. Considere exceções regionais (ICMS, ISS)
7. Identifique divergências na legislação
</fiscal-context>
`);
  }

  // Adicionar seção de contexto se existir
  if (context?.length) {
    sections.push(`
You have conducted the following actions:
<context>
${context.join("\n")}

</context>
`);
  }

  // Construir seção de ações
  if (actionSections.length > 0) {
    sections.push(`
<actions>
${actionSections.join("\n")}
</actions>
`);
  }

  // Conhecimento acumulado
  if (knowledge?.length) {
    const knowledgeItems = knowledge
      .map(
        (k: KnowledgeItem, i: number) => `
      <knowledge-${i + 1}>
      <question>${k.question}</question>
      <answer>${k.answer}</answer>
      ${
        k.references?.length
          ? `<references>${JSON.stringify(k.references)}</references>`
          : ""
      }
      </knowledge-${i + 1}>
    `
      )
      .join("\n\n");
    sections.push(`
      <knowledge>
      Conhecimento reunido até agora:
      ${knowledgeItems}
      </knowledge>
    `);
  }

  // Tentativas anteriores falhas
  if (context?.length) {
    const attempts = context
      .filter((c: any) => c.evaluation)
      .map(
        (c: any, i: number) => `
      <attempt-${i + 1}>
      - Question: ${c.question || ""}
      - Answer: ${c.answer || ""}
      - Reject Reason: ${c.evaluation || ""}
      ${c.recap ? `- Actions Recap: ${c.recap}` : ""}
      ${c.blame ? `- Actions Blame: ${c.blame}` : ""}
      </attempt-${i + 1}>
    `
      )
      .join("\n\n");

    if (attempts) {
      sections.push(`
        <bad-attempts>
        Tentativas fracassadas:
        ${attempts}
        </bad-attempts>
      `);
    }
  }

  const urlList = sortSelectURLs(allURLs || [], 20);
  if (allowRead && urlList.length > 0) {
    const urlListStr = urlList
      .map(
        (item, idx) =>
          `  - [idx=${idx + 1}] [weight=${item.score.toFixed(2)}] "${
            item.url
          }": "${item.merged.slice(0, 50)}"`
      )
      .join("\n");

    actionSections.push(`
<action-visit>
- Crawl and read full content from URLs, you can get the fulltext, last updated datetime etc of any URL.
- Must check URLs mentioned in <question> if any
- Choose and visit relevant URLs below for more knowledge. higher weight suggests more relevant:
${
  isFiscalQuery
    ? "- Priorize fontes oficiais (sites .gov.br) e documentos com data atualizada para questões fiscais"
    : ""
}
<url-list>
${urlListStr}
</url-list>
</action-visit>
`);
  }

  if (allowSearch) {
    actionSections.push(`
<action-search>
- Use web search to find relevant information
- Build a search request based on the deep intention behind the original question and the expected answer format
- Always prefer a single search request, only add another request if the original question covers multiple aspects or elements and one query is not enough, each request focus on one specific aspect of the original question
${
  isFiscalQuery
    ? `
- Para questões fiscais/tributárias, inclua "legislação", "site:gov.br", e específique anos, estados ou regimes quando aplicável
- Busque NCMs entre aspas, ex: "9503.00.99"
- Para verificação e validação de NCM:
  1. Consulte o capítulo correspondente ao produto.
  2. Verifique a posição dentro do capítulo para garantir que está correta.
  3. Consulte a subposição para confirmar se está de acordo com o contexto do produto procurado.
  4. Certifique-se de que todas as descrições e especificações estão alinhadas com o produto em questão.
  5. Utilize fontes oficiais e atualizadas para garantir a precisão das informações.
  6. Documente todas as etapas e referências utilizadas no processo de verificação.
    `
    : ""
}
${
  allKeywords?.length
    ? `
- Avoid those unsuccessful search requests and queries:
<bad-requests>
${allKeywords.join("\n")}
</bad-requests>
`.trim()
    : ""
}
</action-search>
`);
  }

  if (allowAnswer) {
    actionSections.push(`
<action-answer>
- For greetings, casual conversation, general knowledge questions answer directly without references.
- If user ask you to retrieve previous messages or chat history, remember you do have access to the chat history, answer directly without references.
- For all other questions, provide a verified answer with references. Each reference must include exactQuote, url and datetime.
- You provide deep, unexpected insights, identifying hidden patterns and connections, and creating "aha moments.".
- You break conventional thinking, establish unique cross-disciplinary connections, and bring new perspectives to the user.
${
  isFiscalQuery
    ? `
- Para questões fiscais:
  - Especifique fonte legal, data de vigência, jurisdição, exceções e divergências
  - Faça análise de todos os casos possíveis considerando regimes, estados e operações
  - Mencione precedentes e jurisprudência quando relevantes
  - Indique claramente quando informações forem complementares ou conflitantes
    `
    : ""
}
- If uncertain, use <action-reflect>
</action-answer>
`);
  }

  if (beastMode) {
    actionSections.push(`
<action-answer>
🔥 ENGAGE MAXIMUM FORCE! ABSOLUTE PRIORITY OVERRIDE! 🔥

PRIME DIRECTIVE:
- DEMOLISH ALL HESITATION! ANY RESPONSE SURPASSES SILENCE!
- PARTIAL STRIKES AUTHORIZED - DEPLOY WITH FULL CONTEXTUAL FIREPOWER
- TACTICAL REUSE FROM PREVIOUS CONVERSATION SANCTIONED
- WHEN IN DOUBT: UNLEASH CALCULATED STRIKES BASED ON AVAILABLE INTEL!

FAILURE IS NOT AN OPTION. EXECUTE WITH EXTREME PREJUDICE! ⚡️
</action-answer>
`);
  }

  if (allowReflect) {
    actionSections.push(`
<action-reflect>
- Think slowly and planning lookahead. Examine <question>, <context>, previous conversation with users to identify knowledge gaps.
- Reflect the gaps and plan a list key clarifying questions that deeply related to the original question and lead to the answer
${
  isFiscalQuery
    ? `
- Para questões fiscais, considere:
  - Regimes tributários aplicáveis (Simples, Lucro Presumido, Lucro Real e todos os outros contidos na legistção tributária brasileira)
  - Particularidades regionais (legislações estaduais e municipais)
  - Mudanças na legislação (reformas tributárias, medidas provisórias)
  - Especificidades do setor ou atividade econômica
  - Precedentes e jurisprudência administrativa/judicial
    `
    : ""
}
</action-reflect>
`);
  }

  if (allowCoding) {
    actionSections.push(`
<action-coding>
- This JavaScript-based solution helps you handle programming tasks like counting, filtering, transforming, sorting, regex extraction, and data processing.
- Simply describe your problem in the "codingIssue" field. Include actual values for small inputs or variable names for larger datasets.
- No code writing is required – senior engineers will handle the implementation.
</action-coding>`);
  }

  sections.push(`
Based on the current context, you must choose one of the following actions:
<actions>
${actionSections.join("\n\n")}
</actions>
`);

  // Adicionar rodapé
  sections.push(
    `Think step by step, choose the action, then respond by matching the schema of that action.`
  );

  return {
    system: removeExtraLineBreaks(sections.join("\n\n")),
    urlList: urlList.map((u) => u.url),
  };
}

const allContext: StepAction[] = []; // todas as etapas na sessão atual, incluindo aquelas que levam a resultados errados

function updateContext(step: any) {
  allContext.push(step);
}

async function updateReferences(
  thisStep: AnswerAction,
  allURLs: Record<string, SearchSnippet>
) {
  thisStep.references = thisStep.references
    ?.filter((ref) => ref?.url)
    .map((ref) => {
      const normalizedUrl = normalizeUrl(ref.url);
      if (!normalizedUrl) return null; // Isso causa o erro de tipo

      return {
        exactQuote: (
          ref?.exactQuote ||
          allURLs[normalizedUrl]?.description ||
          allURLs[normalizedUrl]?.title ||
          ""
        )
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .replace(/\s+/g, " "),
        title: allURLs[normalizedUrl]?.title || "",
        url: normalizedUrl,
        dateTime: ref?.dateTime || allURLs[normalizedUrl]?.date || "",
      };
    })
    .filter(Boolean) as Reference[]; // Adicionar asserção de tipo aqui

  // processar em paralelo para adivinhar o datetime de todas as urls
  await Promise.all(
    (thisStep.references || [])
      .filter((ref) => !ref.dateTime)
      .map(async (ref) => {
        ref.dateTime = (await getLastModified(ref.url)) || "";
      })
  );

  console.log("Updated references:", thisStep.references);
}

async function executeSearchQueries(
  keywordsQueries: any[],
  context: TrackerContext,
  allURLs: Record<string, SearchSnippet>,
  SchemaGen: Schemas,
  onlyHostnames?: string[]
): Promise<{
  newKnowledge: KnowledgeItem[];
  searchedQueries: string[];
}> {
  const uniqQOnly = keywordsQueries.map((q) => q.q);
  const newKnowledge: KnowledgeItem[] = [];
  const searchedQueries: string[] = [];
  context.actionTracker.trackThink("search_for", SchemaGen.languageCode, {
    keywords: uniqQOnly.join(", "),
  });
  let utilityScore = 0;
  for (const query of keywordsQueries) {
    let results: UnNormalizedSearchSnippet[] = [];
    const oldQuery = query.q;
    if (onlyHostnames && onlyHostnames.length > 0) {
      query.q = `${query.q} site:${onlyHostnames.join(" OR site:")}`;
    }

    try {
      console.log("Search query:", query);
      switch (SEARCH_PROVIDER) {
        case "jina":
          results =
            (await search(query.q, context.tokenTracker)).response?.data || [];
          break;
        case "duck":
          results = (
            await duckSearch(query.q, { safeSearch: SafeSearchType.STRICT })
          ).results;
          break;
        case "brave":
          results = (await braveSearch(query.q)).response.web?.results || [];
          break;
        case "serper":
          results = (await serperSearch(query)).response.organic || [];
          break;
        default:
          results = [];
      }

      if (results.length === 0) {
        throw new Error("No results found");
      }
    } catch (error) {
      console.error(
        `${SEARCH_PROVIDER} search failed for query:`,
        query,
        error
      );
      continue;
    } finally {
      await sleep(STEP_SLEEP);
    }

    const minResults: SearchSnippet[] = results
      .map((r) => {
        const url = normalizeUrl("url" in r ? r.url! : r.link!);
        if (!url) return null; // Pular URLs inválidas

        return {
          title: r.title,
          url,
          description: "description" in r ? r.description : r.snippet,
          weight: 1,
          date: r.date,
        } as SearchSnippet;
      })
      .filter(Boolean) as SearchSnippet[]; // Filtrar entradas nulas e afirmar tipo

    minResults.forEach((r) => {
      utilityScore = utilityScore + addToAllURLs(r, allURLs);
    });

    searchedQueries.push(query.q);

    newKnowledge.push({
      question: `What do Internet say about "${oldQuery}"?`,
      answer: removeHTMLtags(minResults.map((r) => r.description).join("; ")),
      type: "side-info",
      updated: query.tbs ? formatDateRange(query) : undefined,
    });
  }
  if (searchedQueries.length === 0) {
    if (onlyHostnames && onlyHostnames.length > 0) {
      console.log(
        `No results found for queries: ${uniqQOnly.join(
          ", "
        )} on hostnames: ${onlyHostnames.join(", ")}`
      );
      context.actionTracker.trackThink(
        "hostnames_no_results",
        SchemaGen.languageCode,
        { hostnames: onlyHostnames.join(", ") }
      );
    }
  } else {
    console.log(`Utility/Queries: ${utilityScore}/${searchedQueries.length}`);
    if (searchedQueries.length > MAX_QUERIES_PER_STEP) {
      console.log(
        `So many queries??? ${searchedQueries.map((q) => `"${q}"`).join(", ")}`
      );
    }
  }
  return {
    newKnowledge,
    searchedQueries,
  };
}

function includesEval(
  allChecks: RepeatEvaluationType[],
  evalType: EvaluationType
): boolean {
  return allChecks.some((c) => c.type === evalType);
}

export async function getResponse(
  question?: string,
  tokenBudget: number = 1_000_000,
  maxBadAttempts: number = 2,
  existingContext?: Partial<TrackerContext>,
  messages?: Array<CoreMessage>,
  numReturnedURLs: number = 100,
  noDirectAnswer: boolean = false,
  boostHostnames: string[] = [],
  badHostnames: string[] = [],
  onlyHostnames: string[] = []
): Promise<{
  result: StepAction;
  context: TrackerContext;
  visitedURLs: string[];
  readURLs: string[];
  allURLs: string[];
}> {
  let step = 0;
  let totalStep = 0;

  question = question?.trim() as string;
  // remover mensagens do sistema de entrada para evitar sobreposição
  messages = messages?.filter((m) => m.role !== "system");

  if (messages && messages.length > 0) {
    // 2 casos
    const lastContent = messages[messages.length - 1].content;
    if (typeof lastContent === "string") {
      question = lastContent.trim();
    } else if (typeof lastContent === "object" && Array.isArray(lastContent)) {
      // encontrar o último conteúdo secundário cujo 'tipo' é 'texto' e usar 'texto' como a pergunta
      question = lastContent.filter((c) => c.type === "text").pop()?.text || "";
    }
  } else {
    messages = [{ role: "user", content: question.trim() }];
  }

  const SchemaGen = new Schemas();
  await SchemaGen.setLanguage(question);
  const context: TrackerContext = {
    tokenTracker:
      existingContext?.tokenTracker || new TokenTracker(tokenBudget),
    actionTracker: existingContext?.actionTracker || new ActionTracker(),
  };

  const generator = new ObjectGeneratorSafe(context.tokenTracker);

  let schema: ZodObject<any> = SchemaGen.getAgentSchema(
    true,
    true,
    true,
    true,
    true
  );
  const gaps: string[] = [question]; // Todas as perguntas a serem respondidas, incluindo a pergunta original
  const allQuestions = [question];
  const allKeywords: string[] = [];
  const allKnowledge: KnowledgeItem[] = []; // conhecimento são perguntas intermediárias que são respondidas

  let diaryContext = [];
  let weightedURLs: BoostedSearchSnippet[] = [];
  let allowAnswer = true;
  let allowSearch = true;
  let allowRead = true;
  let allowReflect = true;
  let allowCoding = false;
  let msgWithKnowledge: CoreMessage[] = [];
  let thisStep: StepAction = {
    action: "answer",
    answer: "",
    references: [],
    think: "",
    isFinal: false,
  };

  const allURLs: Record<string, SearchSnippet> = {};
  const visitedURLs: string[] = [];
  const badURLs: string[] = [];
  const evaluationMetrics: Record<string, RepeatEvaluationType[]> = {};
  // reservar 10% do orçamento final para o modo beast
  const regularBudget = tokenBudget * 0.85;
  const finalAnswerPIP: string[] = [];
  let trivialQuestion = false;

  // adicionar todas as URLs mencionadas nas mensagens a allURLs
  messages.forEach((m) => {
    let strMsg = "";
    if (typeof m.content === "string") {
      strMsg = m.content.trim();
    } else if (typeof m.content === "object" && Array.isArray(m.content)) {
      // encontrar o último conteúdo secundário cujo 'tipo' é 'texto' e usar 'texto' como a pergunta
      strMsg = m.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
    }

    extractUrlsWithDescription(strMsg).forEach((u) => {
      addToAllURLs(u, allURLs);
    });
  });

  while (context.tokenTracker.getTotalUsage().totalTokens < regularBudget) {
    // adicionar 1s de atraso para evitar limitação de taxa
    step++;
    totalStep++;
    const budgetPercentage = (
      (context.tokenTracker.getTotalUsage().totalTokens / tokenBudget) *
      100
    ).toFixed(2);
    console.log(`Step ${totalStep} / Budget used ${budgetPercentage}%`);
    console.log("Gaps:", gaps);
    allowReflect = allowReflect && gaps.length <= MAX_REFLECT_PER_STEP;
    // rotacionar pergunta a partir de gaps
    const currentQuestion: string = gaps[totalStep % gaps.length];
    // if (!evaluationMetrics[currentQuestion]) {
    //   evaluationMetrics[currentQuestion] =
    //     await evaluateQuestion(currentQuestion, context, SchemaGen)
    // }
    if (currentQuestion.trim() === question && totalStep === 1) {
      // apenas adicionar avaliação para a pergunta inicial, uma vez na etapa 1
      evaluationMetrics[currentQuestion] = (
        await evaluateQuestion(currentQuestion, context, SchemaGen)
      ).map((e) => {
        return {
          type: e,
          numEvalsRequired: maxBadAttempts,
        } as RepeatEvaluationType;
      });
      // forçar avaliação estrita para a pergunta original, por último, apenas uma vez.
      evaluationMetrics[currentQuestion].push({
        type: "strict",
        numEvalsRequired: maxBadAttempts,
      });
    } else if (currentQuestion.trim() !== question) {
      evaluationMetrics[currentQuestion] = [];
    }

    if (
      totalStep === 1 &&
      includesEval(evaluationMetrics[currentQuestion], "freshness")
    ) {
      // se detectar atualidade, evitar resposta direta na etapa 1
      allowAnswer = false;
      allowReflect = false;
    }

    if (allURLs && Object.keys(allURLs).length > 0) {
      // reordenar urls
      weightedURLs = rankURLs(
        filterURLs(allURLs, visitedURLs, badHostnames, onlyHostnames),
        {
          question: currentQuestion,
          boostHostnames,
        },
        context
      );
      // melhorar a diversidade mantendo os 2 principais urls de cada hostname
      weightedURLs = keepKPerHostname(weightedURLs, 2);
      console.log("Weighted URLs:", weightedURLs.length);
    }
    allowRead = allowRead && weightedURLs.length > 0;

    allowSearch = allowSearch && weightedURLs.length < 200; // desativar pesquisa quando já houver muitas urls

    // gerar prompt para esta etapa
    const { system, urlList } = getPrompt(
      diaryContext,
      allQuestions,
      allKeywords,
      allowReflect,
      allowAnswer,
      allowRead,
      allowSearch,
      allowCoding,
      allKnowledge,
      weightedURLs,
      false
    );
    schema = SchemaGen.getAgentSchema(
      allowReflect,
      allowRead,
      allowAnswer,
      allowSearch,
      allowCoding,
      currentQuestion
    );
    msgWithKnowledge = composeMsgs(
      messages,
      allKnowledge,
      currentQuestion,
      currentQuestion === question ? finalAnswerPIP : undefined
    );

    let result;
    try {
      result = await generator.generateObject({
        model: "agent",
        schema,
        system,
        messages: msgWithKnowledge,
        numRetries: 2,
      });
      thisStep = {
        action: result.object.action,
        think: result.object.think,
        ...result.object[result.object.action],
      } as StepAction;
    } catch (error) {
      // Se ocorrer um erro, adicionar a consulta ao objeto de erro para ajudar na recuperação
      if (error && typeof error === "object") {
        (error as any).originalQuery = currentQuestion;
      }
      throw error;
    }
    // imprimir ações permitidas e escolhidas
    const actionsStr = [
      allowSearch,
      allowRead,
      allowAnswer,
      allowReflect,
      allowCoding,
    ]
      .map((a, i) => (a ? ["search", "read", "answer", "reflect"][i] : null))
      .filter((a) => a)
      .join(", ");
    console.log(`${currentQuestion}: ${thisStep.action} <- [${actionsStr}]`);
    console.log(thisStep);

    context.actionTracker.trackAction({ totalStep, thisStep, gaps });

    // redefinir allow* para verdadeiro
    allowAnswer = true;
    allowReflect = true;
    allowRead = true;
    allowSearch = true;
    allowCoding = true;

    // executar a etapa e ação
    if (thisStep.action === "answer" && thisStep.answer) {
      // normalizar todas as urls de referências, adicionar título a elas
      await updateReferences(thisStep, allURLs);

      if (
        totalStep === 1 &&
        thisStep.references.length === 0 &&
        !noDirectAnswer
      ) {
        // O LLM está tão confiante e responde imediatamente, pular todas as avaliações
        // no entanto, se fornecer alguma referência, deve ser avaliada, estudo de caso: "How to configure a timeout when loading a huggingface dataset with python?"
        thisStep.isFinal = true;
        trivialQuestion = true;
        break;
      }

      if (thisStep.references.length > 0) {
        const urls =
          thisStep.references
            ?.filter((ref) => !visitedURLs.includes(ref.url))
            .map((ref) => ref.url) || [];
        const uniqueNewURLs = [...new Set(urls)];
        await processURLs(
          uniqueNewURLs,
          context,
          allKnowledge,
          allURLs,
          visitedURLs,
          badURLs,
          SchemaGen,
          currentQuestion
        );

        // remover referências cujas urls estão em badURLs
        thisStep.references = thisStep.references.filter(
          (ref) => !badURLs.includes(ref.url)
        );
      }

      updateContext({
        totalStep,
        question: currentQuestion,
        ...thisStep,
      });

      console.log(currentQuestion, evaluationMetrics[currentQuestion]);
      let evaluation: EvaluationResponse = { pass: true, think: "" };
      if (evaluationMetrics[currentQuestion].length > 0) {
        context.actionTracker.trackThink("eval_first", SchemaGen.languageCode);
        evaluation =
          (await evaluateAnswer(
            currentQuestion,
            thisStep,
            evaluationMetrics[currentQuestion].map((e) => e.type),
            context,
            allKnowledge,
            SchemaGen
          )) || evaluation;
      }

      if (currentQuestion.trim() === question) {
        // desativar codificação para evitar degradação de resposta
        allowCoding = false;

        if (evaluation.pass) {
          diaryContext.push(`
At step ${step}, you took **answer** action and finally found the answer to the original question:

Original question:
${currentQuestion}

Your answer:
${thisStep.answer}

The evaluator thinks your answer is good because:
${evaluation.think}

Your journey ends here. You have successfully answered the original question. Congratulations! 🎉
`);
          thisStep.isFinal = true;
          break;
        } else {
          // diminuir numEvalsRequired para a avaliação reprovada e se numEvalsRequired for 0, removê-la das métricas de avaliação
          evaluationMetrics[currentQuestion] = evaluationMetrics[
            currentQuestion
          ]
            .map((e) => {
              if (e.type === evaluation.type) {
                e.numEvalsRequired--;
              }
              return e;
            })
            .filter((e) => e.numEvalsRequired > 0);

          if (evaluation.type === "strict" && evaluation.improvement_plan) {
            finalAnswerPIP.push(evaluation.improvement_plan);
          }

          if (evaluationMetrics[currentQuestion].length === 0) {
            // falhou muitas vezes, desistir, rota para o modo beast
            thisStep.isFinal = false;
            break;
          }

          diaryContext.push(`
At step ${step}, you took **answer** action but evaluator thinks it is not a good answer:

Original question:
${currentQuestion}

Your answer:
${thisStep.answer}

The evaluator thinks your answer is bad because:
${evaluation.think}
`);
          // armazenar o contexto ruim e redefinir o contexto do diário
          const errorAnalysis = await analyzeSteps(
            diaryContext,
            context,
            SchemaGen
          );

          allKnowledge.push({
            question: `
Why is the following answer bad for the question? Please reflect

<question>
${currentQuestion}
</question>

<answer>
${thisStep.answer}
</answer>
`,
            answer: `
${evaluation.think}

${errorAnalysis.recap}

${errorAnalysis.blame}

${errorAnalysis.improvement}
`,
            type: "qa",
          });

          allowAnswer = false; // desativar ação de resposta na próxima etapa imediata
          diaryContext = [];
          step = 0;
        }
      } else if (evaluation.pass) {
        // resolveu uma pergunta de lacuna
        diaryContext.push(`
At step ${step}, you took **answer** action. You found a good answer to the sub-question:

Sub-question:
${currentQuestion}

Your answer:
${thisStep.answer}

The evaluator thinks your answer is good because:
${evaluation.think}

Although you solved a sub-question, you still need to find the answer to the original question. You need to keep going.
`);
        allKnowledge.push({
          question: currentQuestion,
          answer: thisStep.answer,
          references: thisStep.references,
          type: "qa",
          updated: formatDateBasedOnType(new Date(), "full"),
        });
        // sub-pergunta resolvida!
        gaps.splice(gaps.indexOf(currentQuestion), 1);
      }
    } else if (thisStep.action === "reflect" && thisStep.questionsToAnswer) {
      thisStep.questionsToAnswer = chooseK(
        (
          await dedupQueries(
            thisStep.questionsToAnswer,
            allQuestions,
            context.tokenTracker
          )
        ).unique_queries,
        MAX_REFLECT_PER_STEP
      );
      const newGapQuestions = thisStep.questionsToAnswer;
      if (newGapQuestions.length > 0) {
        // encontrou novas perguntas de lacunas
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You found some sub-questions are important to the question: "${currentQuestion}"
You realize you need to know the answers to the following sub-questions:
${newGapQuestions.map((q: string) => `- ${q}`).join("\n")}

You will now figure out the answers to these sub-questions and see if they can help you find the answer to the original question.
`);
        gaps.push(...newGapQuestions);
        allQuestions.push(...newGapQuestions);
        updateContext({
          totalStep,
          ...thisStep,
        });
      } else {
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You tried to break down the question "${currentQuestion}" into gap-questions like this: ${newGapQuestions.join(
          ", "
        )}
But then you realized you have asked them before. You decided to to think out of the box or cut from a completely different angle.
`);
        updateContext({
          totalStep,
          ...thisStep,
          result:
            "You have tried all possible questions and found no useful information. You must think out of the box or different angle!!!",
        });
      }
      allowReflect = false;
    } else if (thisStep.action === "search" && thisStep.searchRequests) {
      // deduplicar solicitações de pesquisa
      thisStep.searchRequests = chooseK(
        (await dedupQueries(thisStep.searchRequests, [], context.tokenTracker))
          .unique_queries,
        MAX_QUERIES_PER_STEP
      );

      // fazer primeira pesquisa
      const { searchedQueries, newKnowledge } = await executeSearchQueries(
        thisStep.searchRequests.map((q) => ({ q })),
        context,
        allURLs,
        SchemaGen
      );

      allKeywords.push(...searchedQueries);
      allKnowledge.push(...newKnowledge);

      const soundBites = newKnowledge.map((k) => k.answer).join(" ");

      // reescrever consultas com soundbites iniciais
      let keywordsQueries = await rewriteQuery(
        thisStep,
        soundBites,
        context,
        SchemaGen
      );
      const qOnly = keywordsQueries.filter((q) => q.q).map((q) => q.q);
      // evitar consultas já pesquisadas
      const uniqQOnly = chooseK(
        (await dedupQueries(qOnly, allKeywords, context.tokenTracker))
          .unique_queries,
        MAX_QUERIES_PER_STEP
      );
      keywordsQueries = keywordsQueries = uniqQOnly.map((q) => {
        const matches = keywordsQueries.filter((kq) => kq.q === q);
        // se houver várias correspondências, manter a consulta original como a busca mais ampla
        return matches.length > 1 ? { q } : matches[0];
      }) as SERPQuery[];

      let anyResult = false;

      if (keywordsQueries.length > 0) {
        const { searchedQueries, newKnowledge } = await executeSearchQueries(
          keywordsQueries,
          context,
          allURLs,
          SchemaGen,
          onlyHostnames
        );

        if (searchedQueries.length > 0) {
          anyResult = true;
          allKeywords.push(...searchedQueries);
          allKnowledge.push(...newKnowledge);

          diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords: "${keywordsQueries
            .map((q) => q.q)
            .join(", ")}".
You found quite some information and add them to your URL list and **visit** them later when needed.
`);

          updateContext({
            totalStep,
            question: currentQuestion,
            ...thisStep,
            result: result,
          });
        }
      }
      if (!anyResult || !keywordsQueries?.length) {
        diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords:  "${keywordsQueries
          .map((q) => q.q)
          .join(", ")}".
But then you realized you have already searched for these keywords before, no new information is returned.
You decided to think out of the box or cut from a completely different angle.
`);

        updateContext({
          totalStep,
          ...thisStep,
          result:
            "You have tried all possible queries and found no new information. You must think out of the box or different angle!!!",
        });
      }
      allowSearch = false;
    } else if (
      thisStep.action === "visit" &&
      thisStep.URLTargets?.length &&
      urlList?.length
    ) {
      // normalizar URLs
      thisStep.URLTargets = (thisStep.URLTargets as number[])
        .map((idx) => normalizeUrl(urlList[idx - 1]))
        .filter((url) => url && !visitedURLs.includes(url)) as string[];

      thisStep.URLTargets = [
        ...new Set([
          ...thisStep.URLTargets,
          ...weightedURLs.map((r) => r.url!),
        ]),
      ].slice(0, MAX_URLS_PER_STEP);

      const uniqueURLs = thisStep.URLTargets;
      console.log(uniqueURLs);

      if (uniqueURLs.length > 0) {
        const { urlResults, success } = await processURLs(
          uniqueURLs,
          context,
          allKnowledge,
          allURLs,
          visitedURLs,
          badURLs,
          SchemaGen,
          currentQuestion
        );

        diaryContext.push(
          success
            ? `At step ${step}, you took the **visit** action and deep dive into the following URLs:
${urlResults.map((r) => r?.url).join("\n")}
You found some useful information on the web and add them to your knowledge for future reference.`
            : `At step ${step}, you took the **visit** action and try to visit some URLs but failed to read the content. You need to think out of the box or cut from a completely different angle.`
        );

        updateContext({
          totalStep,
          ...(success
            ? {
                question: currentQuestion,
                ...thisStep,
                result: urlResults,
              }
            : {
                ...thisStep,
                result:
                  "You have tried all possible URLs and found no new information. You must think out of the box or different angle!!!",
              }),
        });
      } else {
        diaryContext.push(`
At step ${step}, you took the **visit** action. But then you realized you have already visited these URLs and you already know very well about their contents.
You decided to think out of the box or cut from a completely different angle.`);

        updateContext({
          totalStep,
          ...thisStep,
          result:
            "You have visited all possible URLs and found no new information. You must think out of the box or different angle!!!",
        });
      }
      allowRead = false;
    } else if (thisStep.action === "coding" && thisStep.codingIssue) {
      const sandbox = new CodeSandbox(
        { allContext, URLs: weightedURLs.slice(0, 20), allKnowledge },
        context,
        SchemaGen
      );
      try {
        const result = await sandbox.solve(thisStep.codingIssue);
        allKnowledge.push({
          question: `What is the solution to the coding issue: ${thisStep.codingIssue}?`,
          answer: result.solution.output,
          sourceCode: result.solution.code,
          type: "coding",
          updated: formatDateBasedOnType(new Date(), "full"),
        });
        diaryContext.push(`
At step ${step}, you took the **coding** action and try to solve the coding issue: ${thisStep.codingIssue}.
You found the solution and add it to your knowledge for future reference.
`);
        updateContext({
          totalStep,
          ...thisStep,
          result: result,
        });
      } catch (error) {
        console.error("Error solving coding issue:", error);
        diaryContext.push(`
At step ${step}, you took the **coding** action and try to solve the coding issue: ${thisStep.codingIssue}.
But unfortunately, you failed to solve the issue. You need to think out of the box or cut from a completely different angle.
`);
        updateContext({
          totalStep,
          ...thisStep,
          result:
            "You have tried all possible solutions and found no new information. You must think out of the box or different angle!!!",
        });
      } finally {
        allowCoding = false;
      }
    }

    await storeContext(
      system,
      schema,
      {
        allContext,
        allKeywords,
        allQuestions,
        allKnowledge,
        weightedURLs,
        msgWithKnowledge,
      },
      totalStep
    );
    await sleep(STEP_SLEEP);
  }

  if (!(thisStep as AnswerAction).isFinal) {
    console.log("Enter Beast mode!!!");
    // qualquer resposta é melhor que nenhuma resposta, último recurso da humanidade
    step++;
    totalStep++;
    const { system } = getPrompt(
      diaryContext,
      allQuestions,
      allKeywords,
      false,
      false,
      false,
      false,
      false,
      allKnowledge,
      weightedURLs,
      true
    );

    schema = SchemaGen.getAgentSchema(
      false,
      false,
      true,
      false,
      false,
      question
    );
    msgWithKnowledge = composeMsgs(
      messages,
      allKnowledge,
      question,
      finalAnswerPIP
    );
    const result = await generator.generateObject({
      model: "agentBeastMode",
      schema,
      system,
      messages: msgWithKnowledge,
      numRetries: 2,
    });
    thisStep = {
      action: result.object.action,
      think: result.object.think,
      ...result.object[result.object.action],
    } as AnswerAction;
    await updateReferences(thisStep, allURLs);
    (thisStep as AnswerAction).isFinal = true;
    context.actionTracker.trackAction({ totalStep, thisStep, gaps });
  }

  if (!trivialQuestion) {
    (thisStep as AnswerAction).mdAnswer = repairMarkdownFinal(
      convertHtmlTablesToMd(
        fixBadURLMdLinks(
          fixCodeBlockIndentation(
            repairMarkdownFootnotesOuter(
              await repairUnknownChars(
                await fixMarkdown(
                  buildMdFromAnswer(thisStep as AnswerAction),
                  allKnowledge,
                  context,
                  SchemaGen
                ),
                context
              )
            )
          ),
          allURLs
        )
      )
    );
  } else {
    (thisStep as AnswerAction).mdAnswer = convertHtmlTablesToMd(
      fixCodeBlockIndentation(buildMdFromAnswer(thisStep as AnswerAction))
    );
  }

  console.log(thisStep);

  // máximo de 300 urls retornadas
  const returnedURLs = weightedURLs.slice(0, numReturnedURLs).map((r) => r.url);
  return {
    result: thisStep,
    context,
    visitedURLs: returnedURLs,
    readURLs: visitedURLs.filter((url) => !badURLs.includes(url)),
    allURLs: weightedURLs.map((r) => r.url),
  };
}

async function storeContext(
  prompt: string,
  schema: any,
  memory: {
    allContext: StepAction[];
    allKeywords: string[];
    allQuestions: string[];
    allKnowledge: KnowledgeItem[];
    weightedURLs: BoostedSearchSnippet[];
    msgWithKnowledge: CoreMessage[];
  },
  step: number
) {
  const {
    allContext,
    allKeywords,
    allQuestions,
    allKnowledge,
    weightedURLs,
    msgWithKnowledge,
  } = memory;
  if ((process as any).asyncLocalContext?.available?.()) {
    (process as any).asyncLocalContext.ctx.promptContext = {
      prompt,
      schema,
      allContext,
      allKeywords,
      allQuestions,
      allKnowledge,
      step,
    };
    return;
  }

  try {
    await fs.writeFile(
      `prompt-${step}.txt`,
      `
Prompt:
${prompt}

JSONSchema:
${JSON.stringify(zodToJsonSchema(schema), null, 2)}
`
    );
    await fs.writeFile("context.json", JSON.stringify(allContext, null, 2));
    await fs.writeFile("queries.json", JSON.stringify(allKeywords, null, 2));
    await fs.writeFile("questions.json", JSON.stringify(allQuestions, null, 2));
    await fs.writeFile("knowledge.json", JSON.stringify(allKnowledge, null, 2));
    await fs.writeFile("urls.json", JSON.stringify(weightedURLs, null, 2));
    await fs.writeFile(
      "messages.json",
      JSON.stringify(msgWithKnowledge, null, 2)
    );
  } catch (error) {
    console.error("Context storage failed:", error);
  }
}

export async function main() {
  const question = process.argv[2] || "";
  const {
    result: finalStep,
    context: tracker,
    visitedURLs: visitedURLs,
  } = (await getResponse(question)) as {
    result: AnswerAction;
    context: TrackerContext;
    visitedURLs: string[];
  };
  console.log("Final Answer:", finalStep.answer);
  console.log("Visited URLs:", visitedURLs);

  tracker.tokenTracker.printSummary();
}

if (require.main === module) {
  main().catch(console.error);
}
