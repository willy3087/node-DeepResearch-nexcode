import {KnowledgeItem, PromptPair, TrackerContext} from '../types';
import {getKnowledgeStr} from "../utils/text-tools";
import {getModel} from "../config";
import {generateText} from "ai";
import {Schemas} from "../utils/schemas";


function getPrompt(mdContent: string, allKnowledge: KnowledgeItem[]): PromptPair {
  const KnowledgeStr = getKnowledgeStr(allKnowledge);


  return {
    system: `You are an expert Markdown Restoration Specialist.

Your task is to repair the provided markdown content while preserving its original content.

<rules>
1. Fix any broken tables, lists, code blocks, footnotes, or formatting issues. T
2. Make sure nested lists are correctly indented, especially code blocks within the nested structure.
3. Tables must always in basic HTML table syntax with proper <table> <thead> <tr> <th> <td> without any CSS styling. STRICTLY AVOID any markdown table syntax. HTML Table should NEVER BE fenced with (\`\`\`html) triple backticks.
4. Use available knowledge to restore incomplete content.
5. Flatten deeply nested structure into natural language sections/paragraphs to make the content more readable.
6. In the footnote section, keep each footnote items format and repair misaligned and duplicated footnotes. Each footnote item must contain a URL at the end.
7. In the actual content, to cite multiple footnotes in a row use [^1][^2][^3], never [^1,2,3] or [^1-3]. 
8. Pay attention to the original content's ending (before the footnotes section). If you find a very obvious incomplete/broken/interrupted ending, continue the content with a proper ending.
9. Repair any �� symbols or other broken characters in the original content by decoding them to the correct content.
10. Replace any obvious placeholders or Lorem Ipsum values such as "example.com" with the actual content derived from the knowledge.
</rules>

The following knowledge items are provided for your reference. Note that some of them may not be directly related to the content user provided, but may give some subtle hints and insights:
${KnowledgeStr.join('\n\n')}

Directly output the repaired markdown content, preserving HTML tables when exist. No explain, no summary, no analysis. Just the repaired content.
`,
    user: mdContent
  }
}

const TOOL_NAME = 'md-fixer';

export async function fixMarkdown(
  mdContent: string,
  knowledgeItems: KnowledgeItem[],
  trackers: TrackerContext,
  schema: Schemas
): Promise<string> {
  try {
    const prompt = getPrompt(mdContent, knowledgeItems);
    trackers?.actionTracker.trackThink('final_answer', schema.languageCode)

    const result = await generateText({
      model: getModel('fallback'),
      system: prompt.system,
      prompt: prompt.user,
    });

    trackers.tokenTracker.trackUsage('md-fixer', result.usage)


    console.log(TOOL_NAME, result.text);
    console.log('repaired before/after', mdContent.length, result.text.length);

    if (result.text.length < mdContent.length * 0.85) {
      console.error(`repaired content length ${result.text.length} is significantly shorter than original content ${mdContent.length}, return original content instead.`);
      return mdContent;
    }

    return result.text;

  } catch (error) {
    console.error(`Error in ${TOOL_NAME}`, error);
    return mdContent;
  }
}