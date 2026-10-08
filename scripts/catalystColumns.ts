// Converts database/schema/tables.ts into Catalyst "Create Column" payloads.
// References are plain bigint columns (not Data Store foreign keys) so tables can be created
// in any order and cyclic references (application <-> site) need no special handling.
import { TABLES, Column } from "../database/schema/tables";

function toPayload(c: Column): Record<string, unknown> {
  const base = { column_name: c.name, audit_consent: "false", is_mandatory: c.required ? "true" : "false" };
  const search = { search_index_enabled: c.searchable ? "true" : "false" };
  switch (c.type) {
    case "varchar": return { ...base, ...search, data_type: "varchar", is_unique: c.unique ? "true" : "false", max_length: 255 };
    case "text": return { ...base, data_type: "text" };
    case "encrypted": return { ...base, data_type: "encrypted text" };
    case "int": return { ...base, ...search, data_type: "int", is_unique: c.unique ? "true" : "false" };
    case "bigint": return { ...base, ...search, data_type: "bigint", is_unique: c.unique ? "true" : "false" };
    case "double": return { ...base, ...search, data_type: "double", decimal_digits: 4 };
    case "boolean": return { ...base, ...search, data_type: "boolean", default_value: "false" };
    case "date": return { ...base, ...search, data_type: "date" };
    case "datetime": return { ...base, ...search, data_type: "datetime" };
  }
}

export function catalystPayloads(phase: "MVP" | "PHASE2" = "MVP") {
  return TABLES.filter((t) => t.phase === phase).map((t) => ({ table: t.name, columns: t.columns.map(toPayload) }));
}

if (require.main === module) console.log(JSON.stringify(catalystPayloads()));
