import { z } from 'zod';

export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const urlSchema = z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Use an HTTP(S) URL');
const role = z.enum(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'heading', 'dialog', 'menuitem', 'option', 'tab', 'row', 'cell', 'spinbutton']);
const target = z.discriminatedUnion('by', [
  z.object({ by: z.literal('role'), role, name: z.string().min(1), exact: z.boolean().default(true) }).strict(),
  z.object({ by: z.literal('label'), value: z.string().min(1), exact: z.boolean().default(true) }).strict(),
  z.object({ by: z.literal('text'), value: z.string().min(1), exact: z.boolean().default(true) }).strict(),
  z.object({ by: z.literal('placeholder'), value: z.string().min(1), exact: z.boolean().default(true) }).strict(),
  z.object({ by: z.literal('testId'), value: z.string().min(1) }).strict(),
  z.object({ by: z.literal('css'), value: z.string().min(1) }).strict(),
]);
export const locatorSchema = z.object({ target, frame: z.string().min(1).optional(), scope: target.optional() }).strict();
const conditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('visible'), locator: locatorSchema }).strict(),
  z.object({ kind: z.literal('hidden'), locator: locatorSchema }).strict(),
  z.object({ kind: z.literal('value'), locator: locatorSchema, value: z.string() }).strict(),
  z.object({ kind: z.literal('text'), locator: locatorSchema, value: z.string() }).strict(),
  z.object({ kind: z.literal('url'), value: urlSchema }).strict(),
  z.object({ kind: z.literal('origin'), value: urlSchema }).strict(),
]);
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: urlSchema }).strict(),
  z.object({ type: z.literal('click'), locator: locatorSchema }).strict(),
  z.object({ type: z.literal('fill'), locator: locatorSchema, value: z.string() }).strict(),
  z.object({ type: z.literal('select'), locator: locatorSchema, value: z.string() }).strict(),
  z.object({ type: z.literal('check'), locator: locatorSchema, checked: z.boolean() }).strict(),
  z.object({ type: z.literal('wait'), condition: conditionSchema }).strict(),
  z.object({ type: z.literal('extract'), locator: locatorSchema, output: idSchema, source: z.enum(['text', 'value']) }).strict(),
  z.object({ type: z.literal('extract-table'), locator: locatorSchema, output: idSchema,
    maxRows: z.number().int().min(1).max(10000).default(1000),
    next: locatorSchema.optional(), maxPages: z.number().int().min(1).max(500).default(1),
  }).strict(),
  z.object({ type: z.literal('select-combobox'), locator: locatorSchema, option: locatorSchema,
    value: z.string(), verify: locatorSchema.optional(),
  }).strict(),
  z.object({ type: z.literal('ask-user'), mode: z.enum(['browser', 'input']), prompt: z.string().min(1), input: idSchema.optional(),
    until: z.array(conditionSchema).min(1).max(10).optional(), graceMs: z.number().int().min(0).max(30000).optional(),
  }).strict().refine(a => a.mode !== 'input' || !!a.input, 'Input prompts need an input name')
    .refine(a => a.mode === 'browser' || (!a.until && a.graceMs === undefined), 'Conditional completion requires browser mode')
    .refine(a => a.graceMs === undefined || !!a.until, 'Grace period requires completion conditions'),
]);
export const planSchema = z.object({ actions: z.array(actionSchema).min(1).max(20), expect: z.array(conditionSchema).max(10).default([]) }).strict();
export const stepSchema = z.object({
  id: idSchema, instruction: z.string().min(1).max(4000),
  plan: planSchema.optional(),
  learned: z.object({ status: z.enum(['candidate', 'verified']), at: z.string() }).strict().optional(),
  timeoutMs: z.number().int().min(100).max(300000).default(30000),
}).strict();
export const flowSchema = z.object({
  version: z.literal(1), id: idSchema, name: z.string().min(1).max(120), url: urlSchema,
  profile: idSchema.default('default'),
  inputs: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), z.object({ required: z.boolean().default(true) }).strict()).default({}),
  steps: z.array(stepSchema).min(1).max(200),
}).strict().superRefine((flow, ctx) => {
  const ids = flow.steps.map(s => s.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Step IDs must be unique' });
});
export type Flow = z.infer<typeof flowSchema>;
export type Step = Flow['steps'][number];
export type Plan = z.infer<typeof planSchema>;
export type Action = Plan['actions'][number];
export type LocatorSpec = z.infer<typeof locatorSchema>;
export type Condition = z.infer<typeof conditionSchema>;

export function instructionInputs(flow: Flow): Flow['inputs'] {
  const inputs = { ...flow.inputs };
  for (const step of flow.steps) {
    for (const match of step.instruction.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
      if (!Object.hasOwn(inputs, match[1])) {
        Object.defineProperty(inputs, match[1], { value: { required: true }, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  return inputs;
}

export function interpolate(value: string, inputs: Record<string, string>): string {
  return value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    if (!Object.hasOwn(inputs, name)) throw new Error(`Missing input: ${name}`);
    return inputs[name];
  });
}
