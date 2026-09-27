export type Column = { name: string; type: string; primary: boolean; references?: string };
export type Table = { name: string; columns: Column[] };
export type Schema = { tables: Table[]; relations: { from: string; to: string; column: string }[] };
const identifier = '[`"[]?([\\w.]+)[`"\\]]?';
function splitColumns(body: string) {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    if (body[index] === "(") depth++;
    if (body[index] === ")") depth--;
    if (body[index] === "," && depth === 0) {
      result.push(body.slice(start, index));
      start = index + 1;
    }
  }
  result.push(body.slice(start));
  return result.map((item) => item.trim()).filter(Boolean);
}
export function parseDatabaseSql(sql: string): Schema {
  const tables: Table[] = [];
  const relations: Schema["relations"] = [];
  const pattern = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}\\s*\\(`, "gi");
  for (const match of sql.matchAll(pattern)) {
    const name = match[1];
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let end = start;
    while (end < sql.length && depth) {
      if (sql[end] === "(") depth++;
      if (sql[end] === ")") depth--;
      end++;
    }
    if (depth) continue;
    const columns: Column[] = [];
    const chunks = splitColumns(sql.slice(start, end - 1));
    const primaryColumns = new Set<string>();
    for (const chunk of chunks) {
      const primary = chunk.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
      if (primary)
        for (const column of primary[1].split(",")) primaryColumns.add(column.trim().replace(/[`"[\]]/g, ""));
      const foreign = chunk.match(/FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+[`"[]?([\w.]+)/i);
      if (foreign) relations.push({ from: name, to: foreign[2], column: foreign[1].trim().replace(/[`"[\]]/g, "") });
    }
    for (const chunk of chunks) {
      if (/^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(chunk)) continue;
      const column = chunk.match(new RegExp(`^${identifier}\\s+([\\w]+(?:\\([^)]*\\))?)`, "i"));
      if (!column) continue;
      const reference = chunk.match(/REFERENCES\s+[`"[]?([\w.]+)/i);
      columns.push({
        name: column[1],
        type: column[2],
        primary: /PRIMARY\s+KEY/i.test(chunk) || primaryColumns.has(column[1]),
        references: reference?.[1],
      });
      if (reference) relations.push({ from: name, to: reference[1], column: column[1] });
    }
    tables.push({ name, columns });
  }
  return { tables, relations };
}
