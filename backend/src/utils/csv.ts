/**
 * Minimal RFC 4180 CSV serialization for streamed exports.
 */

/** Cells starting with these characters are evaluated as formulas by spreadsheet apps. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Serializes one cell. Values are quoted when they contain a delimiter, quote
 * or line break. Text that spreadsheets would execute as a formula is prefixed
 * with an apostrophe so exported data cannot run code when opened.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else {
    text = String(value);
  }

  if (FORMULA_PREFIX.test(text)) {
    text = `'${text}`;
  }

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serializes a row terminated by CRLF, as RFC 4180 specifies. */
export function toCsvLine(values: readonly unknown[]): string {
  return `${values.map(escapeCsvCell).join(",")}\r\n`;
}
