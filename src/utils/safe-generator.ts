import { z } from "zod";
import {
  CoreMessage,
  generateObject,
  LanguageModelUsage,
  NoObjectGeneratedError,
  Schema,
} from "ai";
import { TokenTracker } from "./token-tracker";
import { getModel, ToolName, getToolConfig } from "../config";
import Hjson from "hjson"; // Import Hjson library

interface GenerateObjectResult<T> {
  object: T;
  usage: LanguageModelUsage;
}

interface GenerateOptions<T> {
  model: ToolName;
  schema: z.ZodType<T> | Schema<T>;
  prompt?: string;
  system?: string;
  messages?: CoreMessage[];
  numRetries?: number;
}

export class ObjectGeneratorSafe {
  private tokenTracker: TokenTracker;

  constructor(tokenTracker?: TokenTracker) {
    this.tokenTracker = tokenTracker || new TokenTracker();
  }

  /**
   * Creates a distilled version of a schema by removing all descriptions
   * This makes the schema simpler for fallback parsing scenarios
   */
  private createDistilledSchema<T>(
    schema: z.ZodType<T> | Schema<T>
  ): z.ZodType<T> | Schema<T> {
    // For zod schemas
    if (schema instanceof z.ZodType) {
      return this.stripZodDescriptions(schema);
    }

    // For AI SDK Schema objects
    if (typeof schema === "object" && schema !== null) {
      return this.stripSchemaDescriptions(schema as Schema<T>);
    }

    // If we can't determine the schema type, return as is
    return schema;
  }

  /**
   * Recursively strips descriptions from Zod schemas
   */
  private stripZodDescriptions<T>(zodSchema: z.ZodType<T>): z.ZodType<T> {
    if (zodSchema instanceof z.ZodObject) {
      const shape = zodSchema._def.shape();
      const newShape: Record<string, any> = {};

      for (const key in shape) {
        if (Object.prototype.hasOwnProperty.call(shape, key)) {
          // Recursively strip descriptions from nested schemas
          newShape[key] = this.stripZodDescriptions(shape[key]);
        }
      }

      return z.object(newShape) as unknown as z.ZodType<T>;
    }

    if (zodSchema instanceof z.ZodArray) {
      return z.array(
        this.stripZodDescriptions(zodSchema._def.type)
      ) as unknown as z.ZodType<T>;
    }

    if (zodSchema instanceof z.ZodString) {
      // Create a new string schema without any describe() metadata
      return z.string() as unknown as z.ZodType<T>;
    }

    if (
      zodSchema instanceof z.ZodUnion ||
      zodSchema instanceof z.ZodIntersection
    ) {
      // These are more complex schemas that would need special handling
      // This is a simplified implementation
      return zodSchema;
    }

    // For other primitive types or complex types we're not handling specifically,
    // return as is
    return zodSchema;
  }

  /**
   * Strips descriptions from AI SDK Schema objects
   */
  private stripSchemaDescriptions<T>(schema: Schema<T>): Schema<T> {
    // Deep clone the schema to avoid modifying the original
    const clonedSchema = JSON.parse(JSON.stringify(schema));

    // Recursively remove description properties
    const removeDescriptions = (obj: any) => {
      if (typeof obj !== "object" || obj === null) return;

      if (obj.properties) {
        for (const key in obj.properties) {
          // Remove description property
          if (obj.properties[key].description) {
            delete obj.properties[key].description;
          }

          // Recursively process nested properties
          removeDescriptions(obj.properties[key]);
        }
      }

      // Handle arrays
      if (obj.items) {
        if (obj.items.description) {
          delete obj.items.description;
        }
        removeDescriptions(obj.items);
      }

      // Handle any other nested objects that might contain descriptions
      if (obj.anyOf) obj.anyOf.forEach(removeDescriptions);
      if (obj.allOf) obj.allOf.forEach(removeDescriptions);
      if (obj.oneOf) obj.oneOf.forEach(removeDescriptions);
    };

    removeDescriptions(clonedSchema);
    return clonedSchema;
  }

  async generateObject<T>(
    options: GenerateOptions<T>
  ): Promise<GenerateObjectResult<T>> {
    const { model, schema, prompt, system, messages, numRetries = 0 } = options;

    if (!model || !schema) {
      throw new Error("Model and schema are required parameters");
    }

    try {
      // Primary attempt with main model
      const result = await generateObject({
        model: getModel(model),
        schema,
        prompt,
        system,
        messages,
        maxTokens: getToolConfig(model).maxTokens,
        temperature: getToolConfig(model).temperature,
      });

      this.tokenTracker.trackUsage(model, result.usage);
      return result;
    } catch (error) {
      // First fallback: Try manual parsing of the error response
      try {
        const errorResult = await this.handleGenerateObjectError<T>(error);
        this.tokenTracker.trackUsage(model, errorResult.usage);
        return errorResult;
      } catch (parseError) {
        if (numRetries > 0) {
          console.error(
            `${model} failed on object generation -> manual parsing failed -> retry with ${
              numRetries - 1
            } retries remaining`
          );
          return this.generateObject({
            model,
            schema,
            prompt,
            system,
            messages,
            numRetries: numRetries - 1,
          });
        } else {
          // Second fallback: Try with fallback model if provided
          console.error(
            `${model} failed on object generation -> manual parsing failed -> trying fallback with distilled schema`
          );
          try {
            let failedOutput = "";

            if (NoObjectGeneratedError.isInstance(parseError)) {
              failedOutput = (parseError as any).text;
              // find last `"url":` appear in the string, which is the source of the problem
              failedOutput = failedOutput.slice(
                0,
                Math.min(failedOutput.lastIndexOf('"url":'), 8000)
              );
            }

            // Create a distilled version of the schema without descriptions
            const distilledSchema = this.createDistilledSchema(schema);

            const fallbackResult = await generateObject({
              model: getModel("fallback"),
              schema: distilledSchema,
              prompt: `Following the given JSON schema, extract the field from below: \n\n ${failedOutput}`,
              maxTokens: getToolConfig("fallback").maxTokens,
              temperature: getToolConfig("fallback").temperature,
            });

            this.tokenTracker.trackUsage("fallback", fallbackResult.usage); // Track against fallback model
            console.log("Distilled schema parse success!");
            return fallbackResult;
          } catch (fallbackError) {
            // If fallback model also fails, try parsing its error response
            try {
              const lastChanceResult = await this.handleGenerateObjectError<T>(
                fallbackError
              );
              this.tokenTracker.trackUsage("fallback", lastChanceResult.usage);
              return lastChanceResult;
            } catch (finalError) {
              console.error(`All recovery mechanisms failed`);
              throw error; // Throw original error for better debugging
            }
          }
        }
      }
    }
  }

  private async handleGenerateObjectError<T>(
    error: unknown
  ): Promise<GenerateObjectResult<T>> {
    if (NoObjectGeneratedError.isInstance(error)) {
      console.error(
        "Object not generated according to schema, fallback to manual parsing"
      );

      let textToParse = (error as any).text;

      // Verificar se textToParse é uma string válida
      if (!textToParse || typeof textToParse !== "string") {
        console.error(
          "Error text is not a valid string. Attempting recovery with empty object."
        );

        // Extrair schema do erro ou contexto
        try {
          // Criar um objeto básico vazio compatível com o que esperamos do agente
          const emptyAgentResponse = {
            action: "search",
            think:
              "Error recovery mode: performing search for additional information",
            searchRequests: [
              // Reutilizar a última pergunta como termo de busca
              (error as any).originalQuery ||
                "informações adicionais necessárias",
            ],
          };

          console.log("Fallback to empty agent response:", emptyAgentResponse);

          return {
            object: emptyAgentResponse as unknown as T,
            usage: (error as any).usage || {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          };
        } catch (recoveryError) {
          console.error("Recovery attempt failed:", recoveryError);
          throw error;
        }
      }

      // Limpar o texto antes de tentar fazer o parsing
      // Remover backticks, marcadores de código e caracteres problemáticos
      textToParse = textToParse
        .replace(/```(json|javascript|js)?/g, "") // Remove marcadores de blocos de código
        .replace(/```/g, "") // Remove marcadores de blocos de código restantes
        .trim(); // Remove espaços em branco

      try {
        // First try standard JSON parsing
        const partialResponse = JSON.parse(textToParse);
        console.log("JSON parse success!");
        return {
          object: partialResponse as T,
          usage: (error as any).usage,
        };
      } catch (parseError) {
        // Use Hjson to parse the error response for more lenient parsing
        try {
          // Tentar corrigir problemas comuns de JSON antes do Hjson parse
          textToParse = textToParse
            .replace(/,\s*}/g, "}") // Remove vírgulas no final de objetos
            .replace(/,\s*\]/g, "]") // Remove vírgulas no final de arrays
            .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":') // Converte chaves não-citadas para citadas
            .replace(/:\s*'([^']*)'/g, ':"$1"'); // Converte aspas simples para duplas

          const hjsonResponse = Hjson.parse(textToParse);
          console.log("Hjson parse success!");
          return {
            object: hjsonResponse as T,
            usage: (error as any).usage,
          };
        } catch (hjsonError) {
          console.error("Both JSON and Hjson parsing failed:", hjsonError);
          console.error("Failed parsing text:", textToParse);

          // Última tentativa - usar regex para extrair propriedades de objetos
          try {
            console.log("Attempting emergency parsing via regex...");

            // Detectar qual tipo de ação está no texto e construir um objeto mínimo viável
            const actionMatch = textToParse.match(
              /["']?action["']?\s*:\s*["']?(\w+)["']?/i
            );
            const thinkMatch = textToParse.match(
              /["']?think["']?\s*:\s*["']?([^"']+)["']?/i
            );

            if (actionMatch && actionMatch[1]) {
              const action = actionMatch[1].toLowerCase();
              const think = thinkMatch
                ? thinkMatch[1]
                : "Emergency recovery mode";

              // Construir objeto de resposta mínimo com base na ação detectada
              const recoveryObject: any = { action, think };

              // Adicionar propriedades baseadas na ação detectada
              if (action === "search") {
                recoveryObject.searchRequests = [
                  (error as any).originalQuery || "informações adicionais",
                ];
              } else if (action === "answer") {
                recoveryObject.answer =
                  "Não foi possível gerar uma resposta estruturada.";
                recoveryObject.references = [];
              }

              console.log("Emergency parsing succeeded with:", recoveryObject);

              return {
                object: recoveryObject as unknown as T,
                usage: (error as any).usage || {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0,
                },
              };
            }

            // Se não conseguiu extrair a ação, lançar o erro original
            throw new Error("Emergency parsing failed to extract action");
          } catch (emergencyParseError) {
            console.error("Emergency parsing failed:", emergencyParseError);
            throw error;
          }
        }
      }
    }
    throw error;
  }
}
