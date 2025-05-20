import dotenv from "dotenv";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI, OpenAIProviderSettings } from "@ai-sdk/openai";
import configJson from "../config.json";
// Load environment variables
dotenv.config();
console.log("DEBUG OPENROUTER_API_KEY:", process.env.OPENROUTER_API_KEY);
console.log("DEBUG CWD:", process.cwd());

// Types
export type LLMProvider =
  | "openai"
  | "gemini"
  | "vertex"
  | "openrouter"
  | "local";
export type ToolName = keyof typeof configJson.models.gemini.tools;

// Type definitions for our config structure
interface EnvConfig extends Partial<typeof configJson.env> {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_REFERER?: string;
  OPENROUTER_TITLE?: string;
}

interface ProviderConfig {
  createClient: string;
  clientConfig?: Record<string, any>;
}

// Environment setup
// Corrigido: propaga todas as variáveis de ambiente relevantes, não só as do configJson.env
const env: EnvConfig = { ...configJson.env };

// Lista de variáveis que queremos garantir no env
const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_REFERER",
  "OPENROUTER_TITLE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "JINA_API_KEY",
  "BRAVE_API_KEY",
  "SERPER_API_KEY",
  "LLM_PROVIDER",
];

ENV_KEYS.forEach((key) => {
  if (process.env[key]) {
    (env as any)[key] = process.env[key];
  }
});

(Object.keys(env) as (keyof EnvConfig)[]).forEach((key) => {
  if (process.env[key]) {
    env[key] = process.env[key] || env[key];
  }
});

// Setup proxy if present
if (env.https_proxy) {
  try {
    const proxyUrl = new URL(env.https_proxy).toString();
    const dispatcher = new ProxyAgent({ uri: proxyUrl });
    setGlobalDispatcher(dispatcher);
  } catch (error) {
    console.error("Failed to set proxy:", error);
  }
}

// Export environment variables
export const OPENAI_BASE_URL = env.OPENAI_BASE_URL;
export const GEMINI_API_KEY = env.GEMINI_API_KEY;
export const OPENAI_API_KEY = env.OPENAI_API_KEY;
export const JINA_API_KEY = env.JINA_API_KEY;
export const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
export const OPENROUTER_REFERER = env.OPENROUTER_REFERER;
export const OPENROUTER_TITLE = env.OPENROUTER_TITLE;
export const BRAVE_API_KEY = env.BRAVE_API_KEY;
export const SERPER_API_KEY = env.SERPER_API_KEY;
export const SEARCH_PROVIDER = configJson.defaults.search_provider;
export const STEP_SLEEP = configJson.defaults.step_sleep;

// Determine LLM provider
export const LLM_PROVIDER: LLMProvider = (() => {
  const provider = process.env.LLM_PROVIDER || configJson.defaults.llm_provider;
  if (!isValidProvider(provider)) {
    throw new Error(`Invalid LLM provider: ${provider}`);
  }
  return provider;
})();

function isValidProvider(provider: string): provider is LLMProvider {
  return (
    provider === "openai" ||
    provider === "gemini" ||
    provider === "vertex" ||
    provider === "openrouter" ||
    provider === "local"
  );
}

interface ToolConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

interface ToolOverrides {
  temperature?: number;
  maxTokens?: number;
}

// Função para verificar se um modelo existe na configuração
// Função para encontrar o provedor de um modelo específico
export function findModelProvider(model: string): LLMProvider | null {
  if (!model) return null;

  // Verificar em todos os provedores
  for (const providerName of Object.keys(configJson.models)) {
    if (providerName === "vertex") continue; // Pular "vertex" pois é um alias para "gemini"

    const providerConfig = configJson.models[providerName as keyof typeof configJson.models];

    // Verificar no modelo padrão
    if (providerConfig.default.model === model) {
      return providerName as LLMProvider;
    }

    // Verificar nas ferramentas
    for (const tool of Object.values(providerConfig.tools)) {
      if ((tool as any).model === model) {
        return providerName as LLMProvider;
      }
    }
  }

  return null;
}

export function isValidModel(model: string): boolean {
  // Se não houver modelo especificado, retornar true (usará o padrão)
  if (!model) return true;

  // Verificar em todos os provedores disponíveis
  const allModels: string[] = [];

  // Coletar todos os modelos de todos os provedores
  Object.keys(configJson.models).forEach(providerName => {
    if (providerName === "vertex") return; // Pular "vertex" pois é um alias para "gemini"

    const providerConfig = configJson.models[providerName as keyof typeof configJson.models];

    // Adicionar modelo padrão
    allModels.push(providerConfig.default.model);

    // Adicionar modelos das ferramentas
    Object.values(providerConfig.tools)
      .filter(tool => (tool as any).model)
      .forEach(tool => allModels.push((tool as any).model));
  });

  // Remover duplicatas
  const uniqueModels = [...new Set(allModels)];

  console.log(`Validating model: ${model}. Available models: ${uniqueModels.join(', ')}`);

  return uniqueModels.includes(model);
}

// Get tool configuration
export function getToolConfig(toolName: ToolName, requestedModel?: string): ToolConfig {
  // Determinar qual provedor usar com base no modelo solicitado
  let providerToUse = LLM_PROVIDER;
  let modelToUse = requestedModel;

  console.log(`[config] getToolConfig chamado com toolName: ${toolName}, requestedModel: ${requestedModel || 'não especificado'}`);

  if (requestedModel) {
    // Verificar se o modelo solicitado é válido
    if (isValidModel(requestedModel)) {
      // Encontrar o provedor do modelo solicitado
      const modelProvider = findModelProvider(requestedModel);
      if (modelProvider) {
        providerToUse = modelProvider;
        console.log(`[config] Usando provedor "${providerToUse}" para o modelo solicitado "${requestedModel}"`);
      } else {
        // Se não encontrou o provedor, usar o modelo mas manter o provedor atual
        console.log(`[config] Provedor não encontrado para o modelo "${requestedModel}", usando provedor atual "${providerToUse}"`);
      }
    } else {
      // Se o modelo não é válido, usar o modelo padrão
      console.warn(`[config] Modelo solicitado "${requestedModel}" não é válido. Usando modelo padrão.`);
      modelToUse = undefined;
    }
  } else {
    console.log(`[config] Nenhum modelo específico solicitado, usando provedor padrão: ${providerToUse}`);
  }

  // Obter a configuração do provedor
  const providerConfig =
    configJson.models[providerToUse === "vertex" ? "gemini" : providerToUse];
  const defaultConfig = providerConfig.default;
  const toolOverrides = providerConfig.tools[toolName] as ToolOverrides;

  // Se não tiver um modelo válido, usar o padrão
  if (!modelToUse) {
    modelToUse = process.env.DEFAULT_MODEL_NAME || defaultConfig.model;
  }

  return {
    model: modelToUse,
    temperature: toolOverrides.temperature ?? defaultConfig.temperature,
    maxTokens: toolOverrides.maxTokens ?? defaultConfig.maxTokens,
  };
}

export function getMaxTokens(toolName: ToolName): number {
  return getToolConfig(toolName).maxTokens;
}

// Obtém a instância do modelo
export function getModel(toolName: ToolName, requestedModel?: string) {
  const config = getToolConfig(toolName, requestedModel);

  // Determinar qual provedor usar com base no modelo selecionado
  let providerToUse = LLM_PROVIDER;

  // Encontrar o provedor do modelo selecionado
  const modelProvider = findModelProvider(config.model);
  if (modelProvider) {
    providerToUse = modelProvider;
  }

  const providerConfig = (
    configJson.providers as Record<string, ProviderConfig | undefined>
  )[providerToUse];

  // Log para debug do modelo selecionado
  console.log(`Using model: ${config.model} (requested: ${requestedModel || 'none'}) with provider: ${providerToUse}`);

  if (providerToUse === "openai") {
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY not found");
    }

    const opt: OpenAIProviderSettings = {
      apiKey: OPENAI_API_KEY,
      compatibility: providerConfig?.clientConfig?.compatibility,
    };

    if (OPENAI_BASE_URL) {
      opt.baseURL = OPENAI_BASE_URL;
    }

    return createOpenAI(opt)(config.model);
  }

  if (providerToUse === "openrouter") {
    if (!OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY not found");
    }

    const opt = {
      apiKey: OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": OPENROUTER_REFERER,
        "X-Title": OPENROUTER_TITLE,
      },
      compatibility: providerConfig?.clientConfig?.compatibility,
    } as any;

    return createOpenAI(opt)(config.model);
  }

  if (providerToUse === "local") {
    const localConfig = configJson.providers.local?.clientConfig || {};
    return createOpenAI({
      baseURL: localConfig.baseURL || "http://localhost:1234/v1",
      apiKey: localConfig.apiKey || "not-needed",
      ...providerConfig?.clientConfig,
    })(config.model);
  }

  if (providerToUse === "vertex") {
    const createVertex = require("@ai-sdk/google-vertex").createVertex;
    if (toolName === "searchGrounding") {
      return createVertex({
        project: process.env.GCLOUD_PROJECT,
        ...providerConfig?.clientConfig,
      })(config.model, { useSearchGrounding: true });
    }
    return createVertex({
      project: process.env.GCLOUD_PROJECT,
      ...providerConfig?.clientConfig,
    })(config.model);
  }

  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not found");
  }

  if (toolName === "searchGrounding") {
    return createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY })(config.model, {
      useSearchGrounding: true,
    });
  }
  return createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY })(config.model);
}

// Função para validar as variáveis de ambiente necessárias para um provedor
export function validateProviderEnv(provider: LLMProvider): void {
  switch (provider) {
    case "gemini":
      if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not found");
      break;
    case "openai":
      if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not found");
      break;
    case "openrouter":
      if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not found");
      break;
    case "local":
      // Local provider não precisa de validação de API key
      break;
    case "vertex":
      // Vertex usa as mesmas credenciais do Gemini
      if (!process.env.GCLOUD_PROJECT) throw new Error("GCLOUD_PROJECT not found");
      break;
  }
}

// Validate required environment variables for default provider
validateProviderEnv(LLM_PROVIDER);

// Verificação adicional para GEMINI_API_KEY já que agora é o provedor padrão
if (LLM_PROVIDER === "gemini" && !GEMINI_API_KEY) {
  console.error("ERRO CRÍTICO: GEMINI_API_KEY não está configurada, mas o provedor padrão é 'gemini'");
  console.error("Por favor, configure a variável de ambiente GEMINI_API_KEY");
  throw new Error("GEMINI_API_KEY not found");
}

// Sempre validar a API key do Jina, pois é usada para busca independente do provedor LLM
if (!JINA_API_KEY) throw new Error("JINA_API_KEY not found");

// Log all configurations
const configSummary = {
  provider: {
    name: LLM_PROVIDER,
    model: configJson.models[LLM_PROVIDER === "vertex" ? "gemini" : LLM_PROVIDER].default.model,
    ...(LLM_PROVIDER === "openai" && { baseUrl: OPENAI_BASE_URL }),
  },
  search: {
    provider: SEARCH_PROVIDER,
  },
  tools: Object.fromEntries(
    Object.keys(
      configJson.models[LLM_PROVIDER === "vertex" ? "gemini" : LLM_PROVIDER]
        .tools
    ).map((name) => [name, getToolConfig(name as ToolName)])
  ),
  availableModels: Object.keys(configJson.models).reduce((acc, provider) => {
    if (provider === "vertex") return acc; // Pular "vertex" pois é um alias para "gemini"

    const providerConfig = configJson.models[provider as keyof typeof configJson.models];
    const models = [
      providerConfig.default.model,
      ...Object.values(providerConfig.tools)
        .filter(tool => (tool as any).model)
        .map(tool => (tool as any).model)
    ];

    acc[provider] = [...new Set(models)];
    return acc;
  }, {} as Record<string, string[]>),
  defaults: {
    stepSleep: STEP_SLEEP,
  },
};

console.log("Configuration Summary:", JSON.stringify(configSummary, null, 2));
