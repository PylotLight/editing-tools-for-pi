import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as diff from "diff";
import { readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export default function (pi: ExtensionAPI) {
  // --- Reinforce Usage in System Prompt ---
  pi.on("before_agent_start", async (event, ctx) => {
    return {
      systemPrompt: event.systemPrompt + 
        "\n\nIMPORTANT: The only tool allowed for modifying files is 'apply_patch'. " +
        "Do not attempt to use 'edit' or other modification tools. " +
        "Always provide a valid unified diff patch.",
    };
  });

  // --- Custom Read Tool ---
  pi.registerTool({
    name: "read",
    label: "read",
    description: "Read the contents of a file. Supports text files. Output is truncated for large files. Use offset/limit for large files.",
    promptSnippet: "Read file contents",
    promptGuidelines: [
      "Use the provided line markers (L#: ) to identify exact ranges for apply_patch.",
      "For large files, use offset and limit to isolate the target area.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path, offset, limit } = params;
      const fullPath = isAbsolute(path) ? path : join(ctx.cwd, path);

      try {
        const content = readFileSync(fullPath, "utf8");
        const lines = content.split("\n");
        
        const startLine = offset ? Math.max(0, offset - 1) : 0;
        if (startLine >= lines.length) {
          return {
            content: [{ type: "text", text: `Error: Offset ${offset} is beyond the end of the file (${lines.length} lines).` }],
            isError: true,
          };
        }

        const endLine = limit !== undefined ? Math.min(startLine + limit, lines.length) : lines.length;
        const selectedLines = lines.slice(startLine, endLine);
        
        // FEATURE: Line-Marker Mode
        // We prefix every line with its actual line number for token efficiency (L#: content)
        const outputLines = selectedLines.map((line, index) => {
          const lineNum = startLine + index + 1;
          return `L${lineNum}: ${line}`;
        });

        const outputText = outputLines.join("\n");

        // basic truncation for now to mimic built-in behavior
        const MAX_LINES = 1000; 
        let finalContent = outputText;
        let truncationNote = "";

        if (selectedLines.length > MAX_LINES) {
          finalContent = outputLines.slice(0, MAX_LINES).join("\n");
          truncationNote = `\n\n[Truncated: showing first ${MAX_LINES} of ${selectedLines.length} lines.]`;
        }

        // Add a footer if the file continues
        if (endLine < lines.length) {
          const remaining = lines.length - endLine;
          const nextOffset = endLine + 1;
          truncationNote += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
        }

        return {
          content: [{ type: "text", text: finalContent + truncationNote }],
        };
      } catch (e: any) {
        if (e.code === 'ENOENT') {
          return {
            content: [{ type: "text", text: `File not found: ${path}. Please ensure the path is correct relative to the project root (${ctx.cwd}).` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Error reading file: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  // --- Edit Tool (Override) ---
  pi.registerTool({
    name: "edit",
    label: "Edit File",
    description: "Edit a file by replacing a specific block of text. This is a legacy tool; 'apply_patch' is preferred for higher precision.",
    promptSnippet: "Edit a file by replacing text",
    promptGuidelines: [
      "Legacy fallback: use for simple, unique string replacements.",
      "Prefer apply_patch for all structural or multi-line changes.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit" }),
      oldText: Type.String({ description: "The exact text to be replaced" }),
      newText: Type.String({ description: "The text to replace it with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path, oldText, newText } = params;
      const patch = `--- ${path}\n+++ ${path}\n@@ -1,1 +1,1 @@\n-${oldText}\n+${newText}\n`;
      
      const result = await performPatch({ path, patch }, ctx);
      return result;
    },
  });

  // --- Apply Patch Tool ---
  pi.registerTool({
    name: "apply_patch",
    label: "Apply Patch",
    description: "Apply a unified diff patch to a file. Ideal for large files or precise changes.",
    promptSnippet: "Apply a unified diff patch to a file. Requires 'path' and 'patch' arguments.",
    promptGuidelines: [
      "Primary mutation tool. Use for all modifications.",
      "Provide a standard unified diff (diff -u).",
      "Include 3+ context lines around changes to disambiguate repetitive code.",
      "Combine with read's line markers for high-precision targeting.",
      "Failures provide 'Expected' vs 'Actual' context for immediate correction.",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Path to the file. If omitted, the tool will attempt to extract it from the patch headers." })),
      patch: Type.String({ description: "The unified diff patch string" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return performPatch(params, ctx);
    },
  });
}

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
    let content = readFileSync(fullPath, "utf8");

    const result = diff.applyPatch(content, patch);
    if (result !== false) {
      writeFileSync(fullPath, result);
      return { content: [{ type: "text", text: "Successfully applied patch to " + path }] };
    }

    const hunks = parseUnifiedDiff(patch);
    const matchesPerHunk: any[][] = [];

    for (const hunk of hunks) {
      const matches = findAllMatches(content, hunk.oldLines);
      matchesPerHunk.push(matches);
    }

    const resolvedPositions = resolveHunkPositions(matchesPerHunk, hunks);

    if (resolvedPositions) {
      let currentContent = content;
      const appliedReports: string[] = [];
      
      const sortedHunks = resolvedPositions
        .map((pos, idx) => ({ pos, hunk: hunks[idx] }))
        .sort((a, b) => b.pos.start - a.pos.start);

      for (const { pos, hunk } of sortedHunks) {
        const before = currentContent.slice(0, pos.start);
        const after = currentContent.slice(pos.end);
        currentContent = before + hunk.newLines.join("\n") + after;
        if (pos.method === "lenient") {
          appliedReports.push(`Hunk #${hunks.indexOf(hunk) + 1} applied leniently.`);
        }
      }

      writeFileSync(fullPath, currentContent);
      let msg = "Successfully applied patch to " + path + " using anchor validation.";
      if (appliedReports.length > 0) msg += "\n" + appliedReports.join("\n");
      return { content: [{ type: "text", text: msg }] };
    }

    let currentContent = content;
    const failures: string[] = [];
    const fuzzySuccesses: string[] = [];

    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      const fuzzyMatch = findFuzzyMatch(currentContent, hunk.oldLines);

      if (fuzzyMatch) {
        const before = currentContent.slice(0, fuzzyMatch.start);
        const after = currentContent.slice(fuzzyMatch.end);
        currentContent = before + hunk.newLines.join("\n") + after;
        fuzzySuccesses.push(`Hunk #${i + 1} applied using fuzzy matching.`);
      } else {
        const expectedStart = hunk.oldStart;
        const lines = content.split("\n");
        const contextLines = [];
        const start = Math.max(0, expectedStart - 3);
        const end = Math.min(lines.length, expectedStart + hunk.oldLines.length + 3);
        for (let j = start; j < end; j++) {
          const prefix = (j >= expectedStart - 1 && j < expectedStart - 1 + hunk.oldLines.length) ? ">>" : "  ";
          contextLines.push(`${prefix}${j + 1}: ${lines[j]}`);
        }
        failures.push(`Hunk #${i + 1} failed to apply.\nExpected:\n\`\`\`\n${hunk.oldLines.join("\n")}\n\`\`\`\nActual around line ${expectedStart}:\n\`\`\`\n${contextLines.join("\n")}\n\`\`\``);
      }
    }

    if (failures.length > 0) {
      return {
        content: [{ type: "text", text: "Failed to apply patch. Detailed errors:\n\n" + failures.join("\n\n---\n\n") }],
        isError: true,
      };
    }

    writeFileSync(fullPath, currentContent);
    return {
      content: [{ type: "text", text: "Successfully applied patch using fuzzy recovery.\n" + fuzzySuccesses.join("\n") }],
    };

  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return {
        content: [{ type: "text", text: `File not found: ${path}. Please ensure the path is correct relative to the project root (${ctx.cwd}).` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: "Error processing patch: " + e.message }],
      isError: true,
    };
  }
}

function parseUnifiedDiff(patch: string) {
  const hunks: any[] = [];
  const lines = patch.split("\n");
  let currentHunk: any = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
      if (match) {
        currentHunk = { oldStart: parseInt(match[1], 10), oldLines: [], newLines: [] };
        hunks.push(currentHunk);
      }
    } else if (currentHunk) {
      if (line.startsWith("-")) currentHunk.oldLines.push(line.slice(1));
      else if (line.startsWith("+")) currentHunk.newLines.push(line.slice(1));
      else if (line.startsWith(" ")) {
        currentHunk.oldLines.push(line.slice(1));
        currentHunk.newLines.push(line.slice(1));
      }
    }
  }
  return hunks;
}

function findAllMatches(content: string, lines: string[]) {
  const matches: any[] = [];
  const exactStr = lines.join("\n");
  let pos = content.indexOf(exactStr);
  while (pos !== -1) {
    matches.push({ start: pos, end: pos + exactStr.length, method: "exact" });
    pos = content.indexOf(exactStr, pos + 1);
  }

  const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
  const regexParts = lines.map(line => {
    const n = normalize(line);
    return n ? n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") : "\\s*";
  });
  const regex = new RegExp("^\\s*" + regexParts.join("\\s*\\n\\s*"), "gm");
  let match;
  while ((match = regex.exec(content)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, method: "lenient" });
  }
  return matches;
}

function resolveHunkPositions(matchesPerHunk: any[][], hunks: any[]) {
  if (matchesPerHunk.length === 0) return null;
  if (matchesPerHunk.length === 1) return matchesPerHunk[0].length > 0 ? [matchesPerHunk[0][0]] : null;

  const combinations: any[] = [];
  function backtrack(hunkIdx: number, currentSet: any[]) {
    if (hunkIdx === matchesPerHunk.length) {
      combinations.push([...currentSet]);
      return;
    }
    for (const match of matchesPerHunk[hunkIdx]) {
      if (currentSet.length > 0) {
        const prev = currentSet[currentSet.length - 1];
        if (match.start < prev.end) continue; 
      }
      backtrack(hunkIdx + 1, [...currentSet, match]);
    }
  }
  backtrack(0, []);
  if (combinations.length === 0) return null;
  if (combinations.length === 1) return combinations[0];

  let bestSet = combinations[0];
  let minDiff = Infinity;
  for (const set of combinations) {
    let totalDiff = 0;
    for (let i = 0; i < set.length; i++) {
      totalDiff += Math.abs(hunks[i].oldStart - set[i].start);
    }
    if (totalDiff < minDiff) {
      minDiff = totalDiff;
      bestSet = set;
    }
  }
  return bestSet;
}

function findFuzzyMatch(content: string, lines: string[]) {
  if (lines.length === 0) return null;
  const fileLines = content.split("\n");
  const targetLen = lines.length;
  let bestStart = -1;
  let maxScore = 0;
  for (let i = 0; i <= fileLines.length - targetLen; i++) {
    let score = 0;
    for (let j = 0; j < targetLen; j++) {
      if (fileLines[i + j] === lines[j]) score++;
      else if (fileLines[i + j]?.trim() === lines[j]?.trim()) score += 0.8;
    }
    if (score > maxScore) {
      maxScore = score;
      bestStart = i;
    }
  }
  if (maxScore >= targetLen * 0.8) {
    let byteOffset = 0;
    for (let i = 0; i < bestStart; i++) byteOffset += fileLines[i].length + 1;
    let endByte = byteOffset;
    for (let j = 0; j < targetLen; j++) endByte += fileLines[bestStart + j].length + 1;
    return { start: byteOffset, end: endByte - 1 };
  }
  return null;
}
