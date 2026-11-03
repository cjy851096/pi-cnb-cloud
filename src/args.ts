/**
 * Tiny flag parser for slash-command arguments.
 *
 *   /cloud --repo team/api --branch main -- fix flaky payment tests
 *
 * Tokens are whitespace separated; single and double quotes are honoured, and
 * `--flag=value` is accepted. Everything that is not a recognised flag becomes
 * positional text (joined with single spaces), which is how the prompt is read.
 */

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
  /** Positional text joined back into one string. */
  rest: string;
}

export interface ParseOptions {
  /** Flags that consume the next token as their value. */
  valueFlags?: string[];
  /** Flags that are always boolean even when followed by a non-flag token. */
  booleanFlags?: string[];
}

export function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += ch;
      }
      started = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      started = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (started) {
        out.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += ch;
    started = true;
  }

  if (started) out.push(current);
  return out;
}

export function parseArgs(input: string, options: ParseOptions = {}): ParsedArgs {
  const valueFlags = new Set(options.valueFlags ?? []);
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const tokens = tokenize(input);
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (token === "--") {
      positional.push(...tokens.slice(i + 1));
      break;
    }

    if (!token.startsWith("--") || token === "-") {
      positional.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    if (eq > 2) {
      const name = token.slice(2, eq);
      flags[name] = token.slice(eq + 1);
      continue;
    }

    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      flags[name] = true;
      continue;
    }

    const next = tokens[i + 1];
    if (valueFlags.has(name) && next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
      continue;
    }

    flags[name] = true;
  }

  return { flags, positional, rest: positional.join(" ").trim() };
}

export function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function numberFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}