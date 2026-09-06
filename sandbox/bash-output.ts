/**
 * Cap on how much bash output the model is shown.
 *
 * Above the cap the result becomes head, a marker naming the file with the
 * complete output and the total line count, then tail. pi's own truncation
 * already writes that file; when it has not, we write it ourselves.
 */

import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The one place to tune how much survives. */
export const OUTPUT_CAP = { headLines: 60, tailLines: 20 };

/**
 * pi's own truncation marker, which our marker replaces. pi appends it at the
 * very end, or just before the one-line status of a failed command, so only a
 * match there is pi's — a `[Showing …]` line elsewhere is the command's own.
 */
const PI_MARKER =
  /(?:^|\n+)\[Showing [^\n\]]*Full output: (?<path>[^\]\n]+)\](?<status>\n+[^\n]*)?\n*$/;

/** How much of the full-output file to read to find its first lines. */
const HEAD_READ_BYTES = 1 << 18;

export type CapOptions = {
  /** Where pi already saved the complete output, if it truncated. */
  fullOutputPath?: string;
  /** The true line count when pi truncated; otherwise the text's own. */
  totalLines?: number;
  writeFullOutput?: (content: string) => string;
};

function defaultWrite(content: string): string {
  const path = join(tmpdir(), `pi-bash-${randomBytes(6).toString("hex")}.txt`);
  writeFileSync(path, content, "utf-8");
  return path;
}

/** pi keeps the last lines, so the real head only exists in the file. */
function readHeadLines(path: string, count: number): string[] | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(HEAD_READ_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, read).toString("utf-8").split("\n");
    return lines.length > count ? lines.slice(0, count) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** `… of 5000.` or, for a partial last line, `… of line 5000 (…`. */
function markerTotal(marker: string): number | undefined {
  const total = / of (?:line )?(\d+)/.exec(marker)?.[1];
  return total ? Number(total) : undefined;
}

/** The rewritten text, or undefined when the output is at or under the cap. */
export function capBashOutput(
  text: string,
  options: CapOptions = {},
): string | undefined {
  const match = PI_MARKER.exec(text);
  const body = (
    match ? text.slice(0, match.index) + (match.groups?.status ?? "") : text
  ).replace(/\n$/, "");
  const lines = body.split("\n");
  if (lines.length <= OUTPUT_CAP.headLines + OUTPUT_CAP.tailLines) {
    return undefined;
  }

  const piPath = options.fullOutputPath ?? match?.groups?.path;
  const total =
    options.totalLines ??
    (match ? markerTotal(match[0]) : undefined) ??
    lines.length;
  const path = piPath ?? (options.writeFullOutput ?? defaultWrite)(text);
  const head =
    (piPath && readHeadLines(piPath, OUTPUT_CAP.headLines)) ??
    lines.slice(0, OUTPUT_CAP.headLines);
  const marker =
    `[Output capped: first ${OUTPUT_CAP.headLines} and last ` +
    `${OUTPUT_CAP.tailLines} of ${total} lines. Full output: ${path}]`;

  return [...head, marker, ...lines.slice(-OUTPUT_CAP.tailLines)].join("\n");
}
