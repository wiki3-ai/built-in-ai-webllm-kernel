// src/federation.ts
// Module Federation container for JupyterLite

import { streamText } from "ai";
import { webLLM } from "@built-in-ai/web-llm";
import { WEBLLM_MODELS, DEFAULT_WEBLLM_MODEL, isValidWebLLMModel } from "./models.js";

declare const window: any;

console.log("[webllm-chat-kernel/federation] Setting up Module Federation container");

const scope = "@wiki3-ai/webllm-chat-kernel";
let sharedScope: any = null;

// Module-level storage for the settings-based default model
let settingsDefaultModel: string | null = null;

/**
 * Get the default model from settings, falling back to the hardcoded default.
 * This is called when the kernel is first initialized.
 */
function getDefaultModel(): string {
  return settingsDefaultModel ?? DEFAULT_WEBLLM_MODEL;
}

// Helper to get a module from the shared scope
async function importShared(pkg: string): Promise<any> {
  if (!sharedScope) {
    // Fallback to global webpack share scope if available
    // @ts-ignore
    if (window.__webpack_share_scopes__ && window.__webpack_share_scopes__.default) {
      console.warn(`[webllm-chat-kernel] Using global __webpack_share_scopes__.default for ${pkg}`);
      // @ts-ignore
      sharedScope = window.__webpack_share_scopes__.default;
    } else {
      throw new Error(`[webllm-chat-kernel] Shared scope not initialized when requesting ${pkg}`);
    }
  }

  const versions = sharedScope[pkg];
  if (!versions) {
    throw new Error(`[webllm-chat-kernel] Shared module ${pkg} not found in shared scope. Available: ${Object.keys(sharedScope)}`);
  }

  const versionKeys = Object.keys(versions);
  if (versionKeys.length === 0) {
    throw new Error(`[webllm-chat-kernel] No versions available for ${pkg}`);
  }

  // Pick the first available version
  const version = versions[versionKeys[0]];
  const factory = version?.get;

  if (typeof factory !== "function") {
    throw new Error(`[webllm-chat-kernel] Module ${pkg} has no factory function`);
  }

  // Factory might return a Promise or the module directly
  let result = factory();

  // If it's a promise, await it
  if (result && typeof result.then === 'function') {
    result = await result;
  }

  // If result is a function (Webpack module wrapper), call it to get the actual exports
  if (typeof result === 'function') {
    result = result();
  }

  console.log(`[webllm-chat-kernel] Loaded ${pkg}:`, result);
  return result;
}

// Module Federation container API
const container = {
  init: (scope: any) => {
    console.log("[webllm-chat-kernel/federation] init() called, storing shared scope");
    sharedScope = scope;
    return Promise.resolve();
  },

  get: async (module: string) => {
    console.log("[webllm-chat-kernel/federation] get() called for module:", module);
    console.log("[webllm-chat-kernel/federation] This means JupyterLite is requesting our plugin!");

    // JupyterLite may request either "./index" or "./extension"
    if (module === "./index" || module === "./extension") {
      // Lazy-load our plugin module, which will pull from shared scope
      return async () => {
        console.log("[webllm-chat-kernel/federation] ===== LOADING PLUGIN MODULE =====");
        console.log("[webllm-chat-kernel/federation] Loading plugins from shared scope...");

        // Import JupyterLab/JupyterLite modules from shared scope
        const { BaseKernel, IKernelSpecs } = await importShared('@jupyterlite/kernel');
        const { Widget } = await importShared('@lumino/widgets');

        const { ReactWidget } = await importShared('@jupyterlab/apputils');
        const React = await importShared('react');
        const { HTMLSelect } = await importShared('@jupyterlab/ui-components');


        console.log("[webllm-chat-kernel/federation] Got BaseKernel from shared scope:", BaseKernel);

        // Define WebLLM-backed Chat kernel inline (browser-only, no HTTP)
        class WebLLMChatKernel {
          private modelName: string | null = null;
          private model: ReturnType<typeof webLLM> | null = null;
          private initialized: boolean = false;

          constructor() {
            // Model initialization is deferred until first send() call
            console.log("[WebLLMChatKernel] Created (model initialization deferred until first execution)");
          }

          /**
           * Initialize the model. Called on first send() or when explicitly setting a model.
           */
          private initializeModel(modelName: string) {
            if (!isValidWebLLMModel(modelName)) {
              throw new Error(`Invalid model: ${modelName}. Use %ai model to see available models.`);
            }
            
            this.modelName = modelName;
            this.model = webLLM(this.modelName, {
              initProgressCallback: (report) => {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(
                    new CustomEvent("webllm:model-progress", { detail: report })
                  );
                }
              },
            });
            this.initialized = true;
            console.log("[WebLLMChatKernel] Initialized with model:", this.modelName);
          }

          /**
           * Set or change the model. Can be called via %ai model magic.
           * If the model is already initialized, this will reinitialize with the new model.
           */
          setModel(modelName: string): string {
            if (!isValidWebLLMModel(modelName)) {
              throw new Error(`Invalid model: ${modelName}`);
            }
            
            const wasInitialized = this.initialized;
            this.initializeModel(modelName);
            
            if (wasInitialized) {
              return `Model changed to: ${modelName}`;
            } else {
              return `Model set to: ${modelName}`;
            }
          }

          /**
           * Get the current model name, or null if not yet initialized.
           */
          getModelName(): string | null {
            return this.modelName;
          }

          /**
           * Check if the model has been initialized.
           */
          isInitialized(): boolean {
            return this.initialized;
          }

          async send(prompt: string, onChunk?: (chunk: string) => void): Promise<string> {
            // Initialize model on first send if not already done
            if (!this.initialized || !this.model) {
              const defaultModel = getDefaultModel();
              this.initializeModel(defaultModel);
              console.log("[WebLLMChatKernel] Auto-initialized with settings default:", defaultModel);
            }

            console.log(
              "[WebLLMChatKernel] Sending prompt to WebLLM:",
              prompt,
              "using model:",
              this.modelName
            );

            const availability = await this.model!.availability();
            if (availability === "unavailable") {
              throw new Error("Browser does not support WebLLM / WebGPU.");
            }
            if (availability === "downloadable" || availability === "downloading") {
              await this.model!.createSessionWithProgress((report) => {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(
                    new CustomEvent("webllm:model-progress", { detail: report })
                  );
                }
              });
            }

            const result = await streamText({
              model: this.model!,
              messages: [{ role: "user", content: prompt }],
            });

            let reply = "";
            for await (const chunk of result.textStream) {
              reply += chunk;
              if (onChunk) {
                onChunk(chunk);
              }
            }

            console.log("[WebLLMChatKernel] Got reply from WebLLM:", reply);
            return reply;
          }
        }

        // Define WebLLMLiteKernel extending BaseKernel
        class WebLLMLiteKernel extends BaseKernel {
          private chat: WebLLMChatKernel;

          constructor(options: any) {
            super(options);
            this.chat = new WebLLMChatKernel();
          }

          /**
           * Handle %ai magic commands.
           * Returns the response text if a magic was handled, or null if not a magic command.
           */
          private handleMagic(code: string): string | null {
            const trimmed = code.trim();
            
            // %ai model [name] - show current model, list models, or set model
            if (trimmed === "%ai model" || trimmed === "%ai models") {
              const current = this.chat.getModelName();
              const status = this.chat.isInitialized() 
                ? `Current model: ${current}` 
                : `Model not yet initialized. Default: ${getDefaultModel()}`;
              const modelList = WEBLLM_MODELS.slice(0, 20).join("\n  ");
              return `${status}\n\nAvailable models (showing first 20 of ${WEBLLM_MODELS.length}):\n  ${modelList}\n  ...\n\nUse "%ai model <name>" to switch models.`;
            }
            
            const modelMatch = trimmed.match(/^%ai\s+model\s+(\S+)$/);
            if (modelMatch) {
              const modelName = modelMatch[1];
              try {
                const result = this.chat.setModel(modelName);
                return result;
              } catch (err: any) {
                throw new Error(`${err.message}\n\nUse "%ai model" to see available models.`);
              }
            }
            
            // %ai help
            if (trimmed === "%ai" || trimmed === "%ai help") {
              return `WebLLM Chat Kernel Magic Commands:

  %ai model          - Show current model and list available models
  %ai model <name>   - Switch to a different model
  %ai help           - Show this help message

The model is initialized on first cell execution using the default from Settings.
After initialization, use "%ai model <name>" to switch models.`;
            }
            
            return null; // Not a magic command
          }

          async executeRequest(content: any): Promise<any> {
            const code = String(content.code ?? "");
            try {
              // Check for magic commands first
              const magicResult = this.handleMagic(code);
              if (magicResult !== null) {
                // @ts-ignore
                this.stream(
                  { name: "stdout", text: magicResult + "\n" },
                  // @ts-ignore
                  this.parentHeader
                );
                return {
                  status: "ok",
                  // @ts-ignore
                  execution_count: this.executionCount,
                  payload: [],
                  user_expressions: {},
                };
              }

              // Stream each chunk as it arrives using the stream() method for stdout
              await this.chat.send(code, (chunk: string) => {
                // @ts-ignore
                this.stream(
                  { name: "stdout", text: chunk },
                  // @ts-ignore
                  this.parentHeader
                );
              });

              return {
                status: "ok",
                // @ts-ignore
                execution_count: this.executionCount,
                payload: [],
                user_expressions: {},
              };
            } catch (err: any) {
              const message = err?.message ?? String(err);
              // @ts-ignore
              this.publishExecuteError(
                {
                  ename: "Error",
                  evalue: message,
                  traceback: [],
                },
                // @ts-ignore
                this.parentHeader
              );
              return {
                status: "error",
                // @ts-ignore
                execution_count: this.executionCount,
                ename: "Error",
                evalue: message,
                traceback: [],
              };
            }
          }

          async kernelInfoRequest(): Promise<any> {
            return {
              status: "ok",
              protocol_version: "5.3",
              implementation: "webllm-lite-kernel",
              implementation_version: "0.1.0",
              language_info: {
                name: "markdown",
                version: "0.0.0",
                mimetype: "text/markdown",
                file_extension: ".md",
              },
              banner: "WebLLM-backed browser chat kernel",
              help_links: [],
            };
          }

          async completeRequest(content: any): Promise<any> {
            return {
              status: "ok",
              matches: [],
              cursor_start: content.cursor_pos ?? 0,
              cursor_end: content.cursor_pos ?? 0,
              metadata: {},
            };
          }

          async inspectRequest(_content: any): Promise<any> {
            return { status: "ok", found: false, data: {}, metadata: {} };
          }

          async isCompleteRequest(_content: any): Promise<any> {
            return { status: "complete", indent: "" };
          }

          async commInfoRequest(_content: any): Promise<any> {
            return { status: "ok", comms: {} };
          }

          async historyRequest(_content: any): Promise<any> {
            return { status: "ok", history: [] };
          }

          async shutdownRequest(_content: any): Promise<any> {
            return { status: "ok", restart: false };
          }

          async inputReply(_content: any): Promise<void> { }
          async commOpen(_content: any): Promise<void> { }
          async commMsg(_content: any): Promise<void> { }
          async commClose(_content: any): Promise<void> { }
        }
        // Try to get ISettingRegistry from shared scope (optional)
        let ISettingRegistry: any = null;
        try {
          const settingModule = await importShared('@jupyterlab/settingregistry');
          ISettingRegistry = settingModule.ISettingRegistry;
          console.log("[webllm-chat-kernel] Got ISettingRegistry from shared scope");
        } catch (e) {
          console.warn("[webllm-chat-kernel] ISettingRegistry not available, using defaults");
        }

        // Define and return the plugin
        const webllmChatKernelPlugin = {
          id: "@wiki3-ai/webllm-chat-kernel:plugin",
          autoStart: true,
          // Match the official JupyterLite custom kernel pattern:
          // https://jupyterlite.readthedocs.io/en/latest/howto/extensions/kernel.html
          requires: [IKernelSpecs],
          optional: ISettingRegistry ? [ISettingRegistry] : [],
          activate: async (app: any, kernelspecs: any, settingRegistry?: any) => {
            console.log("[webllm-chat-kernel] ===== ACTIVATE FUNCTION CALLED =====");
            console.log("[webllm-chat-kernel] JupyterLab app:", app);
            console.log("[webllm-chat-kernel] kernelspecs service:", kernelspecs);
            console.log("[webllm-chat-kernel] settingRegistry:", settingRegistry);

            // Load settings if available
            if (settingRegistry) {
              try {
                const settings = await settingRegistry.load("@wiki3-ai/webllm-chat-kernel:plugin");
                const updateSettings = () => {
                  const model = settings.get("defaultModel").composite as string;
                  if (model && isValidWebLLMModel(model)) {
                    settingsDefaultModel = model;
                    console.log("[webllm-chat-kernel] Settings loaded, default model:", model);
                  }
                };
                updateSettings();
                settings.changed.connect(updateSettings);
              } catch (e) {
                console.warn("[webllm-chat-kernel] Failed to load settings:", e);
              }
            }

            if (!kernelspecs || typeof kernelspecs.register !== "function") {
              console.error("[webllm-chat-kernel] ERROR: kernelspecs.register not available!");
              return;
            }

            try {
              kernelspecs.register({
                spec: {
                  name: "webllm-chat",
                  display_name: "WebLLM Chat",
                  language: "python",
                  argv: [],
                  resources: {},
                },
                create: async (options: any) => {
                  console.log("[webllm-chat-kernel] Creating WebLLMLiteKernel instance", options);
                  return new WebLLMLiteKernel(options);
                },
              });

              console.log("[webllm-chat-kernel] ===== KERNEL REGISTERED SUCCESSFULLY =====");
              console.log("[webllm-chat-kernel] Kernel name: webllm-chat");
              console.log("[webllm-chat-kernel] Display name: WebLLM Chat");
            } catch (error) {
              console.error("[webllm-chat-kernel] ===== REGISTRATION ERROR =====", error);
            }

            // Log model download progress to console
            if (typeof window !== "undefined") {
              window.addEventListener("webllm:model-progress", (ev: any) => {
                const { progress: p, text } = ev.detail;
                const suffix =
                  typeof p === "number" && p > 0 && p < 1
                    ? ` ${Math.round(p * 100)}%`
                    : p === 1
                    ? " ready"
                    : "";
                console.log(`[webllm-chat-kernel] ${text || "Loading"}${suffix}`);
              });
            }
          },
        };

        const plugins = [webllmChatKernelPlugin];
        console.log("[webllm-chat-kernel/federation] ===== PLUGIN CREATED SUCCESSFULLY =====");
        console.log("[webllm-chat-kernel/federation] Plugin ID:", webllmChatKernelPlugin.id);
        console.log("[webllm-chat-kernel/federation] Plugin autoStart:", webllmChatKernelPlugin.autoStart);
        console.log("[webllm-chat-kernel/federation] Returning plugins array:", plugins);

        // IMPORTANT: Shape the exports like a real federated ES module
        // so JupyterLite's loader sees our plugins. It checks for
        // `__esModule` and then reads `.default`.
        const moduleExports = {
          __esModule: true,
          default: plugins
        };

        return moduleExports;
      };
    }

    throw new Error(`[webllm-chat-kernel/federation] Unknown module: ${module}`);
  }
};

// Register the container
window._JUPYTERLAB = window._JUPYTERLAB || {};
window._JUPYTERLAB[scope] = container;

console.log("[webllm-chat-kernel/federation] Registered Module Federation container for scope:", scope);
