#!/usr/bin/env node

/**
 * Adaptador MCP para deep-research-nexcode
 * Este script atua como um proxy entre o protocolo MCP e a API HTTP do deep-research
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const axios = require("axios");
const https = require("https");
const http = require("http");

// URL base da API deep-research
const API_BASE_URL = "http://localhost:3002";

// Criar servidor MCP
const server = new Server(
  {
    name: "deep-research-nexcode",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Mapear ferramentas para endpoints da API
const toolToEndpoint = {
  deepsea: "/v1/chat/completions",
  health: "/health",
};

// Listar ferramentas disponíveis
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "deepsea",
        description:
          "Realiza busca profunda e responde perguntas com justificativa baseada nas fontes encontradas",
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "Pergunta para responder",
            },
            max_returned_urls: {
              type: "number",
              description: "Número máximo de URLs a serem retornados",
              default: 10,
            },
            no_direct_answer: {
              type: "boolean",
              description:
                "Se verdadeiro, apenas retorna as URLs sem responder diretamente",
              default: false,
            },
            boost_hostnames: {
              type: "array",
              items: {
                type: "string",
              },
              description: "Lista de domínios para priorizar nos resultados",
              default: [],
            },
            bad_hostnames: {
              type: "array",
              items: {
                type: "string",
              },
              description: "Lista de domínios para excluir dos resultados",
              default: [],
            },
            only_hostnames: {
              type: "array",
              items: {
                type: "string",
              },
              description: "Limitar resultados a apenas estes domínios",
              default: [],
            },
          },
          required: ["question"],
        },
      },
      {
        name: "health",
        description: "Verifica a saúde do serviço",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

// Chamar ferramentas
server.setRequestHandler(CallToolRequestSchema, async function* (request) {
  const { name: toolName } = request.params;
  const args = request.params.arguments || {};

  // Verificar se a ferramenta existe
  const endpoint = toolToEndpoint[toolName];
  if (!endpoint) {
    throw new Error(`Ferramenta desconhecida: ${toolName}`);
  }

  // Se for deepsea, usar streaming SSE
  if (toolName === "deepsea") {
    // Preparar a mensagem para a API deep-research
    const messages = [
      {
        role: "user",
        content: args.question,
      },
    ];

    // Adicionar parâmetros opcionais
    const chatCompletionParams = {
      messages: messages,
      stream: true,
      model: "jina-deepsearch-v1",
      max_returned_urls: args.max_returned_urls,
      no_direct_answer: args.no_direct_answer,
      boost_hostnames: args.boost_hostnames,
      bad_hostnames: args.bad_hostnames,
      only_hostnames: args.only_hostnames,
    };

    const data = JSON.stringify(chatCompletionParams);
    const url = `${API_BASE_URL}${endpoint}`;
    const isHttps = url.startsWith("https://");
    const lib = isHttps ? https : http;

    // Estruturas para armazenar dados intermediários
    let thinkingContent = "";
    let visitedURLs = [];
    let readURLs = [];
    let finalAnswer = "";
    let isInThinking = false;

    // Usar um async iterator para consumir o stream
    // Adaptar o stream de resposta para async generator
    let streamEnded = false;
    let errorInStream = null;

    // Cria um array para armazenar os chunks que chegam do stream
    const chunkQueue = [];
    // Inicia a requisição e processa o stream
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk.toString();
          let lines = buffer.split("\n\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const payload = JSON.parse(line.slice(6));

                // Processar diferentes tipos de dados recebidos no stream
                if (payload.choices && payload.choices[0]) {
                  const delta = payload.choices[0].delta || {};

                  // Capturar URLs visitadas
                  if (payload.visitedURLs) {
                    visitedURLs = payload.visitedURLs;
                  }

                  // Capturar URLs lidas
                  if (payload.readURLs) {
                    readURLs = payload.readURLs;
                  }

                  // Processar conteúdo de pensamento
                  if (delta.content) {
                    if (delta.type === "think") {
                      if (delta.content === "<think>") {
                        isInThinking = true;
                      } else if (delta.content === "</think>") {
                        isInThinking = false;
                      } else {
                        thinkingContent += delta.content;
                      }
                    } else {
                      // Conteúdo da resposta final
                      finalAnswer += delta.content;
                    }
                  }

                  // Processar URLs que estão sendo navegadas
                  if (delta.url) {
                    // Enfileirar URL como chunk separado
                    chunkQueue.push({
                      content: [
                        {
                          type: "url_visit",
                          text: `Visitando: ${delta.url}`,
                          url: delta.url,
                        },
                      ],
                    });
                  }
                }

                // Enfileirar cada chunk para o cliente no formato RooCode
                if (
                  payload.choices &&
                  payload.choices[0] &&
                  payload.choices[0].delta &&
                  payload.choices[0].delta.content
                ) {
                  let chunkType = "thinking";
                  let chunkContent = payload.choices[0].delta.content;

                  // Se não estiver mais em modo de pensar e não for o início ou fim das tags <think>
                  if (
                    !isInThinking &&
                    chunkContent !== "<think>" &&
                    chunkContent !== "</think>" &&
                    payload.choices[0].delta.type !== "think"
                  ) {
                    chunkType = "answer";
                  }

                  chunkQueue.push({
                    content: [
                      {
                        type: chunkType,
                        text: chunkContent,
                      },
                    ],
                  });
                }
              } catch (e) {
                // Ignorar erros de parse
                console.error("Erro ao processar chunk:", e);
              }
            }
          }
        });

        res.on("end", () => {
          streamEnded = true;
        });
      }
    );

    req.on("error", (err) => {
      errorInStream = err;
      streamEnded = true;
    });
    req.write(data);
    req.end();

    // Async generator que consome os chunks conforme chegam
    while (!streamEnded || chunkQueue.length > 0) {
      if (chunkQueue.length > 0) {
        yield chunkQueue.shift();
      } else {
        // Espera um pouco para evitar busy-wait
        await new Promise((r) => setTimeout(r, 20));
      }
      if (errorInStream) {
        throw errorInStream;
      }
    }

    // Quando o stream terminar, enviar um resumo completo com todos os dados
    yield {
      content: [
        {
          type: "complete_response",
          thinking: thinkingContent,
          answer: finalAnswer,
          visited_urls: visitedURLs,
          read_urls: readURLs,
        },
      ],
    };
    return;
  }

  // Demais ferramentas: POST normal
  try {
    const response = await axios.post(`${API_BASE_URL}${endpoint}`, args);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data),
        },
      ],
    };
  } catch (error) {
    console.error(`Erro ao chamar ${toolName}:`, error.message);

    throw new Error(`Falha ao chamar ${toolName}: ${error.message}`);
  }
});

// Iniciar servidor
async function main() {
  console.log("Iniciando adaptador MCP para deep-research-nexcode...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("Adaptador MCP conectado e pronto para receber requisições");
}

main().catch((error) => {
  console.error("Erro no adaptador MCP:", error);
  process.exit(1);
});
