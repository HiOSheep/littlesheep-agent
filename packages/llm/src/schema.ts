// @littlesheep/llm — schema.ts
// Convert zod schemas to OpenAI tool calling JSON Schema.
// MVP implementation handles common zod types; falls back to {} for unknown types.

import { z } from 'zod';
import type { ToolSpec } from './types.js';

/** Convert a zod schema to a JSON Schema object. Supports common types. */
export function zodToJsonSchema(schema: z.ZodTypeAny): object {
  return convert(schema);
}

function convert(s: z.ZodTypeAny): object {
  // Optional / Default: unwrap inner type
  if (s instanceof z.ZodOptional || s instanceof z.ZodDefault) {
    // _def.innerType is the wrapped schema
    const inner = (s as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
    return convert(inner);
  }
  // Nullable: unwrap
  if (s instanceof z.ZodNullable) {
    const inner = (s as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
    return convert(inner);
  }
  // Object
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, object> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value);
      const isOptional = value instanceof z.ZodOptional || value instanceof z.ZodDefault;
      if (!isOptional) required.push(key);
    }
    const result: Record<string, unknown> = {
      type: 'object',
      properties,
      additionalProperties: false,
    };
    if (required.length > 0) result.required = required;
    return result;
  }
  // Array
  if (s instanceof z.ZodArray) {
    return { type: 'array', items: convert(s.element) };
  }
  // Primitive types
  if (s instanceof z.ZodString) return { type: 'string' };
  if (s instanceof z.ZodNumber) {
    const def = (s as unknown as { _def: { checks?: Array<{ kind: string; value?: number }> } })._def;
    const schema: Record<string, unknown> = { type: 'number' };
    for (const check of def.checks ?? []) {
      if (check.kind === 'int') schema.multipleOf = 1;
      if (check.kind === 'min') schema.minimum = check.value;
      if (check.kind === 'max') schema.maximum = check.value;
    }
    return schema;
  }
  if (s instanceof z.ZodBoolean) return { type: 'boolean' };
  if (s instanceof z.ZodEnum) {
    return { type: 'string', enum: s.options };
  }
  if (s instanceof z.ZodLiteral) {
    return { const: s.value };
  }
  if (s instanceof z.ZodUnion) {
    const options = s.options as unknown as z.ZodTypeAny[];
    return { anyOf: options.map(convert) };
  }
  // Unknown type: empty schema (allows anything)
  return {};
}

/** Build a ToolSpec from a name, description, and zod schema. */
export function buildToolSpec(name: string, description: string, parameters: z.ZodTypeAny): ToolSpec {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: zodToJsonSchema(parameters),
    },
  };
}
