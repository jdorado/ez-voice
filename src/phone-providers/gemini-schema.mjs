// Google's OpenAPI parameter schema rejects JSON Schema's additionalProperties.
// This changes only provider declarations; the installed domain plugin still validates
// the original full schema. Property names and nullable/size constraints are preserved.
export function geminiParameters(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return parameters;
  const {additionalProperties, ...schema} = parameters;
  if (schema.properties) schema.properties = Object.fromEntries(Object.entries(schema.properties)
    .map(([name, value]) => [name, geminiParameters(value)]));
  if (schema.items) schema.items = geminiParameters(schema.items);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[key])) schema[key] = schema[key].map(geminiParameters);
  return schema;
}
