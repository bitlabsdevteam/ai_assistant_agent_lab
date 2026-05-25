import { z } from "zod";

import { AppError } from "../errors.js";

type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: z.ZodTypeAny, name = "response"): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: name,
    ...toJsonSchema(schema),
  };
}

function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const unwrapped = unwrap(schema);
  const typeName = getTypeName(unwrapped);

  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return stringSchema(unwrapped as z.ZodString);
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return numberSchema(unwrapped as z.ZodNumber);
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean" };
    case z.ZodFirstPartyTypeKind.ZodNull:
      return { type: "null" };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: "string", enum: (unwrapped as z.ZodEnum<[string, ...string[]]>)._def.values };
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return literalSchema(unwrapped as z.ZodLiteral<z.Primitive>);
    case z.ZodFirstPartyTypeKind.ZodArray:
      return arraySchema(unwrapped as z.ZodArray<z.ZodTypeAny>);
    case z.ZodFirstPartyTypeKind.ZodObject:
      return objectSchema(unwrapped as z.ZodObject<z.ZodRawShape>);
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return unionSchema(unwrapped as z.ZodUnion<[z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]>);
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return discriminatedUnionSchema(unwrapped as z.ZodDiscriminatedUnion<string, [z.ZodDiscriminatedUnionOption<string>, ...z.ZodDiscriminatedUnionOption<string>[]]>);
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return recordSchema(unwrapped as z.ZodRecord<z.ZodString, z.ZodTypeAny>);
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return {
        anyOf: [toJsonSchema((unwrapped as z.ZodNullable<z.ZodTypeAny>).unwrap()), { type: "null" }],
      };
    default:
      throw new AppError("LLM_ERROR", `Unsupported schema for structured output conversion: ${typeName}`);
  }
}

function objectSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const shape = schema._def.shape();
  const properties: Record<string, unknown> = {};
  const required = Object.keys(shape);

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = propertySchema(value);
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function propertySchema(schema: z.ZodTypeAny): JsonSchema {
  if (isOptional(schema)) {
    return {
      anyOf: [toJsonSchema(schema), { type: "null" }],
    };
  }
  return toJsonSchema(schema);
}

function arraySchema(schema: z.ZodArray<z.ZodTypeAny>): JsonSchema {
  return {
    type: "array",
    items: toJsonSchema(schema._def.type),
    ...(schema._def.minLength ? { minItems: schema._def.minLength.value } : {}),
    ...(schema._def.maxLength ? { maxItems: schema._def.maxLength.value } : {}),
  };
}

function unionSchema(schema: z.ZodUnion<[z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]>): JsonSchema {
  return {
    anyOf: schema._def.options.map((option) => toJsonSchema(option)),
  };
}

function discriminatedUnionSchema(
  schema: z.ZodDiscriminatedUnion<
    string,
    [z.ZodDiscriminatedUnionOption<string>, ...z.ZodDiscriminatedUnionOption<string>[]]
  >,
): JsonSchema {
  return {
    anyOf: [...schema.options.values()].map((option) => toJsonSchema(option)),
  };
}

function recordSchema(schema: z.ZodRecord<z.ZodString, z.ZodTypeAny>): JsonSchema {
  return {
    type: "object",
    additionalProperties: toJsonSchema(schema._def.valueType),
  };
}

function literalSchema(schema: z.ZodLiteral<z.Primitive>): JsonSchema {
  const value = schema._def.value;
  const type = value === null ? "null" : typeof value;
  return {
    type,
    const: value,
  };
}

function stringSchema(schema: z.ZodString): JsonSchema {
  const jsonSchema: JsonSchema = { type: "string" };
  for (const check of schema._def.checks) {
    if (check.kind === "min") {
      jsonSchema.minLength = check.value;
    }
    if (check.kind === "max") {
      jsonSchema.maxLength = check.value;
    }
  }
  return jsonSchema;
}

function numberSchema(schema: z.ZodNumber): JsonSchema {
  const jsonSchema: JsonSchema = {
    type: schema.isInt ? "integer" : "number",
  };
  for (const check of schema._def.checks) {
    if (check.kind === "min") {
      if (check.inclusive) {
        jsonSchema.minimum = check.value;
      } else {
        jsonSchema.exclusiveMinimum = check.value;
      }
    }
    if (check.kind === "max") {
      if (check.inclusive) {
        jsonSchema.maximum = check.value;
      } else {
        jsonSchema.exclusiveMaximum = check.value;
      }
    }
    if (check.kind === "int") {
      jsonSchema.type = "integer";
    }
  }
  return jsonSchema;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (true) {
    const typeName = getTypeName(current);
    if (typeName === z.ZodFirstPartyTypeKind.ZodOptional) {
      current = (current as z.ZodOptional<z.ZodTypeAny>).unwrap();
      continue;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodDefault) {
      current = (current as z.ZodDefault<z.ZodTypeAny>)._def.innerType;
      continue;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
      current = (current as z.ZodEffects<z.ZodTypeAny>)._def.schema;
      continue;
    }
    return current;
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const typeName = getTypeName(schema);
  return typeName === z.ZodFirstPartyTypeKind.ZodOptional;
}

function getTypeName(schema: z.ZodTypeAny): z.ZodFirstPartyTypeKind {
  return (schema._def as { typeName: z.ZodFirstPartyTypeKind }).typeName;
}
