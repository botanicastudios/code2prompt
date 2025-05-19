const fs = require("fs-extra");
const fs_ = require("fs").promises;
const path = require("path");
const handlebars = require("handlebars");
const { glob } = require("glob");
const codeBlocks = require("code-blocks");
const { z } = require("zod");
const { get_encoding, encoding_for_model } = require("tiktoken");
const gpt_tokenizer = encoding_for_model("gpt-4");
const diffLib = require("diff");

class Code2Prompt {
  constructor(options) {
    this.options = options;
    this.extensions = options.extensions ? [].concat(options.extensions) : [];
    this.ignorePatterns = options.ignore ? [].concat(options.ignore) : [];
    // if specified, enforces a return schema (use zod)
    this.schema = options.schema ? options.schema : null;
    this.code_blocks = {};
    this.QArecordings = {};
    this.last_QAsession = null;
    this.full_source_tree = false; //false=source_tree equals to files shown on prompt, true=source_tree contains all files ignoring exclusions
    this.binary = false; // false=skips binary files
    this.custom_viewers = options.custom_viewers ? options.custom_viewers : {}; // registered custom file viewers (ex. docx, xlsx, pdf, etc)
    // if OPENAI_KEY is specified, it will be used to call the OpenAI API
    this.OPENAI_KEY = options.OPENAI_KEY ? options.OPENAI_KEY : null;
    this.GROQ_KEY = options.GROQ_KEY ? options.GROQ_KEY : null;
    this.ANTHROPIC_KEY = options.ANTHROPIC_KEY ? options.ANTHROPIC_KEY : null;
    this.maxBytesPerFile = options.maxBytesPerFile
      ? options.maxBytesPerFile
      : 8192;
    this.debugger = options.debugger === true;

    // Ensure diff is properly initialized as a boolean
    this.diff = options.diff === true;

    // Ensure diffPath is properly initialized as a string or null
    this.diffPath =
      typeof options.diffPath === "string" ? options.diffPath : null;

    // Option to show or hide paths
    this.showProjectPath = options.showProjectPath !== false; // true by default

    // Debug options to help troubleshoot
    if (this.debugger) {
      this.debug(
        `Constructor options: diff=${this.diff}, diffPath=${this.diffPath}, showProjectPath=${this.showProjectPath}`
      );
    }

    this.modelPreferences = ["OPENAI", "ANTHROPIC", "GROQ"]; // New property for model preferences
    this.templateDir = this.options.template
      ? path.dirname(this.options.template)
      : process.cwd();
    this.loadAndRegisterTemplate(this.options.template);
  }

  debug(message) {
    if (this.debugger) console.log("[code2prompt]: " + message);
  }

  setModelPreferences(preferences) {
    this.modelPreferences = preferences;
    this.debug("Model preferences updated: " + JSON.stringify(preferences));
  }

  setLLMAPI(provider, value) {
    if (provider === "ANTHROPIC") {
      this.ANTHROPIC_KEY = value;
      return true;
    } else if (provider === "GROQ") {
      this.GROQ_KEY = value;
      return true;
    } else if (provider === "OPENAI") {
      this.OPENAI_KEY = value;
      return true;
    }
    return false;
  }

  registerFileViewer(ext, method) {
    this.custom_viewers[ext] = method;
    this.debug(`Viewer registered for ${ext}`);
  }

  recordQA(session = "") {
    this.last_QAsession = session;
    if (!this.QArecordings[session]) this.QArecordings[session] = [];
  }

  getQArecordings(session) {
    return this.QArecordings[session];
  }

  async extractCodeBlocks(text) {
    // extract code blocks from a given text (maybe from an LLM response)
    return (await codeBlocks.fromString(text)).map((i) => ({
      lang: i.lang,
      code: i.value,
    }));
  }

  async loadAndRegisterTemplate(templatePath) {
    let templateContent;
    this.code_blocks = [];
    if (templatePath) {
      templateContent = await fs.readFile(templatePath, "utf-8");
    } else {
      // Fallback to a default template if not provided
      templateContent = `{{#if showProjectPath}}
Project Path: {{absolute_code_path}}
{{#if diffPath}}
Diff Path: {{diffPath}}
{{/if}}

---

{{/if}}
      
Source Tree:

\`\`\`
{{source_tree}}
\`\`\`

---

{{#each files}}
{{#if code}}
{{{code}}}

---

{{/if}}
{{/each}}
`;
    }
    this.template = handlebars.compile(templateContent);
    // extract return schema from template
    if (this.template) {
      //const schema = codedown(templateContent,"schema");
      const code_blocks = await codeBlocks.fromString(templateContent);
      if (code_blocks.length > 0) {
        // extract 'lang' defined code blocks into 'this.code_blocks' and remove them from template
        // if lang is 'schema' assign to schema
        for (let i = 0; i < code_blocks.length; i++) {
          const block = code_blocks[i];
          // remove code block statement from template
          if (block.lang) {
            const original = "```" + block.lang + "\n" + block.value + "\n```";
            templateContent = templateContent.replace(original, "");
          }
          //
          if (block.lang === "schema" || block.lang === "json:schema") {
            // build zod schema from template schema
            const json_parsed = JSON.parse(block.value);
            const zod_schema = z.object({
              schema: this.createZodSchema(json_parsed),
            });
            if (!this.schema) this.schema = zod_schema;
          } else if (block.lang) {
            this.code_blocks.push({ lang: block.lang, code: block.value });
          }
        }
        this.template = handlebars.compile(templateContent);
        //console.log('code_blocks:',this.code_blocks);
      }
    }
  }

  adjustIgnorePatterns(ignorePatterns, extensionsNotIgnored) {
    // Ensure all extensions in extensionsNotIgnored start with a dot
    const normalizedExtensions = extensionsNotIgnored.map((ext) =>
      ext.startsWith(".") ? ext : `.${ext}`
    );

    return ignorePatterns.reduce((acc, pattern) => {
      // Check if the pattern directly relates to a file extension
      if (pattern.startsWith("**/*.")) {
        // Extract the extension from the pattern
        const extPattern = path.extname(pattern);
        // Check if this extension is in the normalized list of extensions not to ignore
        if (normalizedExtensions.includes(extPattern)) {
          // If it is, do not add this pattern to the final list of ignore patterns
          return acc;
        }
      }
      // Otherwise, add the pattern to the final list
      acc.push(pattern);
      return acc;
    }, []);
  }

  async readContent(filePath, maxBytes) {
    if (maxBytes !== null) {
      const fileHandle = await fs_.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await fileHandle.read(buffer, 0, maxBytes, 0);
        return buffer.toString("utf-8", 0, bytesRead);
      } finally {
        await fileHandle?.close();
      }
    } else {
      return fs.readFile(filePath, "utf-8");
    }
  }

  async traverseDirectory(dirPath, maxBytes = this.maxBytesPerFile) {
    const absolutePath = path.resolve(dirPath);
    const ignorePatternsWithoutViewers = this.adjustIgnorePatterns(
      this.ignorePatterns,
      Object.keys(this.custom_viewers)
    );
    const files = await glob("**", {
      cwd: absolutePath,
      nodir: true,
      absolute: true,
      ignore: ignorePatternsWithoutViewers,
      dot: true,
    });
    let tree = {};
    let filesArray = [];

    // Debug diff settings
    this.debug(
      `Diff settings - diff: ${this.diff}, diffPath: ${this.diffPath}`
    );

    // If diff mode is enabled and diffPath is provided
    if (this.diff && this.diffPath) {
      const diffAbsolutePath = path.resolve(this.diffPath);
      this.debug(
        `Diff mode enabled. Comparing ${absolutePath} (before) with ${diffAbsolutePath} (current)`
      );

      // Find all files in both directories for comparison
      const diffFiles = await glob("**", {
        cwd: diffAbsolutePath,
        nodir: true,
        absolute: true,
        ignore: ignorePatternsWithoutViewers,
        dot: true,
      });

      // Create maps for easier lookup
      // currentFilesMap now represents the "before" state
      const currentFilesMap = files.reduce((acc, file) => {
        acc[path.relative(absolutePath, file)] = file;
        return acc;
      }, {});

      // diffFilesMap now represents the "current" state
      const diffFilesMap = diffFiles.reduce((acc, file) => {
        acc[path.relative(diffAbsolutePath, file)] = file;
        return acc;
      }, {});

      // Get all unique relative paths
      const allRelativePaths = [
        ...new Set([
          ...Object.keys(currentFilesMap),
          ...Object.keys(diffFilesMap),
        ]),
      ];

      // Sort paths to ensure consistent order
      allRelativePaths.sort();

      // Create a separate tree just for the current state (diffPath)
      let currentTree = {};

      // Build the current state tree first (only files in diffPath)
      Object.keys(diffFilesMap).forEach((relativePath) => {
        const parts = relativePath.split(path.sep);
        let current = currentTree;

        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i];
          current[part] = current[part] || {};
          current = current[part];
        }

        const fileName = parts[parts.length - 1];
        current[fileName] = relativePath;
      });

      // Use the current state tree for the source tree display
      tree = currentTree;

      // Process each file and generate diffs
      for (const relativePath of allRelativePaths) {
        const extension = path.extname(relativePath).toLowerCase();

        // Skip if not in the list of extensions (if extensions list is provided)
        if (
          this.extensions.length > 0 &&
          !this.extensions.includes(extension.substring(1))
        ) {
          continue;
        }

        // Handle file content and diff generation
        const currentFile = currentFilesMap[relativePath];
        const diffFile = diffFilesMap[relativePath];

        let diffContent = "";

        if (currentFile && diffFile) {
          // Both files exist - generate diff
          let beforeContent, currentContent;

          if (extension in this.custom_viewers) {
            beforeContent = await this.custom_viewers[extension](currentFile);
            currentContent = await this.custom_viewers[extension](diffFile);
          } else {
            beforeContent = await this.readContent(currentFile, maxBytes);
            currentContent = await this.readContent(diffFile, maxBytes);
          }

          // Skip files with no changes
          if (beforeContent === currentContent) {
            continue;
          }

          // Generate a unified diff format (patch)
          const patch = diffLib.createPatch(
            relativePath,
            beforeContent,
            currentContent,
            `a/${relativePath}`,
            `b/${relativePath}`,
            { context: 3 }
          );

          // Extract just the diff part (excluding the header lines)
          const diffLines = patch.split("\n");
          const diffContent = diffLines.slice(2).join("\n");

          // Format with custom header and code block - without extra spacing
          const formattedDiff = `# file: ${relativePath}  |  change: modified\n\n\`\`\`diff\n${diffContent}\n\`\`\``;

          filesArray.push({
            path: relativePath,
            code: formattedDiff,
            status: "modified",
          });
        } else if (currentFile && !diffFile) {
          // File deleted in diff (was in before, not in current)
          let content;
          if (extension in this.custom_viewers) {
            content = await this.custom_viewers[extension](currentFile);
          } else {
            content = await this.readContent(currentFile, maxBytes);
          }

          // Format as a simplified deleted file notice without full content
          const lineCount = content.split("\n").length;
          const patch = `# file: ${relativePath}  |  change: deleted\n\n\`\`\`diff\n@@ -1,${lineCount} +0,0 @@\n-// contents omitted …\n\`\`\``;

          filesArray.push({
            path: relativePath,
            code: patch,
            status: "deleted",
          });
        } else if (!currentFile && diffFile) {
          // File added in current (wasn't in before, is in current)
          let content;
          if (extension in this.custom_viewers) {
            content = await this.custom_viewers[extension](diffFile);
          } else {
            content = await this.readContent(diffFile, maxBytes);
          }

          // Format as a simplified new file notice with full content
          const lines = content.split("\n");
          const patch = `# file: ${relativePath}  |  change: new\n\n\`\`\`diff\n@@ -0,0 +1,${
            lines.length
          } @@\n+${content.replace(/\n/g, "\n+")}\n\`\`\``;

          filesArray.push({
            path: relativePath,
            code: patch,
            status: "added",
          });
        }
      }
    } else {
      // Original non-diff mode behavior
      for (let file of files) {
        const extension = path.extname(file).toLowerCase();
        this.debug(`Processing file: ${file}, extension: ${extension}`);
        if (
          this.extensions.length === 0 ||
          this.extensions.includes(extension.substring(1))
        ) {
          const relativePath = path.relative(absolutePath, file);
          const parts = relativePath.split(path.sep);
          let current = tree;

          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === parts.length - 1) {
              current[part] = relativePath;
              let content = "";
              if (extension in this.custom_viewers) {
                this.debug(
                  `Found custom viewer for ${extension}, file: ${file}`
                );
                content = await this.custom_viewers[extension](file);
              } else {
                this.debug(
                  `No custom viewer for ${extension}, reading content directly`
                );
                content = await this.readContent(file, maxBytes);
              }
              // Add header for files in non-diff mode to match the diff mode format
              content = `# file: ${relativePath}\n\n\`\`\`${
                extension.substring(1) || ""
              }\n${content}\n\`\`\``;
              filesArray.push({ path: relativePath, code: content });
            } else {
              current[part] = current[part] || {};
              current = current[part];
            }
          }
        }
      }
    }

    // Convert the tree object to a string representation similar to the source tree in the template
    const sourceTree = this.stringifyTree(tree);
    return { absolutePath, sourceTree, filesArray };
  }

  stringifyTree(tree, prefix = "") {
    let result = "";
    Object.keys(tree).forEach((key, index, array) => {
      const isLast = index === array.length - 1;
      result += `${prefix}${isLast ? "└── " : "├── "}${key}\n`;
      if (typeof tree[key] === "object") {
        result += this.stringifyTree(
          tree[key],
          `${prefix}${isLast ? "    " : "|   "}`
        );
      }
    });
    return result;
  }

  stringifyTreeFromPaths(paths) {
    const tree = {};

    // Build the tree
    paths.forEach((filePath) => {
      const parts = filePath.split(path.sep);
      let current = tree;
      parts.forEach((part, index) => {
        if (index === parts.length - 1) {
          // It's a file, we stop here
          current[part] = filePath; // Store the file path or just `null` if you don't need the path in the final tree
        } else {
          // It's a directory
          if (!current[part]) {
            current[part] = {};
          }
          current = current[part];
        }
      });
    });

    // Stringify the tree
    const stringifyTree_ = (tree, prefix = "") => {
      let result = "";
      const keys = Object.keys(tree);
      keys.forEach((key, index) => {
        const isLast = index === keys.length - 1;
        const connector = isLast ? "└── " : "├── ";
        result += `${prefix}${connector}${key}\n`;
        if (
          typeof tree[key] === "object" &&
          Object.keys(tree[key]).length > 0
        ) {
          result += stringifyTree_(
            tree[key],
            `${prefix}${isLast ? "    " : "|   "}`
          );
        }
      });
      return result;
    };

    return stringifyTree_(tree);
  }

  async executeBlocks(pre = true, context_ = {}) {
    const code_helper = new (require("./codeBlocks"))();
    const code_blocks = await this.getCodeBlocks();
    for (const block of code_blocks) {
      // test if block.lang ends with ':pre' or not; if pre is false, then only run if block.lang doesn't contains ':'
      if (
        (pre && block.lang.endsWith(":pre")) ||
        (!pre && block.lang.indexOf(":") == -1)
      ) {
        // if block.lang contains 'js'
        if (block.lang.includes("js")) {
          const code_executed = await code_helper.executeNode(
            context_,
            block.code
          );
          // if code_executed is an object
          if (typeof code_executed === "object") {
            //console.log('adding context from pre:js code block',code_executed);
            context_ = { ...context_, ...code_executed };
          }
        } else if (block.lang.includes("python")) {
          // if block.lang contains 'python'
          context_ = { ...context_, templateDir: this.templateDir };
          const code_executed = await code_helper.executePython(
            context_,
            block.code
          );
          if (typeof code_executed === "object") {
            //console.log('adding context from pre:python code block',code_executed);
            context_ = { ...context_, ...code_executed };
          }
        } else if (block.lang.includes("bash")) {
          const code_executed = await code_helper.executeBash(
            context_,
            block.code
          );
          if (code_executed.vars) {
            context_ = { ...context_, ...code_executed.vars };
          }
        }
      }
    }
    // TODO: check param context update safety (not dup context_ param because it may contain functions)
    return context_;
  }

  async executeNode(context_ = {}, code) {
    const code_helper = new (require("./codeBlocks"))();
    const code_executed = await code_helper.executeNode(context_, code);
    return code_executed;
  }

  async executeBash(context_ = {}, code) {
    const code_helper = new (require("./codeBlocks"))();
    const code_executed = await code_helper.executeBash(context_, code);
    return code_executed;
  }

  async executePython(context_ = {}, code) {
    const code_helper = new (require("./codeBlocks"))();
    const context__ = { ...context_, templateDir: this.templateDir };
    const code_executed = await code_helper.executePython(context__, code);
    return code_executed;
  }

  async spawnBash(context_ = {}, code) {
    const code_helper = new (require("./codeBlocks"))();
    const code_executed = await code_helper.spawnBash(context_, code);
    return code_executed;
  }

  async runTemplate(prompt = "", methods = {}, context = {}) {
    const code_helper = new (require("./codeBlocks"))();
    const base_methods = {
      queryLLM: async (question, schema) => {
        return await this.queryLLM(question, schema);
      },
      queryContext: async (question, schema) => {
        return await this.request(question, schema);
      },
      extractCodeBlocks: this.extractCodeBlocks,
    };
    const methods_ = {
      ...base_methods,
      ...methods,
      ...{
        executeScript: async (code) => {
          const code_executed = await code_helper.executeNode(
            { ...base_methods, ...methods, ...context },
            code
          );
          return code_executed;
        },
      },
    };
    //build handlebar template prompt first (to also get initial context vars)
    const context_prompt = await this.generateContextPrompt(
      null,
      true,
      context
    );
    let context_ = { ...methods_, ...context_prompt.context };
    //search x:pre codeblocks and execute
    context_ = await this.executeBlocks(true, context_);
    //execute prompt template if template contains a handlebar besides scripts
    //TODO 22-abr-24
    if (context_prompt.rendered.trim() != "") {
      const template_res = await this.request(prompt, null, {
        custom_variables: { ...context_ },
      });
      context_ = {
        ...context_,
        ...{
          schema: template_res.data,
        },
      };
    }
    //search x codeblocks and execute
    context_ = await this.executeBlocks(false, context_);

    return context_;
  }

  async generateContextPrompt(template = null, object = false, variables = {}) {
    if (template) {
      await this.loadAndRegisterTemplate(template);
    }
    // TODO: optimize the following block
    let variables_ = { ...variables }; // clone param
    // Add debug statement to show diff options before traversing
    this.debug(
      `Before traverseDirectory: diff=${this.diff}, diffPath=${this.diffPath}`
    );

    let { absolutePath, sourceTree, filesArray } = await this.traverseDirectory(
      this.options.path
    );

    if (Object.keys(variables_).length > 0) {
      if (!variables_.absolute_code_path)
        variables_.absolute_code_path = absolutePath;
      if (!variables_.source_tree) variables_.source_tree = sourceTree;
      if (!variables_.files) variables_.files = filesArray;
      // Add diffPath and showProjectPath to variables
      if (!variables_.diffPath && this.diffPath)
        variables_.diffPath = this.diffPath;
      if (variables_.showProjectPath === undefined)
        variables_.showProjectPath = this.showProjectPath;
    } else {
      variables_ = {
        absolute_code_path: absolutePath,
        source_tree: sourceTree,
        files: filesArray,
        diffPath: this.diffPath,
        showProjectPath: this.showProjectPath,
      };
    }
    let rendered = this.template(variables_);
    //console.log(rendered);
    if (object) {
      return {
        context: variables_,
        rendered: rendered,
      };
    }
    return rendered;
  }

  getCodeBlocks() {
    return this.code_blocks;
  }

  //
  // calling prompt helper methods
  //

  async setupFetchPolyfill() {
    if (!globalThis.fetch) {
      const fetch = (await import("node-fetch")).default;
      globalThis.fetch = fetch;
      globalThis.Request = fetch.Request;
      globalThis.Response = fetch.Response;
      globalThis.Headers = fetch.Headers;
    }
  }

  getLLM(content, preferences = null) {
    const { OpenAIChatApi, GroqChatApi, AnthropicChatApi } = require("llm-api");
    const context_tokens = gpt_tokenizer.encode(content).length;

    const prefs = preferences || this.modelPreferences;

    for (const provider of prefs) {
      switch (provider) {
        case "ANTHROPIC":
          // Check if we have Anthropic key and conditions match
          // NOTE: Example condition, adjust as needed
          if (this.ANTHROPIC_KEY && context_tokens > 208000) {
            this.debug("Using Anthropic model");
            const llm = new AnthropicChatApi(
              { apiKey: this.ANTHROPIC_KEY, timeout: 40000 },
              {
                model: "claude-3-5-haiku-20241022", // fastest 0.8 usd per 1mn tokens
                contextSize: 200000,
              }
            );
            llm.provider = "ANTHROPIC";
            return llm;
          }
          break;
        case "GROQ":
          if (this.GROQ_KEY && context_tokens < 128000) {
            this.debug("Using GROQ model");
            let llm = new GroqChatApi(
              { apiKey: this.GROQ_KEY, timeout: 20000 },
              { model: "llama-3.3-70b-versatile", contextSize: 128000 }
            );
            /*if (context_tokens < 64000) {
              llm = new GroqChatApi({ apiKey: this.GROQ_KEY, timeout: 20000 }, { model: 'llama-3.1-8b-instant', contextSize: 128000 });
            } else {
              llm = new GroqChatApi({ apiKey: this.GROQ_KEY, timeout: 20000 }, { model: 'llama-3.3-70b-versatile', contextSize: 128000 });
            }*/
            llm.provider = "GROQ";
            return llm;
          }
          break;
        case "OPENAI":
          if (this.OPENAI_KEY && context_tokens < 128000) {
            this.debug("Using OpenAI model gpt-4o");
            let llm = new OpenAIChatApi(
              { apiKey: this.OPENAI_KEY, timeout: 20000 },
              { model: "gpt-4o", contextSize: 128000 }
            );
            llm.provider = "OPENAI";
            return llm;
          }
          break;
      }
    }
    this.debug("No preferred model applicable, returning null");
    return null; // If no suitable model found
  }

  async queryLLM(prompt = "", schema = null) {
    // query the LLM without context, with fallback to next provider if fails
    try {
      await this.setupFetchPolyfill();
    } catch (e) {}

    const { completion } = require("zod-gpt");

    let preferences = [...this.modelPreferences]; // Copy of the preference list
    let lastError;

    while (preferences.length > 0) {
      const llm = this.getLLM(prompt, preferences);
      if (!llm) {
        // No suitable model found among the remaining preferences
        break;
      }
      this.debug(`Chosen LLM provider: ${llm.provider}`);

      try {
        let response = {};
        let return_ = { data: {}, usage: {} };

        if (schema) {
          response = await completion(llm, prompt, {
            schema: z.object({ schema }),
          });
        } else {
          response = await completion(llm, prompt);
        }

        if (response && response.data && response.data.schema) {
          return_.data = response.data.schema;
          return_.usage = response.usage;
        } else if (response && response.data) {
          return_.data = response.data;
        }

        // Successfully got a response, return it
        return return_;
      } catch (err) {
        lastError = err;
        this.debug(
          `LLM provider ${llm.provider} failed with error: ${err.message}`
        );
        // Remove the failed provider from the list
        preferences = preferences.filter((p) => p !== llm.provider);
        this.debug(
          `Remaining preferences after failure: ${JSON.stringify(preferences)}`
        );
      }
    }

    // If we reach this point, either no providers were suitable or all failed
    throw new Error(
      `All LLM providers failed. Last error: ${
        lastError ? lastError.message : "none"
      }`
    );
  }

  async request(
    prompt = "",
    schema = null,
    options = {
      custom_context: null,
      meta: false,
      custom_variables: {},
    }
  ) {
    await this.setupFetchPolyfill();
    const { completion } = require("zod-gpt");

    if (schema) {
      this.schema = z.object({ schema });
    }

    // Prepare context
    let context_;
    let context;
    if (!options.custom_context) {
      context_ = await this.generateContextPrompt(
        null,
        true,
        options.custom_variables
      );
      context = context_.rendered;
    } else {
      context_ = { context: options.custom_context, rendered: "" };
      context = "";
    }

    let fullPrompt = prompt ? context + "\n\n# " + prompt : context;

    let preferences = [...this.modelPreferences]; // Copy of the preference list
    let lastError;

    while (preferences.length > 0) {
      const llm = this.getLLM(fullPrompt, preferences);
      if (!llm) {
        // No suitable model found among the remaining preferences
        break;
      }

      this.debug(`Chosen LLM provider: ${llm.provider} for request()`);

      try {
        let response = {};
        let return_ = { data: {}, usage: {} };

        if (this.schema) {
          response = await completion(llm, fullPrompt, { schema: this.schema });
        } else {
          response = await completion(llm, fullPrompt);
        }

        if (response && response.data && response.data.schema) {
          return_.data = response.data.schema;
          return_.usage = response.usage;
        } else if (response && response.data) {
          return_.data = response.data;
        }

        if (options.meta) {
          return_.context = context_.context;
          return_.code_blocks = this.code_blocks;
        }

        // add to this.QArecordings[this.last_QAsession] if exists
        if (this.last_QAsession) {
          this.QArecordings[this.last_QAsession] = {
            question: prompt,
            answer: return_.data,
          };
        }

        // Successfully got a response, return it
        return return_;
      } catch (err) {
        lastError = err;
        this.debug(
          `LLM provider ${llm.provider} failed with error: ${err.message}`
        );
        // Remove the failed provider from the list
        preferences = preferences.filter((p) => p !== llm.provider);
        this.debug(
          `Remaining preferences after failure: ${JSON.stringify(preferences)}`
        );
      }
    }

    // If we reach this point, either no providers were suitable or all failed
    throw new Error(
      `All LLM providers failed. Last error: ${
        lastError ? lastError.message : "none"
      }`
    );
  }

  createZodSchema(input) {
    if (Array.isArray(input)) {
      // Handle arrays; assumes first element structure for all elements
      if (input.length === 0) {
        return z.array(z.unknown());
      } else {
        // TODO add support for string values as z.enum
        return z.array(this.createZodSchema(input[0]));
      }
    } else if (typeof input === "object" && input !== null) {
      // Handle objects
      const schemaFields = Object.keys(input).reduce((acc, key) => {
        // Use the value as description for nested fields if it's a string
        const fieldValue = input[key];
        acc[key] =
          typeof fieldValue === "string"
            ? this.createZodSchema(fieldValue, key)
            : createZodSchema(fieldValue);
        return acc;
      }, {});
      return z.object(schemaFields);
    } else if (typeof input === "string") {
      // Use the string value as the description
      return z.string().describe(input);
    } else {
      // For all other types, default to using z.string() without description
      // Adjust this part as necessary to handle more types explicitly
      return z.string();
    }
  }
}

module.exports = Code2Prompt;
//
