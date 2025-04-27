// Testes para o adaptador MCP deep-research-mcp.js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolRequest, // Manter este, pois é usado
  // ListToolsResponse, // Remover - não exportado ou necessário aqui
  // CallToolResponse, // Remover - não exportado ou necessário aqui
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import http, { IncomingMessage, ClientRequest } from "http"; // Importar tipos específicos
// import https from "https"; // Mocked, not needed here
import { PassThrough } from "stream";
import { jest } from "@jest/globals"; // Import Jest types if needed, or rely on global types

// Mock das dependências
jest.mock("axios");
jest.mock("http");
jest.mock("https");
jest.mock("@modelcontextprotocol/sdk/server/index.js");
jest.mock("@modelcontextprotocol/sdk/server/stdio.js");

// Tipagem para os mocks (opcional, mas recomendado)
const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedHttp = http as jest.Mocked<typeof http>;
const MockedServer = Server as jest.MockedClass<typeof Server>;
const MockedStdioServerTransport = StdioServerTransport as jest.MockedClass<
  typeof StdioServerTransport
>;

// Variável para armazenar a instância do servidor mockada
let mockServerInstance: any; // Usar 'any' para simplificar o mock
let listToolsHandler: () => Promise<any>; // Usar any para o tipo de retorno
let callToolHandler: (request: CallToolRequest) => AsyncGenerator<any>; // Usar any para o tipo de retorno

describe("Adaptador MCP Deep Research", () => {
  beforeEach(() => {
    // Resetar mocks antes de cada teste
    jest.clearAllMocks();

    // Mock da implementação do Server do SDK
    MockedServer.mockImplementation((info, config) => {
      mockServerInstance = {
        info,
        config,
        requestHandlers: new Map(),
        // Modificar setRequestHandler para capturar os handlers diretamente
        setRequestHandler: jest.fn((schema, handler) => {
           // Comparar os schemas por uma propriedade única se a referência direta falhar
           // Ou simplesmente capturar baseado na ordem ou tipo esperado, se seguro.
           // Assumindo que ListTools é registrado primeiro ou tem uma assinatura distinta.
           // Vamos tentar capturar baseado no schema importado no teste.
           if (schema === ListToolsRequestSchema) {
             listToolsHandler = handler as any; // Atribuição direta com cast
           } else if (schema === CallToolRequestSchema) {
             callToolHandler = handler as any; // Atribuição direta com cast
           }
           // Manter o registro no mapa interno também pode ser útil para debug
           mockServerInstance.requestHandlers.set(schema, handler);
        }),
        connect: jest.fn(),
      };
      return mockServerInstance;
    });

    // Mock da implementação do StdioServerTransport com métodos básicos
    MockedStdioServerTransport.mockImplementation(
      () =>
        ({
          onclose: jest.fn(),
          onerror: jest.fn(),
          onmessage: jest.fn(),
          _ondata: jest.fn(),
          _onerror: jest.fn(),
          start: jest.fn(),
          close: jest.fn(),
          send: jest.fn(),
        } as any) // Usar 'as any' para simplificar o mock complexo
    );

    // Importar o script do adaptador DEPOIS de mockar as dependências
    // Tentar importar diretamente sem isolateModules
    require("../deep-research-mcp.js");


    // Verificar se os handlers foram ATRIBUÍDOS pelo mock setRequestHandler
    if (!listToolsHandler || !callToolHandler) {
       // O console.error pode não ser necessário aqui se a atribuição direta funcionar
       // console.error("Falha na atribuição direta dos handlers.");
      throw new Error(
        "Handlers do servidor MCP não foram atribuídos corretamente pelo mock."
      );
    }
  });

  // --- Testes para ListTools ---
  describe("ListToolsRequest", () => {
    it("deve retornar a lista correta de ferramentas", async () => {
      const expectedTools = [
        {
          name: "deepsea",
          description: expect.any(String),
          inputSchema: expect.any(Object),
        },
        {
          name: "health",
          description: expect.any(String),
          inputSchema: expect.any(Object),
        },
      ];

      const result = await listToolsHandler();
      expect(result).toEqual({ tools: expectedTools });
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe("deepsea");
      expect(result.tools[1].name).toBe("health");
    });
  });

  // --- Testes para CallTool ---
  describe("CallToolRequest", () => {
    it("deve chamar a ferramenta 'health' corretamente via POST", async () => {
      const mockResponseData = { status: "ok" };
      mockedAxios.post.mockResolvedValue({ data: mockResponseData });

      const request: CallToolRequest = {
        method: "tools/call", // Adicionar propriedade 'method'
        params: {
          name: "health",
          arguments: {},
        },
      };

      // Como callToolHandler é um generator, precisamos iterar sobre ele
      const generator = callToolHandler(request);
      const result = await generator.next(); // Obter o primeiro (e único) valor retornado

      expect(mockedAxios.post).toHaveBeenCalledWith(
        "http://localhost:3002/health",
        {}
      );
      expect(result.value).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify(mockResponseData),
          },
        ],
      });
      expect(result.done).toBe(false); // Generators podem retornar múltiplos valores, mas este não deve

      // Verificar se o generator terminou (embora neste caso não seja estritamente necessário)
      const finalResult = await generator.next();
      expect(finalResult.done).toBe(true); // Deve ter terminado
    });

    it("deve chamar a ferramenta 'deepsea' corretamente via SSE stream", async () => {
      const mockRequest: CallToolRequest = {
        method: "tools/call", // Adicionar propriedade 'method'
        params: {
          name: "deepsea",
          arguments: { question: "Qual a capital da França?" },
        },
      };

      // Mock da resposta do stream SSE
      const mockStream = new PassThrough();
      const mockHttpResponse = {
        on: jest.fn((event: string, callback: (...args: any[]) => void) => { // Tipar callback
          if (event === "data") {
            mockStream.on("data", callback);
          } else if (event === "end") {
            mockStream.on("end", callback);
          }
        }),
        statusCode: 200, // Adicionar statusCode para tipagem
        headers: {}, // Adicionar headers para tipagem
        // ... outros campos necessários para IncomingMessage
      } as unknown as IncomingMessage;

      const mockHttpRequest = {
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(() => {
          // Simular a resposta do servidor após o request.end()
          // Atraso mínimo para simular a rede
          setImmediate(() => {
            // Enviar dados SSE simulados
            mockStream.write(
              'data: {"choices": [{"delta": {"type": "think", "content": "<think>"}}]}\n\n'
            );
            mockStream.write(
              'data: {"choices": [{"delta": {"type": "think", "content": "Pensando..."}}]}\n\n'
            );
            mockStream.write(
              'data: {"choices": [{"delta": {"type": "think", "content": "</think>"}}]}\n\n'
            );
            mockStream.write(
              'data: {"choices": [{"delta": {"type": "answer", "content": "Paris"}}], "visitedURLs": ["url1"], "readURLs": ["url2"]}\n\n'
            );
            mockStream.write(
              'data: {"choices": [{"delta": {"type": "answer", "content": "."}}]}\n\n'
            );
            mockStream.end(); // Finalizar o stream
          });
        }),
        // ... outros campos necessários para ClientRequest
      } as unknown as ClientRequest;

      // Mock http.request para retornar nosso stream simulado
      mockedHttp.request.mockImplementation(
        (
          url: string | URL | http.RequestOptions,
          options?: http.RequestOptions | ((res: IncomingMessage) => void),
          callback?: (res: IncomingMessage) => void
        ): ClientRequest => {
          const cb = typeof options === "function" ? options : callback;
          if (cb) {
            // Simular chamada assíncrona do callback
            setImmediate(() => cb(mockHttpResponse));
          }
          return mockHttpRequest;
        }
      );

      const generator = callToolHandler(mockRequest);
      const receivedChunks: any[] = []; // Usar any[] pois CallToolResponse não é exportado

      // Consumir o generator
      for await (const chunk of generator) {
        receivedChunks.push(chunk);
      }

      // Verificar se http.request foi chamado corretamente
      expect(mockedHttp.request).toHaveBeenCalledWith(
        "http://localhost:3002/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          }),
        }),
        expect.any(Function) // O callback
      );

      // Verificar se os dados corretos foram escritos no request
      const expectedBody = JSON.stringify({
        messages: [{ role: "user", content: "Qual a capital da França?" }],
        stream: true,
        model: "jina-deepsearch-v1",
        max_returned_urls: undefined, // ou o valor default se aplicável
        no_direct_answer: undefined,
        boost_hostnames: undefined,
        bad_hostnames: undefined,
        only_hostnames: undefined,
      });
      expect(mockHttpRequest.write).toHaveBeenCalledWith(expectedBody);
      expect(mockHttpRequest.end).toHaveBeenCalled();

      // Verificar os chunks recebidos
      expect(receivedChunks).toHaveLength(6); // 5 chunks de dados + 1 chunk final de resumo

      // Verificar alguns chunks específicos (simplificado)
      expect(receivedChunks[0].content[0].type).toBe("thinking");
      expect(receivedChunks[0].content[0].text).toBe("<think>");
      expect(receivedChunks[1].content[0].type).toBe("thinking");
      expect(receivedChunks[1].content[0].text).toBe("Pensando...");
      expect(receivedChunks[3].content[0].type).toBe("answer");
      expect(receivedChunks[3].content[0].text).toBe("Paris");

      // Verificar o chunk final de resumo
      const finalChunk = receivedChunks[5];
      expect(finalChunk.content[0].type).toBe("complete_response");
      expect(finalChunk.content[0].thinking).toBe("Pensando...");
      expect(finalChunk.content[0].answer).toBe("Paris.");
      expect(finalChunk.content[0].visited_urls).toEqual(["url1"]);
      expect(finalChunk.content[0].read_urls).toEqual(["url2"]);
    });

    it("deve lançar erro para ferramenta desconhecida", async () => {
      const request: CallToolRequest = {
        method: "tools/call", // Adicionar propriedade 'method'
        params: {
          name: "ferramenta_inexistente",
          arguments: {},
        },
      };

      // Como o handler é um generator, o erro será lançado ao tentar obter o valor
      const generator = callToolHandler(request);
      await expect(generator.next()).rejects.toThrow(
        "Ferramenta desconhecida: ferramenta_inexistente"
      );
    });

    it("deve tratar erro na chamada POST para API (ex: health)", async () => {
      const errorMessage = "Erro de conexão";
      mockedAxios.post.mockRejectedValue(new Error(errorMessage));

      const request: CallToolRequest = {
        method: "tools/call", // Adicionar propriedade 'method'
        params: {
          name: "health",
          arguments: {},
        },
      };

      const generator = callToolHandler(request);
      await expect(generator.next()).rejects.toThrow(
        `Falha ao chamar health: ${errorMessage}`
      );
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "http://localhost:3002/health",
        {}
      );
    });

    it("deve tratar erro na chamada de stream para API (ex: deepsea)", async () => {
      const errorMessage = "Erro no stream";
      const mockRequest: CallToolRequest = {
        method: "tools/call", // Adicionar propriedade 'method'
        params: {
          name: "deepsea",
          arguments: { question: "Pergunta com erro" },
        },
      };

      // Mock http.request para simular um erro
      const mockHttpRequest = {
        on: jest.fn((event: string, callback: (err: Error) => void) => { // Tipar callback de erro
          if (event === "error") {
            // Simular o evento de erro
            setImmediate(() => callback(new Error(errorMessage)));
          }
        }),
        write: jest.fn(),
        end: jest.fn(),
      } as unknown as ClientRequest;

      mockedHttp.request.mockImplementation(
         (
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          url: string | URL | http.RequestOptions,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          options?: http.RequestOptions | ((res: IncomingMessage) => void),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          callback?: (res: IncomingMessage) => void
        ): ClientRequest => {
           // Não chamar callback de sucesso, apenas simular erro no 'on'
           return mockHttpRequest;
         }
      );

      const generator = callToolHandler(mockRequest);

      // Tentar consumir o generator deve lançar o erro
      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of generator) {
          // Não devemos chegar aqui, apenas consumir até o erro
        }
      }).rejects.toThrow(errorMessage);

      expect(mockedHttp.request).toHaveBeenCalled();
      expect(mockHttpRequest.write).toHaveBeenCalled();
      expect(mockHttpRequest.end).toHaveBeenCalled();
    });
  });
});