import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as diff from "diff";
import { readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export default function (pi: ExtensionAPI) {
  // --- System Prompt ---
  pi.on("before_agent_start", async (event, ctx) => {
    return {
      systemPrompt: event.systemPrompt + `
## File Editing Rules (MANDATORY)

You have three mutation tools. Choose by complexity:

1. **smart_replace** — for any single-region edit. PREFERRED.
   - Read the file first → copy the EXACT target text (including indentation).
   - Include 2-3 surrounding context lines in \`searchText\` to ensure uniqueness.
   - The tool refuses ambiguous matches. If it refuses, ADD more context, do not change the target.

2. **apply_patch** — for multi-region edits in one file only.
   - Always \`read\` first. Quote context lines verbatim.
   - Do NOT trust your memory of line numbers — copy text exactly.

3. **edit** — legacy alias for smart_replace; do not use.

NEVER attempt to write files via shell or other tools.
NEVER regenerate a hunk that just failed without re-reading the file first.
If a mutation fails, the error message shows the actual file content — use it; do NOT retry blindly.
`,
    };
  });

  // --- Enhanced Read Tool (with Semantic Search & Patch-Ready Mode) ---
  pi.registerTool({
    name: "read",
    label: "read",
    description: "Read file contents. Supports text files. Use offset/limit for large files, or 'search' to find specific blocks.",
    promptSnippet: "Read file contents",
    promptGuidelines: [
      "Use 'search' to find specific blocks instead of scrolling the whole file.",
      "Use mode='patch-ready' to get a verbatim block you can copy directly into smart_replace or apply_patch.",
      "Use the provided line markers (L#: ) to identify exact ranges.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
      search: Type.Optional(Type.String({ description: "Regex or string to search. Returns windows centered around matches." })),
      mode: Type.Optional(Type.Union([Type.Literal("lines"), Type.Literal("patch-ready")], { description: "'patch-ready' returns content in a fenced code block ready to paste." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path, offset, limit, search, mode } = params;
      const fullPath = isAbsolute(path) ? path : join(ctx.cwd, path);

      try {
        const content = readFileSync(fullPath, "utf8");
        const lines = content.split("\n");

        // 1. Semantic Search Mode
        if (search) {
          let re: RegExp;
          try {
            re = new RegExp(search, "i");
          } catch {
            re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          }
          const hits: number[] = [];
          lines.forEach((l, i) => { if (re.test(l)) hits.push(i); });
          
          if (hits.length === 0) {
            return { content: [{ type: "text", text: `No matches for /${search}/ in ${path}.` }] };
          }

          const windows = hits.map(h => {
            const s = Math.max(0, h - 3), e = Math.min(lines.length, h + 4);
            return lines.slice(s, e).map((l, k) => `L${s + k + 1}: ${l}`).join("\n");
          }).join("\n...\n");
          
          return { content: [{ type: "text", text: `${hits.length} match(es) for /${search}/:\n\n${windows}` }] };
        }

        const startLine = offset ? Math.max(0, offset - 1) : 0;
        if (startLine >= lines.length) {
          return {
            content: [{ type: "text", text: `Error: Offset ${offset} is beyond the end of the file (${lines.length} lines).` }],
            isError: true,
          };
        }

        const endLine = limit !== undefined ? Math.min(startLine + limit, lines.length) : lines.length;
        const selectedLines = lines.slice(startLine, endLine);

        // 2. Patch-Ready Mode
        if (mode === "patch-ready") {
          const block = selectedLines.join("\n");
          return {
            content: [{ type: "text", text:
              `Lines ${startLine + 1}-${endLine} of ${path} (copy verbatim into searchText/oldText):\n\n` +
              "```\n" + block + "\n```\n"
            }],
          };
        }

        // 3. Default Line-Marker Mode
        const outputLines = selectedLines.map((line, index) => {
          const lineNum = startLine + index + 1;
          return `L${lineNum}: ${line}`;
        });

        const MAX_LINES = 1000;
        let finalContent = outputLines.join("\n");
        let truncationNote = "";

        if (selectedLines.length > MAX_LINES) {
          finalContent = outputLines.slice(0, MAX_LINES).join("\n");
          truncationNote = `\n\n[Truncated: showing first ${MAX_LINES} of ${selectedLines.length} lines.]`;
        }

        if (endLine < lines.length) {
          const remaining = lines.length - endLine;
          truncationNote += `\n\n[${remaining} more lines in file. Use offset=${endLine + 1} to continue.]`;
        }

        return { content: [{ type: "text", text: finalContent + truncationNote }] };
      } catch (e: any) {
        if (e.code === 'ENOENT') {
          return {
            content: [{ type: "text", text: `File not found: ${path}.` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Error reading file: ${e.message}` }], isError: true };
      }
    },
  });

  // --- Smart Replace (The Macro Tool) ---
  pi.registerTool({
    name: "smart_replace",
    label: "Smart Replace",
    description: "Atomic search-and-replace. Finds a UNIQUE block of text and replaces it. Refuses ambiguous matches. PREFERRED over apply_patch for single edits.",
    promptSnippet: "Atomic unique search-and-replace",
    promptGuidelines: [
      "PREFERRED for single-region edits. Simpler than apply_patch.",
      "searchText MUST be a unique verbatim copy from the file.",
      "Include 2-3 context lines above/below your target inside searchText to guarantee uniqueness.",
      "Tool refuses ambiguous matches — add more context and retry if it fails.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit" }),
      searchText: Type.String({ description: "Exact verbatim text to find. Must be unique in the file." }),
      replaceText: Type.String({ description: "Replacement text." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path, searchText, replaceText } = params;
      const fullPath = isAbsolute(path) ? path : join(ctx.cwd, path);

      try {
        const content = readFileSync(fullPath, "utf8");
        const matches = findAllIndices(content, searchText);

        if (matches.length === 0) {
          const closest = findClosestWindow(content, searchText);
          return {
            content: [{ type: "text", text:
              `searchText not found in ${path}.\n` +
              `Closest match (similarity ${closest.score.toFixed(2)}):\n\`\`\`\n${closest.text}\n\`\`\`\n` +
              `Re-read the file and copy the exact text.`
            }],
            isError: true,
          };
        }

        if (matches.length > 1) {
          const locs = matches.map(m => lineNumberOf(content, m)).join(", ");
          return {
            content: [{ type: "text", text:
              `searchText is not unique — found at lines: ${locs}.\n` +
              `Add more surrounding context lines to searchText so it matches exactly once.`
            }],
            isError: true,
          };
        }

        const updated = content.replace(searchText, replaceText);

        // Duplication guard
        if (searchText !== replaceText && countOccurrences(updated, searchText) >= countOccurrences(content, searchText)) {
          return {
            content: [{ type: "text", text:
              `Refusing to apply: searchText would still be present after replacement (possible duplicate). ` +
              `Add more context to ensure you're targeting the right instance.`
            }],
            isError: true,
          };
        }

        writeFileSync(fullPath, updated);
        return {
          content: [{ type: "text", text:
            `✓ Replaced unique block in ${path}.\n\n` +
            `--- Before ---\n\`\`\`\n${searchText}\n\`\`\`\n\n` +
            `--- After ---\n\`\`\`\n${replaceText}\n\`\`\``
          }],
        };
      } catch (e: any) {
        if (e.code === 'ENOENT') {
          return { content: [{ type: "text", text: `File not found: ${path}.` }], isError: true };
        }
        return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
      }
    },
  });

  // --- Legacy Edit Tool (Redirects to strict unique match) ---
  pi.registerTool({
    name: "edit",
    label: "Edit File",
    description: "Legacy tool. Use smart_replace instead. Edits a file by replacing a specific block of text.",
    promptSnippet: "Edit a file by replacing text",
    promptGuidelines: ["Legacy fallback. Prefer smart_replace."],
    parameters: Type.Object({
      path: Type.String(),
      oldText: Type.String(),
      newText: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return await pi.executeTool("smart_replace", { path: params.path, searchText: params.oldText, replaceText: params.newText }, ctx);
    },
  });

  // --- Apply Patch Tool ---
  pi.registerTool({
    name: "apply_patch",
    label: "Apply Patch",
    description: "Apply a unified diff patch to a file. Ideal for multi-region precise changes.",
    promptSnippet: "Apply a unified diff patch to a file.",
    promptGuidelines: [
      "Primary tool for multi-region changes.",
      "Include 3+ context lines around changes.",
      "Failures provide 'Expected' vs 'Actual' context for immediate correction.",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Path to the file. Extracted from patch headers if omitted." })),
      patch: Type.String({ description: "The unified diff patch string" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return performPatch(params, ctx);
    },
  });
}

// ==========================================
// CORE PATCH PIPELINE & UTILITIES
// ==========================================

async function performPatch(params: any, ctx: any) {
  let { path, patch } = params;
  
  if (!path) {
    const pathMatch = patch.match(/^---\s+([^\s\t\n\r]+)/m);
    if (pathMatch && pathMatch[1]) {
      path = pathMatch[1];
    } else {
      return {
        content: [{ type: "text", text: "Missing 'path' argument and could not extract it from the patch headers. Please provide the file path explicitly." }],
        isError: true,
      };
    }
  }
  
  const fullPath = isAbsolute(path) ? path : join(ctx.cwd, path);

  try {
    const originalContent = readFileSync(fullPath, "utf8");
    const hunks = parseUnifiedDiff(patch);

    if (hunks.length === 0) {
      return { content: [{ type: "text", text: "No valid hunks found in patch." }], isError: true };
    }

    // 1. Strict attempt
    let working = originalContent;
    const strictResult = diff.applyPatch(originalContent, patch);
    if (strictResult !== false) {
      working = strictResult;
      if (verifyResult(originalContent, working, hunks)) {
        writeFileSync(fullPath, working);
        return successResponse(path, originalContent, working, hunks, "strict");
      }
    }

    // 2. Anchor-based attempt (replaces lenient + resolveHunkPositions)
    const anchorResults = tryAnchorApply(originalContent, hunks);
    if (anchorResults.ok && verifyResult(originalContent, anchorResults.content, hunks)) {
      writeFileSync(fullPath, anchorResults.content);
      return successResponse(path, originalContent, anchorResults.content, hunks, "anchor");
    }

    // 3. Fail loudly with diagnostics
    const failureMsg = formatFailureResponse(path, hunks, anchorResults.diagnostics || []);
    return { content: [{ type: "text", text: failureMsg }], isError: true };

  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return { content: [{ type: "text", text: `File not found: ${path}.` }], isError: true };
    }
    return { content: [{ type: "text", text: "Error processing patch: " + e.message }], isError: true };
  }
}

function parseUnifiedDiff(patch: string) {
  const hunks: any[] = [];
  const lines = patch.split(/\r?\n/);
  let currentHunk: any = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@\s+-\d+(?:,(\d+))?\s+\+\d+(?:,(\d+))?\s+@@/);
      currentHunk = {
        oldStart: match ? parseInt(match[1] ?? "0", 10) : 0, // Weak hint only
        oldLines: [],
        newLines: [],
      };
      hunks.push(currentHunk);
    } else if (currentHunk) {
      const prefix = line[0];
      const body = line.slice(1);
      if (prefix === "-")      { currentHunk.oldLines.push(body); }
      else if (prefix === "+") { currentHunk.newLines.push(body); }
      else if (prefix === " ") { currentHunk.oldLines.push(body); currentHunk.newLines.push(body); }
      else if (line === "")    { currentHunk.oldLines.push(""); currentHunk.newLines.push(""); }
      // ignore "\" (no newline) markers
    }
  }
  return hunks;
}

function tryAnchorApply(content: string, hunks: any[]) {
  const diagnostics: any[] = [];
  let working = content;
  const placements: { hunk: any; start: number; end: number }[] = [];

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    const candidates = findAnchorCandidates(working, hunk.oldLines);

    if (candidates.length === 0) {
      diagnostics.push(noMatchDiagnostic(i, hunk, working));
      return { ok: false, diagnostics };
    }

    // REFUSE AMBIGUOUS MATCHES instead of guessing
    if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
      diagnostics.push(ambiguousDiagnostic(i, hunk, candidates, working));
      return { ok: false, diagnostics };
    }

    const best = candidates[0];
    placements.push({ hunk, start: best.start, end: best.end });
  }

  // Apply in reverse byte-offset order to keep offsets stable
  placements.sort((a, b) => b.start - a.start);
  for (const p of placements) {
    working = working.slice(0, p.start) + p.hunk.newLines.join("\n") + working.slice(p.end);
  }
  return { ok: true, content: working, diagnostics };
}

function findAnchorCandidates(content: string, oldLines: string[]) {
  const fileLines = content.split("\n");
  const candidates: { start: number; end: number; score: number; uniqueness: number }[] = [];

  if (oldLines.length === 0) return [];

  // Sliding window with weighted scoring
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    let exactLines = 0, trimLines = 0;
    for (let j = 0; j < oldLines.length; j++) {
      const fl = fileLines[i + j] ?? "";
      if (fl === oldLines[j]) exactLines++;
      else if (fl.trim() === oldLines[j].trim()) trimLines++;
    }
    const score = exactLines + trimLines * 0.9;
    if (score < oldLines.length * 0.9) continue; // 90% threshold

    // Byte offsets
    let start = 0;
    for (let k = 0; k < i; k++) start += fileLines[k].length + 1;
    let end = start;
    for (let k = 0; k < oldLines.length; k++) end += fileLines[i + k].length + 1;
    end -= 1; // remove trailing newline

    const uniqueness = computeUniqueness(fileLines, i, oldLines.length);
    candidates.push({ start, end, score, uniqueness });
  }

  // Sort: prefer high uniqueness, then high score
  candidates.sort((a, b) => b.uniqueness - a.uniqueness || b.score - a.score);
  return candidates;
}

function computeUniqueness(fileLines: string[], start: number, len: number): number {
  let minRarity = Infinity;
  for (let j = 0; j < len; j++) {
    const line = fileLines[start + j];
    if (!line.trim()) continue;
    let count = 0;
    for (const fl of fileLines) if (fl === line) count++;
    const rarity = count > 0 ? 1 / count : 0; 
    minRarity = Math.min(minRarity, rarity);
  }
  return minRarity === Infinity ? 0 : minRarity;
}

function verifyResult(original: string, modified: string, hunks: any[]): boolean {
  for (const hunk of hunks) {
    if (hunk.newLines.length === 0) continue;
    const newText = hunk.newLines.join("\n");
    const oldText = hunk.oldLines.join("\n");

    // (a) The new text must appear at least once in the modified file
    if (!modified.includes(newText)) return false;

    // (b) DUPLICATION GUARD: if oldText !== newText, oldText must NOT
    //     still be present *unless* it had multiple occurrences originally
    if (oldText !== newText) {
      const beforeCount = countOccurrences(original, oldText);
      const afterCount  = countOccurrences(modified, oldText);
      if (afterCount >= beforeCount && beforeCount > 0) return false;
    }

    // (c) If newText appears MORE times than expected, suspect duplication
    if (oldText === newText) {
      const expectedNewCount = countOccurrences(modified, newText);
      const origNewCount = countOccurrences(original, newText);
      if (expectedNewCount !== origNewCount + 1) return false;
    }
  }
  return true;
}

// ==========================================
// FORMATTERS & DIAGNOSTICS
// ==========================================

function successResponse(path: string, original: string, modified: string, hunks: any[], method: string) {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");
  
  // Simple diff to find the first changed region
  let changeStart = -1;
  for (let i = 0; i < Math.max(origLines.length, modLines.length); i++) {
    if (origLines[i] !== modLines[i]) {
      changeStart = i;
      break;
    }
  }

  let context = "No structural changes detected.";
  if (changeStart !== -1) {
    const start = Math.max(0, changeStart - 2);
    const end = Math.min(modLines.length, changeStart + 8);
    context = modLines.slice(start, end)
      .map((l, k) => `L${start + k + 1}: ${l}`)
      .join("\n");
  }

  return {
    content: [{ type: "text", text:
      `✓ Patch applied to ${path} (${method}). Applied ${hunks.length} hunk(s).\n\n` +
      `--- Modified region (verification) ---\n\`\`\`\n${context}\n\`\`\`\n`
    }],
  };
}

function formatFailureResponse(path: string, hunks: any[], diagnostics: any[]) {
  let msg = `Failed to apply patch to ${path}. The file was NOT modified.\n\n`;
  for (const d of diagnostics) {
    if (d.type === "no_match") {
      msg += `Hunk #${d.hunkIndex + 1} could not be matched unambiguously.\n\n` +
             `--- Expected (from your patch) ---\n\`\`\`\n${d.expected}\n\`\`\`\n\n` +
             `--- Closest region in file (line markers) ---\n\`\`\`\n${d.actual}\n\`\`\`\n\n` +
             `ACTION: Re-read the file around the target area, then regenerate the patch using the EXACT text shown.\n\n---\n\n`;
    } else if (d.type === "ambiguous") {
      msg += `Hunk #${d.hunkIndex + 1} is ambiguous (matched multiple locations).\n\n` +
             `Expected:\n\`\`\`\n${d.expected}\n\`\`\`\n\n` +
             `Found matches near lines: ${d.matchLines.join(", ")}\n\n` +
             `ACTION: Add more surrounding context lines to this hunk so it matches exactly once.\n\n---\n\n`;
    }
  }
  return msg;
}

function noMatchDiagnostic(idx: number, hunk: any, content: string) {
  const fileLines = content.split("\n");
  let best = { score: 0, start: 0 };
  for (let i = 0; i <= fileLines.length - hunk.oldLines.length; i++) {
    let s = 0;
    for (let j = 0; j < hunk.oldLines.length; j++) {
      if ((fileLines[i + j] ?? "").trim() === hunk.oldLines[j].trim()) s++;
    }
    if (s > best.score) best = { score: s, start: i };
  }
  const ctxStart = Math.max(0, best.start - 2);
  const ctxEnd = Math.min(fileLines.length, best.start + hunk.oldLines.length + 2);
  const ctx = fileLines.slice(ctxStart, ctxEnd)
    .map((l, k) => `L${ctxStart + k + 1}: ${l}`)
    .join("\n");

  return {
    type: "no_match",
    hunkIndex: idx,
    expected: hunk.oldLines.join("\n"),
    actual: ctx
  };
}

function ambiguousDiagnostic(idx: number, hunk: any, candidates: any[], content: string) {
  const matchLines = candidates.slice(0, 5).map(c => lineNumberOf(content, c.start));
  return {
    type: "ambiguous",
    hunkIndex: idx,
    expected: hunk.oldLines.join("\n"),
    matchLines
  };
}

// ==========================================
// MISC STRING UTILS
// ==========================================

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

function findAllIndices(haystack: string, needle: string): number[] {
  const indices: number[] = [];
  if (!needle) return indices;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { indices.push(idx); idx += needle.length; }
  return indices;
}

function lineNumberOf(content: string, offset: number): number {
  return content.substring(0, offset).split("\n").length;
}

function findClosestWindow(content: string, searchText: string): { score: number, text: string } {
  // Simple sliding window line similarity for diagnostics
  const fileLines = content.split("\n");
  const searchLines = searchText.split("\n");
  let best = { score: 0, text: "" };

  if (searchLines.length === 0) return best;

  for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
    let s = 0;
    for (let j = 0; j < searchLines.length; j++) {
      if ((fileLines[i + j] ?? "").trim() === searchLines[j].trim()) s++;
    }
    if (s > best.score) {
      const score = s / searchLines.length;
      const start = Math.max(0, i - 2);
      const end = Math.min(fileLines.length, i + searchLines.length + 2);
      const text = fileLines.slice(start, end).map((l, k) => `L${start + k + 1}: ${l}`).join("\n");
      best = { score, text };
    }
  }
  return best;
}
