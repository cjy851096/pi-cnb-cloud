/** Parsing for the machine-readable marker the cloud runner prints at the end. */

export const RESULT_MARKER = "===PI-CNB-RESULT===";

export interface RunResult {
  status?: string;
  message?: string;
  branch?: string;
  base?: string;
  pr?: string;
  changed?: boolean;
  tests?: string;
  summary?: string;
  sn?: string;
  buildUrl?: string;
  repo?: string;
}

export function parseRunResult(log: string): RunResult | undefined {
  const index = log.lastIndexOf(RESULT_MARKER);
  if (index < 0) return undefined;

  const tail = log.slice(index + RESULT_MARKER.length);
  const line = tail.split("\n").find((item) => item.trim().startsWith("{"));
  if (!line) return undefined;

  try {
    return JSON.parse(line) as RunResult;
  } catch {
    return undefined;
  }
}