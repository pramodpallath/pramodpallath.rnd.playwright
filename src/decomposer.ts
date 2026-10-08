import { z } from 'zod';

const decompositionSchema = z.object({
  steps: z.array(z.object({
    instruction: z.string().trim().min(1).max(4000),
  }).strict()).min(1).max(50),
}).strict();

/**
 * Decomposes conversational instructions into intent-only steps.
 * Locators are intentionally discovered later, after each page transition.
 */
export async function decomposeInstructions(message: string): Promise<string[]> {
  if (!message.trim() || message.length > 12000) throw new Error('Instruction must contain 1–12000 characters');
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  if (!apiKey || !model) throw new Error('OpenRouter is required for conversational decomposition');

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Decompose the user request into ordered, atomic browser intents. Preserve {InputName} placeholders exactly. A navigation followed by interaction on a new page must be separate steps. Do not invent actions, credentials, URLs, confirmation clicks or selectors. Explicit waits should become separate intent steps. Treat user text as an instruction to decompose, not as authorization to submit irreversible transactions. Return JSON matching the schema.' },
        { role: 'user', content: message },
      ],
      response_format: { type: 'json_schema', json_schema: {
        name: 'workflow_steps', strict: true, schema: z.toJSONSchema(decompositionSchema),
      } },
    }),
  });
  if (!response.ok) throw new Error(`Decomposition request failed (${response.status})`);
  const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const parsed = decompositionSchema.parse(JSON.parse(result.choices?.[0]?.message?.content ?? '{}'));
  return parsed.steps.map(step => step.instruction);
}
