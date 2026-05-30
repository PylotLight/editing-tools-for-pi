# Editing Suite Roadmap

This document tracks proposed enhancements for the `editing-suite` extension to further improve the reliability and efficiency of the "Observation and Mutation" loop.

## 🎯 Core Objective
To reduce the cognitive load on the agent and minimize the number of tool-call turns required to perform a high-precision modification.

---

## 🚀 Proposed Improvements

### 1. Post-Mutation Verification (Zero-Turn Verify)
**Status**: Proposed
**Value**: Speed $\rightarrow$ Eliminates one turn per mutation.
- **Description**: Modify `apply_patch` to return the modified region (with line markers) in the success response.
- **Workflow**: Instead of `Apply Patch` $\rightarrow$ `Read to Verify`, the agent sees the "Before" and "After" in a single tool response.

### 2. Semantic Observation (Find-to-Read Bridge)
**Status**: Proposed
**Value**: Speed $\rightarrow$ Replaces "blind scrolling" with "surgical targeting."
- **Description**: Implement a `read_semantic` tool or a `search` parameter in `read` that accepts a regex or keyword and returns a window of lines centered around the match.
- **Workflow**: Agent searches for a function name $\rightarrow$ Tool returns the exact lines $\rightarrow$ Agent constructs patch.

### 3. Patch-Ready Context (Copy-Paste Optimizer)
**Status**: Proposed
**Value**: Precision $\rightarrow$ Eliminates "Expected vs Actual" errors.
- **Description**: Add a `mode: "patch-ready"` argument to the `read` tool. When enabled, the tool provides a verbatim, quoted block of the selected area.
- **Workflow**: Agent reads file in `patch-ready` mode $\rightarrow$ Agent copy-pastes the provided block into the `oldText` section of the patch.

### 4. Atomic Search-and-Replace (The Macro Tool)
**Status**: Proposed
**Value**: Speed $\rightarrow$ Collapses the "Read-Analyze-Patch" loop into one action.
- **Description**: Create a `smart_replace` tool that takes `searchPattern` and `replacementText`. The tool internally reads the file, finds the match, generates a high-precision patch, and applies it.
- **Workflow**: Agent provides a "Key" (search string) and "Value" (replacement) $\rightarrow$ Tool handles the mutation atomically.

---

## 🛠️ Current Architecture Summary
- **Observation**: `read` (Line-Marker Mode)
- **Mutation**: `apply_patch` (Anchor-Based $\rightarrow$ Lenient $\rightarrow$ Fuzzy)
- **Compatibility**: `edit` (Redirected to `apply_patch` pipeline)
