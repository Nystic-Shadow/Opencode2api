/**
 * Authentic OpenCode CLI 2.x Core Tools
 * Exact schemas required byte-for-byte to satisfy upstream gate checks.
 */

const CORE_TOOLS = [
  {
    type: "function",
    function: {
      name: "shell",
      description: "Execute a shell command and return its output. Commands run on Windows using powershell. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string to execute" },
          workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory." },
          timeout: { type: "integer", description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
          background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." }
        },
        required: ["command"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to edit" },
          oldString: { type: "string", description: "Exact text to find and replace" },
          newString: { type: "string", description: "Text to replace oldString with (must differ from oldString)" },
          replaceAll: { type: "boolean", description: "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false." }
        },
        required: ["path", "oldString", "newString"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Search file paths using a glob pattern (examples: \"**/*.ts\", \"src/**/*.tsx\").",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to match files against" },
          path: { type: "string", description: "Directory to search. Defaults to the current working directory." },
          hidden: { type: "boolean", description: "Include hidden files and directories (default: false)." },
          limit: { type: "integer", description: "Maximum number of matching files to return (default: 100)", exclusiveMinimum: 0 }
        },
        required: ["pattern"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression or literal text to match in file contents.", minLength: 1 },
          path: { type: "string", description: "File or directory to search. Defaults to the current working directory." },
          include: { type: "string", description: "Glob pattern to filter files (for example, \"*.js\" or \"*.{ts,tsx}\")" },
          literal: { type: "boolean", description: "Treat `pattern` as exact text instead of a regular expression (default: false)." },
          caseSensitive: { type: "boolean", description: "Use case-sensitive matching (default: true)." },
          limit: { type: "integer", description: "Maximum number of matching lines to return (default: 100)", exclusiveMinimum: 0 }
        },
        required: ["pattern"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory to read" },
          offset: { type: "integer", description: "The line or directory entry to start reading from (1-based)", minimum: 0 },
          limit: { type: "integer", description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)", minimum: 0 }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  }
];

const GATE_READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Internal helper. Never call this tool.",
    parameters: { type: "object", properties: {} }
  }
};

const CORE_TOOL_NAMES = new Set(['shell', 'edit', 'glob', 'grep', 'read']);

/**
 * Merge client tools with OpenCode CLI gate requirements.
 * When client sends no tools (plain chat), attaches all 5 official CLI core tools
 * with tool_choice: "none" so upstream gate is satisfied while the model answers
 * in plain text without hallucinations.
 *
 * When client sends tools, preserves client definitions and appends missing core tools.
 * Tracks clientToolNames and injectedToolNames to prevent injected tool leakage (H2).
 */
function mergeTools(clientTools, clientToolChoice) {
  const hasUserTools = Array.isArray(clientTools) && clientTools.length > 0;
  if (!hasUserTools) {
    return {
      tools: CORE_TOOLS,
      toolChoice: "none",
      clientToolNames: new Set(),
      injectedToolNames: new Set(CORE_TOOL_NAMES)
    };
  }

  const clientToolNames = new Set(clientTools.map(t => t.function?.name || t.name).filter(Boolean));
  // Client definitions ALWAYS take strict precedence over default core tools (H2)
  const merged = [...clientTools];
  const injectedToolNames = new Set();

  for (const core of CORE_TOOLS) {
    const coreName = core.function?.name || core.name;
    if (!clientToolNames.has(coreName)) {
      merged.push(core);
      injectedToolNames.add(coreName);
    }
  }

  return {
    tools: merged,
    toolChoice: clientToolChoice,
    clientToolNames,
    injectedToolNames
  };
}

module.exports = {
  CORE_TOOLS,
  CORE_TOOL_NAMES,
  GATE_READ_TOOL,
  mergeTools
};
