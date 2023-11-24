// We can only import types from Vite at the top level since we're in a CJS
// context but want to use Vite's ESM build to avoid deprecation warnings
import type * as Vite from "vite";
import { type BinaryLike, createHash } from "node:crypto";
import * as path from "node:path";
import * as fse from "fs-extra";
import babel from "@babel/core";
import { type ServerBuild } from "@remix-run/server-runtime";
import {
  init as initEsModuleLexer,
  parse as esModuleLexer,
} from "es-module-lexer";
import jsesc from "jsesc";
import pick from "lodash/pick";
import colors from "picocolors";

import { type RouteManifest } from "../config/routes";
import {
  type AppConfig as RemixUserConfig,
  type RemixConfig as ResolvedRemixConfig,
  resolveConfig,
} from "../config";
import { type Manifest } from "../manifest";
import invariant from "../invariant";
import { createRequestHandler } from "./node/adapter";
import { getStylesForUrl, isCssModulesFile } from "./styles";
import * as VirtualModule from "./vmod";
import { removeExports } from "./remove-exports";
import { replaceImportSpecifier } from "./replace-import-specifier";

// We reassign the "vite" variable from a dynamic import of Vite's ESM build
// when the Vite plugin's config hook is executed
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let vite: typeof import("vite");

const supportedRemixConfigKeys = [
  "appDirectory",
  "assetsBuildDirectory",
  "future",
  "ignoredRouteFiles",
  "publicPath",
  "routes",
  "serverBuildPath",
  "serverModuleFormat",
  "devLoadContext",
] as const satisfies ReadonlyArray<keyof RemixUserConfig>;
type SupportedRemixConfigKey = typeof supportedRemixConfigKeys[number];
type SupportedRemixConfig = Pick<RemixUserConfig, SupportedRemixConfigKey>;

// We need to provide different JSDoc comments in some cases due to differences
// between the Remix config and the Vite plugin.
type RemixConfigJsdocOverrides = {
  /**
   * The path to the browser build, relative to the project root. Defaults to
   * `"build/client"`.
   */
  assetsBuildDirectory?: SupportedRemixConfig["assetsBuildDirectory"];
  /**
   * The URL prefix of the browser build with a trailing slash. Defaults to
   * `"/"`. This is the path the browser will use to find assets.
   */
  publicPath?: SupportedRemixConfig["publicPath"];
  /**
   * The path to the server build file, relative to the project. This file
   * should end in a `.js` extension and should be deployed to your server.
   * Defaults to `"build/server/index.js"`.
   */
  serverBuildPath?: SupportedRemixConfig["serverBuildPath"];
};

export type RemixVitePluginOptions = RemixConfigJsdocOverrides &
  Omit<SupportedRemixConfig, keyof RemixConfigJsdocOverrides>;

type ResolvedRemixVitePluginConfig = Pick<
  ResolvedRemixConfig,
  | "appDirectory"
  | "rootDirectory"
  | "assetsBuildDirectory"
  | "entryClientFilePath"
  | "entryServerFilePath"
  | "future"
  | "publicPath"
  | "relativeAssetsBuildDirectory"
  | "routes"
  | "serverBuildPath"
  | "serverModuleFormat"
  | "devLoadContext"
>;

let serverEntryId = VirtualModule.id("server-entry");
let serverManifestId = VirtualModule.id("server-manifest");
let browserManifestId = VirtualModule.id("browser-manifest");
let remixReactProxyId = VirtualModule.id("remix-react-proxy");
let hmrRuntimeId = VirtualModule.id("hmr-runtime");
let injectHmrRuntimeId = VirtualModule.id("inject-hmr-runtime");

const resolveFileUrl = (
  { rootDirectory }: Pick<ResolvedRemixVitePluginConfig, "rootDirectory">,
  filePath: string
) => {
  let relativePath = path.relative(rootDirectory, filePath);
  let isWithinRoot =
    !relativePath.startsWith("..") && !path.isAbsolute(relativePath);

  if (!isWithinRoot) {
    // Vite will prevent serving files outside of the workspace
    // unless user explictly opts in with `server.fs.allow`
    // https://vitejs.dev/config/server-options.html#server-fs-allow
    return path.posix.join("/@fs", vite.normalizePath(filePath));
  }

  return "/" + vite.normalizePath(relativePath);
};

const isJsFile = (filePath: string) => /\.[cm]?[jt]sx?$/i.test(filePath);

type Route = RouteManifest[string];
const resolveRelativeRouteFilePath = (
  route: Route,
  pluginConfig: ResolvedRemixVitePluginConfig
) => {
  let file = route.file;
  let fullPath = path.resolve(pluginConfig.appDirectory, file);

  return vite.normalizePath(fullPath);
};

let vmods = [serverEntryId, serverManifestId, browserManifestId];

const getHash = (source: BinaryLike, maxLength?: number): string => {
  let hash = createHash("sha256").update(source).digest("hex");
  return typeof maxLength === "number" ? hash.slice(0, maxLength) : hash;
};

const resolveBuildAssetPaths = (
  pluginConfig: ResolvedRemixVitePluginConfig,
  viteManifest: Vite.Manifest,
  absoluteFilePath: string
): Manifest["entry"] & { css: string[] } => {
  let rootRelativeFilePath = path.relative(
    pluginConfig.rootDirectory,
    absoluteFilePath
  );
  let manifestKey = vite.normalizePath(rootRelativeFilePath);
  let entryChunk = viteManifest[manifestKey];

  if (!entryChunk) {
    let knownManifestKeys = Object.keys(viteManifest)
      .map((key) => '"' + key + '"')
      .join(", ");
    throw new Error(
      `No manifest entry found for "${manifestKey}". Known manifest keys: ${knownManifestKeys}`
    );
  }

  let chunks = resolveDependantChunks(viteManifest, entryChunk);

  return {
    module: `${pluginConfig.publicPath}${entryChunk.file}`,
    imports:
      dedupe(chunks.flatMap((e) => e.imports ?? [])).map((imported) => {
        return `${pluginConfig.publicPath}${viteManifest[imported].file}`;
      }) ?? [],
    css:
      dedupe(chunks.flatMap((e) => e.css ?? [])).map((href) => {
        return `${pluginConfig.publicPath}${href}`;
      }) ?? [],
  };
};

function resolveDependantChunks(
  viteManifest: Vite.Manifest,
  entryChunk: Vite.ManifestChunk
): Vite.ManifestChunk[] {
  let chunks = new Set<Vite.ManifestChunk>();

  function walk(chunk: Vite.ManifestChunk) {
    if (chunks.has(chunk)) {
      return;
    }

    if (chunk.imports) {
      for (let importKey of chunk.imports) {
        walk(viteManifest[importKey]);
      }
    }

    chunks.add(chunk);
  }

  walk(entryChunk);

  return Array.from(chunks);
}

function dedupe<T>(array: T[]): T[] {
  return [...new Set(array)];
}

const writeFileSafe = async (file: string, contents: string): Promise<void> => {
  await fse.ensureDir(path.dirname(file));
  await fse.writeFile(file, contents);
};

const getRouteModuleExports = async (
  viteChildCompiler: Vite.ViteDevServer | null,
  pluginConfig: ResolvedRemixVitePluginConfig,
  routeFile: string
): Promise<string[]> => {
  if (!viteChildCompiler) {
    throw new Error("Vite child compiler not found");
  }

  // We transform the route module code with the Vite child compiler so that we
  // can parse the exports from non-JS files like MDX. This ensures that we can
  // understand the exports from anything that Vite can compile to JS, not just
  // the route file formats that the Remix compiler historically supported.

  let ssr = true;
  let { pluginContainer, moduleGraph } = viteChildCompiler;
  let routePath = path.join(pluginConfig.appDirectory, routeFile);
  let url = resolveFileUrl(pluginConfig, routePath);

  let resolveId = async () => {
    let result = await pluginContainer.resolveId(url, undefined, { ssr });
    if (!result) throw new Error(`Could not resolve module ID for ${url}`);
    return result.id;
  };

  let [id, code] = await Promise.all([
    resolveId(),
    fse.readFile(routePath, "utf-8"),
    // pluginContainer.transform(...) fails if we don't do this first:
    moduleGraph.ensureEntryFromUrl(url, ssr),
  ]);

  let transformed = await pluginContainer.transform(code, id, { ssr });
  let [, exports] = esModuleLexer(transformed.code);
  let exportNames = exports.map((e) => e.n);

  return exportNames;
};

const showUnstableWarning = () => {
  console.warn(
    colors.yellow(
      "\n  ⚠️  Remix support for Vite is unstable\n     and not recommended for production\n"
    )
  );
};

const getViteMajorVersion = (): number => {
  let vitePkg = require("vite/package.json");
  return parseInt(vitePkg.version.split(".")[0]!);
};

export type RemixVitePlugin = (
  options?: RemixVitePluginOptions
) => Vite.Plugin[];
export const remixVitePlugin: RemixVitePlugin = (options = {}) => {
  let viteCommand: Vite.ResolvedConfig["command"];
  let viteUserConfig: Vite.UserConfig;
  let resolvedViteConfig: Vite.ResolvedConfig | undefined;

  let isViteV4 = getViteMajorVersion() === 4;

  let cssModulesManifest: Record<string, string> = {};
  let ssrBuildContext:
    | { isSsrBuild: false }
    | { isSsrBuild: true; getManifest: () => Promise<Manifest> };

  let viteChildCompiler: Vite.ViteDevServer | null = null;
  let cachedPluginConfig: ResolvedRemixVitePluginConfig | undefined;

  let resolvePluginConfig =
    async (): Promise<ResolvedRemixVitePluginConfig> => {
      let defaults: Partial<RemixVitePluginOptions> = {
        serverBuildPath: "build/server/index.js",
        assetsBuildDirectory: "build/client",
        publicPath: "/",
      };

      let config = {
        ...defaults,
        ...pick(options, supportedRemixConfigKeys), // Avoid leaking any config options that the Vite plugin doesn't support
      };

      let rootDirectory =
        viteUserConfig.root ?? process.env.REMIX_ROOT ?? process.cwd();

      // Only select the Remix config options that the Vite plugin uses
      let {
        appDirectory,
        assetsBuildDirectory,
        entryClientFilePath,
        publicPath,
        routes,
        entryServerFilePath,
        serverBuildPath,
        serverModuleFormat,
        relativeAssetsBuildDirectory,
        devLoadContext,
      } = await resolveConfig(config, { rootDirectory });

      return {
        appDirectory,
        rootDirectory,
        assetsBuildDirectory,
        entryClientFilePath,
        publicPath,
        routes,
        entryServerFilePath,
        serverBuildPath,
        serverModuleFormat,
        relativeAssetsBuildDirectory,
        future: {
          v3_fetcherPersist: options.future?.v3_fetcherPersist === true,
        },
        devLoadContext,
      };
    };

  let getServerEntry = async () => {
    let pluginConfig = await resolvePluginConfig();

    return `
    import * as entryServer from ${JSON.stringify(
      resolveFileUrl(pluginConfig, pluginConfig.entryServerFilePath)
    )};
    ${Object.keys(pluginConfig.routes)
      .map((key, index) => {
        let route = pluginConfig.routes[key]!;
        return `import * as route${index} from ${JSON.stringify(
          resolveFileUrl(
            pluginConfig,
            resolveRelativeRouteFilePath(route, pluginConfig)
          )
        )};`;
      })
      .join("\n")}
      export { default as assets } from ${JSON.stringify(serverManifestId)};
      export const assetsBuildDirectory = ${JSON.stringify(
        pluginConfig.relativeAssetsBuildDirectory
      )};
      ${
        pluginConfig.future
          ? `export const future = ${JSON.stringify(pluginConfig.future)}`
          : ""
      };
      export const publicPath = ${JSON.stringify(pluginConfig.publicPath)};
      export const entry = { module: entryServer };
      export const routes = {
        ${Object.keys(pluginConfig.routes)
          .map((key, index) => {
            let route = pluginConfig.routes[key]!;
            return `${JSON.stringify(key)}: {
          id: ${JSON.stringify(route.id)},
          parentId: ${JSON.stringify(route.parentId)},
          path: ${JSON.stringify(route.path)},
          index: ${JSON.stringify(route.index)},
          caseSensitive: ${JSON.stringify(route.caseSensitive)},
          module: route${index}
        }`;
          })
          .join(",\n  ")}
      };`;
  };

  let loadViteManifest = async (directory: string) => {
    let manifestPath = isViteV4
      ? "manifest.json"
      : path.join(".vite", "manifest.json");
    let manifestContents = await fse.readFile(
      path.resolve(directory, manifestPath),
      "utf-8"
    );
    return JSON.parse(manifestContents) as Vite.Manifest;
  };

  let createBuildManifest = async (): Promise<Manifest> => {
    let pluginConfig = await resolvePluginConfig();

    let viteManifest = await loadViteManifest(
      pluginConfig.assetsBuildDirectory
    );

    let entry: Manifest["entry"] = resolveBuildAssetPaths(
      pluginConfig,
      viteManifest,
      pluginConfig.entryClientFilePath
    );

    let routes: Manifest["routes"] = {};
    for (let [key, route] of Object.entries(pluginConfig.routes)) {
      let routeFilePath = path.join(pluginConfig.appDirectory, route.file);
      let sourceExports = await getRouteModuleExports(
        viteChildCompiler,
        pluginConfig,
        route.file
      );

      routes[key] = {
        id: route.id,
        parentId: route.parentId,
        path: route.path,
        index: route.index,
        caseSensitive: route.caseSensitive,
        hasAction: sourceExports.includes("action"),
        hasLoader: sourceExports.includes("loader"),
        hasErrorBoundary: sourceExports.includes("ErrorBoundary"),
        ...resolveBuildAssetPaths(pluginConfig, viteManifest, routeFilePath),
      };
    }

    let fingerprintedValues = { entry, routes };
    let version = getHash(JSON.stringify(fingerprintedValues), 8);
    let manifestPath = `assets/manifest-${version}.js`;
    let url = `${pluginConfig.publicPath}${manifestPath}`;
    let nonFingerprintedValues = { url, version };

    let manifest: Manifest = {
      ...fingerprintedValues,
      ...nonFingerprintedValues,
    };

    await writeFileSafe(
      path.join(pluginConfig.assetsBuildDirectory, manifestPath),
      `window.__remixManifest=${JSON.stringify(manifest)};`
    );

    return manifest;
  };

  let getDevManifest = async (): Promise<Manifest> => {
    let pluginConfig = await resolvePluginConfig();
    let routes: Manifest["routes"] = {};

    for (let [key, route] of Object.entries(pluginConfig.routes)) {
      let sourceExports = await getRouteModuleExports(
        viteChildCompiler,
        pluginConfig,
        route.file
      );

      routes[key] = {
        id: route.id,
        parentId: route.parentId,
        path: route.path,
        index: route.index,
        caseSensitive: route.caseSensitive,
        module: `${resolveFileUrl(
          pluginConfig,
          resolveRelativeRouteFilePath(route, pluginConfig)
        )}${
          isJsFile(route.file) ? "" : "?import" // Ensure the Vite dev server responds with a JS module
        }`,
        hasAction: sourceExports.includes("action"),
        hasLoader: sourceExports.includes("loader"),
        hasErrorBoundary: sourceExports.includes("ErrorBoundary"),
        imports: [],
      };
    }

    return {
      version: String(Math.random()),
      url: VirtualModule.url(browserManifestId),
      hmr: {
        runtime: VirtualModule.url(injectHmrRuntimeId),
      },
      entry: {
        module: resolveFileUrl(pluginConfig, pluginConfig.entryClientFilePath),
        imports: [],
      },
      routes,
    };
  };

  return [
    {
      name: "remix",
      config: async (_viteUserConfig, viteConfigEnv) => {
        // Load Vite's ESM build up-front as soon as we're in an async context
        vite = await import("vite");

        viteUserConfig = _viteUserConfig;
        viteCommand = viteConfigEnv.command;

        let pluginConfig = await resolvePluginConfig();
        cachedPluginConfig = pluginConfig;

        Object.assign(
          process.env,
          vite.loadEnv(
            viteConfigEnv.mode,
            pluginConfig.rootDirectory,
            // We override default prefix of "VITE_" with a blank string since
            // we're targeting the server, so we want to load all environment
            // variables, not just those explicitly marked for the client
            ""
          )
        );

        let isSsrBuild =
          "ssrBuild" in viteConfigEnv &&
          typeof viteConfigEnv.ssrBuild === "boolean"
            ? viteConfigEnv.ssrBuild // Vite v4 back compat
            : viteConfigEnv.isSsrBuild;

        return {
          appType: "custom",
          experimental: { hmrPartialAccept: true },
          optimizeDeps: {
            include: [
              // Pre-bundle React dependencies to avoid React duplicates,
              // even if React dependencies are not direct dependencies.
              // https://react.dev/warnings/invalid-hook-call-warning#duplicate-react
              "react",
              "react/jsx-runtime",
              "react/jsx-dev-runtime",
              "react-dom/client",

              // Pre-bundle Remix dependencies to avoid Remix router duplicates.
              // Our remix-remix-react-proxy plugin does not process default client and
              // server entry files since those come from within `node_modules`.
              // That means that before Vite pre-bundles dependencies (e.g. first time dev server is run)
              // mismatching Remix routers cause `Error: You must render this element inside a <Remix> element`.
              "@remix-run/react",
            ],
          },
          esbuild: {
            jsx: "automatic",
            jsxDev: viteCommand !== "build",
          },
          resolve: {
            dedupe: [
              // https://react.dev/warnings/invalid-hook-call-warning#duplicate-react
              "react",
              "react-dom",

              // see description for `@remix-run/react` in `optimizeDeps.include`
              "@remix-run/react",
            ],
          },
          ...(viteCommand === "build" && {
            base: pluginConfig.publicPath,
            build: {
              ...viteUserConfig.build,
              ...(!isSsrBuild
                ? {
                    manifest: true,
                    outDir: pluginConfig.assetsBuildDirectory,
                    rollupOptions: {
                      ...viteUserConfig.build?.rollupOptions,
                      preserveEntrySignatures: "exports-only",
                      input: [
                        pluginConfig.entryClientFilePath,
                        ...Object.values(pluginConfig.routes).map((route) =>
                          path.resolve(pluginConfig.appDirectory, route.file)
                        ),
                      ],
                    },
                  }
                : {
                    // We move SSR-only assets to client assets. Note that the
                    // SSR build can also emit code-split JS files (e.g. by
                    // dynamic import) under the same assets directory
                    // regardless of "ssrEmitAssets" option, so we also need to
                    // keep these JS files have to be kept as-is.
                    ssrEmitAssets: true,
                    copyPublicDir: false, // Assets in the public directory are only used by the client
                    manifest: true, // We need the manifest to detect SSR-only assets
                    outDir: path.dirname(pluginConfig.serverBuildPath),
                    rollupOptions: {
                      ...viteUserConfig.build?.rollupOptions,
                      preserveEntrySignatures: "exports-only",
                      input: serverEntryId,
                      output: {
                        entryFileNames: path.basename(
                          pluginConfig.serverBuildPath
                        ),
                        format: pluginConfig.serverModuleFormat,
                      },
                    },
                  }),
            },
          }),
        };
      },
      async configResolved(viteConfig) {
        await initEsModuleLexer;

        resolvedViteConfig = viteConfig;

        ssrBuildContext =
          viteConfig.build.ssr && viteCommand === "build"
            ? { isSsrBuild: true, getManifest: createBuildManifest }
            : { isSsrBuild: false };

        // We load the same Vite config file again for the child compiler so
        // that both parent and child compiler's plugins have independent state.
        // If we re-used the `viteUserConfig.plugins` array for the child
        // compiler, it could lead to mutating shared state between plugin
        // instances in unexpected ways, e.g. during `vite build` the
        // `configResolved` plugin hook would be called with `command = "build"`
        // by parent and then `command = "serve"` by child, which some plugins
        // may respond to by updating state referenced by the parent.
        if (!viteConfig.configFile) {
          throw new Error(
            "The Remix Vite plugin requires the use of a Vite config file"
          );
        }
        let childCompilerConfigFile = await vite.loadConfigFromFile(
          {
            command: viteConfig.command,
            mode: viteConfig.mode,
            ...(isViteV4
              ? { ssrBuild: ssrBuildContext.isSsrBuild }
              : { isSsrBuild: ssrBuildContext.isSsrBuild }),
          },
          viteConfig.configFile
        );

        invariant(
          childCompilerConfigFile,
          "Vite config file was unable to be resolved for Remix child compiler"
        );

        viteChildCompiler = await vite.createServer({
          ...viteUserConfig,
          mode: viteConfig.mode,
          server: {
            ...viteUserConfig.server,
            // when parent compiler runs in middleware mode to support
            // custom servers, we don't want the child compiler also
            // run in middleware mode as that will cause websocket port conflicts
            middlewareMode: false,
          },
          configFile: false,
          envFile: false,
          plugins: [
            ...(childCompilerConfigFile.config.plugins ?? [])
              .flat()
              // Exclude this plugin from the child compiler to prevent an
              // infinite loop (plugin creates a child compiler with the same
              // plugin that creates another child compiler, repeat ad
              // infinitum), and to prevent the manifest from being written to
              // disk from the child compiler. This is important in the
              // production build because the child compiler is a Vite dev
              // server and will generate incorrect manifests.
              .filter(
                (plugin) =>
                  typeof plugin === "object" &&
                  plugin !== null &&
                  "name" in plugin &&
                  plugin.name !== "remix" &&
                  plugin.name !== "remix-hmr-updates"
              ),
            {
              name: "no-hmr",
              handleHotUpdate() {
                // parent vite server is already sending HMR updates
                // do not send duplicate HMR updates from child server
                // which log confusing "page reloaded" messages that aren't true
                return [];
              },
            },
          ],
        });
        await viteChildCompiler.pluginContainer.buildStart({});
      },
      transform(code, id) {
        if (isCssModulesFile(id)) {
          cssModulesManifest[id] = code;
        }
      },
      buildStart() {
        if (viteCommand === "build") {
          showUnstableWarning();
        }
      },
      configureServer(vite) {
        vite.httpServer?.on("listening", () => {
          setTimeout(showUnstableWarning, 50);
        });

        // We cache the pluginConfig here to make sure we're only invalidating virtual modules when necessary.
        // This requires a separate cache from `cachedPluginConfig`, which is updated by remix-hmr-updates. If
        // we shared the cache, it would already be refreshed by remix-hmr-updates at this point, and we'd
        // have no way of comparing against the cache to know if the virtual modules need to be invalidated.
        let previousPluginConfig: ResolvedRemixVitePluginConfig | undefined;

        let localsByRequest = new WeakMap<
          Vite.Connect.IncomingMessage,
          {
            build: ServerBuild;
            criticalCss: string | undefined;
          }
        >();

        return () => {
          vite.middlewares.use(async (req, res, next) => {
            try {
              let pluginConfig = await resolvePluginConfig();

              if (
                JSON.stringify(pluginConfig) !==
                JSON.stringify(previousPluginConfig)
              ) {
                previousPluginConfig = pluginConfig;

                // Invalidate all virtual modules
                vmods.forEach((vmod) => {
                  let mod = vite.moduleGraph.getModuleById(
                    VirtualModule.resolve(vmod)
                  );

                  if (mod) {
                    vite.moduleGraph.invalidateModule(mod);
                  }
                });
              }
              let { url } = req;
              let build = await (vite.ssrLoadModule(
                serverEntryId
              ) as Promise<ServerBuild>);

              let criticalCss = await getStylesForUrl(
                vite,
                pluginConfig,
                cssModulesManifest,
                build,
                url
              );

              localsByRequest.set(req, {
                build,
                criticalCss,
              });

              // If the middleware is being used in Express, the "res.locals"
              // object (https://expressjs.com/en/api.html#res.locals) will be
              // present. If so, we attach the critical CSS as metadata to the
              // response object so the Remix Express adapter has access to it.
              if (
                "locals" in res &&
                typeof res.locals === "object" &&
                res.locals !== null
              ) {
                (res.locals as Record<string, any>).__remixDevCriticalCss =
                  criticalCss;
              }

              next();
            } catch (error) {
              next(error);
            }
          });

          // Let user servers handle SSR requests in middleware mode,
          // otherwise the Vite plugin will handle the request
          if (!vite.config.server.middlewareMode) {
            vite.middlewares.use(async (req, res, next) => {
              try {
                let pluginConfig = await resolvePluginConfig();
                let locals = localsByRequest.get(req);
                invariant(locals, "No Remix locals found for request");

                let { build, criticalCss } = locals;

                let handle = createRequestHandler(
                  build,
                  {
                    mode: "development",
                    criticalCss,
                  },
                  pluginConfig.devLoadContext
                );

                await handle(req, res);
              } catch (error) {
                next(error);
              }
            });
          }
        };
      },
      writeBundle: {
        // After the SSR build is finished, we inspect the Vite manifest for
        // the SSR build and move server-only assets to client assets directory
        async handler() {
          if (!ssrBuildContext.isSsrBuild) {
            return;
          }

          invariant(
            cachedPluginConfig,
            "Expected plugin config to be cached when writeBundle hook is called"
          );

          invariant(
            resolvedViteConfig,
            "Expected resolvedViteConfig to exist when writeBundle hook is called"
          );

          let { assetsBuildDirectory, serverBuildPath, rootDirectory } =
            cachedPluginConfig;
          let serverBuildDir = path.dirname(serverBuildPath);

          let ssrViteManifest = await loadViteManifest(serverBuildDir);
          let clientViteManifest = await loadViteManifest(assetsBuildDirectory);

          let clientAssetPaths = new Set(
            Object.values(clientViteManifest).flatMap(
              (chunk) => chunk.assets ?? []
            )
          );

          let ssrAssetPaths = new Set(
            Object.values(ssrViteManifest).flatMap(
              (chunk) => chunk.assets ?? []
            )
          );

          // We only move assets that aren't in the client build, otherwise we
          // remove them. These assets only exist because we explicitly set
          // `ssrEmitAssets: true` in the SSR Vite config. These assets
          // typically wouldn't exist by default, which is why we assume it's
          // safe to remove them. We're aiming for a clean build output so that
          // unnecessary assets don't get deployed alongside the server code.
          let movedAssetPaths: string[] = [];
          for (let ssrAssetPath of ssrAssetPaths) {
            let src = path.join(serverBuildDir, ssrAssetPath);
            if (!clientAssetPaths.has(ssrAssetPath)) {
              let dest = path.join(assetsBuildDirectory, ssrAssetPath);
              await fse.move(src, dest);
              movedAssetPaths.push(dest);
            } else {
              await fse.remove(src);
            }
          }

          // We assume CSS files from the SSR build are unnecessary and remove
          // them for the same reasons as above.
          let ssrCssPaths = Object.values(ssrViteManifest).flatMap(
            (chunk) => chunk.css ?? []
          );
          await Promise.all(
            ssrCssPaths.map((cssPath) =>
              fse.remove(path.join(serverBuildDir, cssPath))
            )
          );

          let logger = resolvedViteConfig.logger;

          if (movedAssetPaths.length) {
            logger.info(
              [
                "",
                `${colors.green("✓")} ${movedAssetPaths.length} asset${
                  movedAssetPaths.length > 1 ? "s" : ""
                } moved from Remix server build to client assets.`,
                ...movedAssetPaths.map((movedAssetPath) =>
                  colors.dim(path.relative(rootDirectory, movedAssetPath))
                ),
                "",
              ].join("\n")
            );
          }
        },
      },
      async buildEnd() {
        await viteChildCompiler?.close();
      },
    },
    {
      name: "remix-virtual-modules",
      enforce: "pre",
      resolveId(id) {
        if (vmods.includes(id)) return VirtualModule.resolve(id);
      },
      async load(id) {
        switch (id) {
          case VirtualModule.resolve(serverEntryId): {
            return await getServerEntry();
          }
          case VirtualModule.resolve(serverManifestId): {
            let manifest = ssrBuildContext.isSsrBuild
              ? await ssrBuildContext.getManifest()
              : await getDevManifest();

            return `export default ${jsesc(manifest, { es6: true })};`;
          }
          case VirtualModule.resolve(browserManifestId): {
            if (viteCommand === "build") {
              throw new Error("This module only exists in development");
            }

            let manifest = await getDevManifest();

            return `window.__remixManifest=${jsesc(manifest, { es6: true })};`;
          }
        }
      },
    },
    {
      name: "remix-empty-server-modules",
      enforce: "pre",
      async transform(_code, id, options) {
        if (!options?.ssr && /\.server(\.[cm]?[jt]sx?)?$/.test(id))
          return {
            code: "export default {}",
            map: null,
          };
      },
    },
    {
      name: "remix-empty-client-modules",
      enforce: "pre",
      async transform(_code, id, options) {
        if (options?.ssr && /\.client(\.[cm]?[jt]sx?)?$/.test(id))
          return {
            code: "export default {}",
            map: null,
          };
      },
    },
    {
      name: "remix-remove-server-exports",
      enforce: "post", // Ensure we're operating on the transformed code to support MDX etc.
      async transform(code, id, options) {
        if (options?.ssr) return;

        let pluginConfig = cachedPluginConfig || (await resolvePluginConfig());

        let route = getRoute(pluginConfig, id);
        if (!route) return;

        let serverExports = ["loader", "action", "headers"];

        return {
          code: removeExports(code, serverExports),
          map: null,
        };
      },
    },
    {
      name: "remix-remix-react-proxy",
      enforce: "post", // Ensure we're operating on the transformed code to support MDX etc.
      resolveId(id) {
        if (id === remixReactProxyId) {
          return VirtualModule.resolve(remixReactProxyId);
        }
      },
      transform(code, id) {
        // Don't transform the proxy itself, otherwise it will import itself
        if (id === VirtualModule.resolve(remixReactProxyId)) {
          return;
        }

        let hasLiveReloadHints =
          code.includes("LiveReload") && code.includes("@remix-run/react");

        // Don't transform files that don't need the proxy
        if (!hasLiveReloadHints) {
          return;
        }

        // Rewrite imports to use the proxy
        return replaceImportSpecifier({
          code,
          specifier: "@remix-run/react",
          replaceWith: remixReactProxyId,
        });
      },
      load(id) {
        if (id === VirtualModule.resolve(remixReactProxyId)) {
          // TODO: ensure react refresh is initialized before `<Scripts />`
          return [
            'import { createElement } from "react";',
            'export * from "@remix-run/react";',
            `export const LiveReload = ${
              viteCommand !== "serve"
            } ? () => null : `,
            '({ nonce = undefined }) => createElement("script", {',
            "  nonce,",
            "  dangerouslySetInnerHTML: { ",
            "    __html: `window.__remixLiveReloadEnabled = true`",
            "  }",
            "});",
          ].join("\n");
        }
      },
    },
    {
      name: "remix-inject-hmr-runtime",
      enforce: "pre",
      resolveId(id) {
        if (id === injectHmrRuntimeId)
          return VirtualModule.resolve(injectHmrRuntimeId);
      },
      async load(id) {
        if (id !== VirtualModule.resolve(injectHmrRuntimeId)) return;

        return [
          `import RefreshRuntime from "${hmrRuntimeId}"`,
          "RefreshRuntime.injectIntoGlobalHook(window)",
          "window.$RefreshReg$ = () => {}",
          "window.$RefreshSig$ = () => (type) => type",
          "window.__vite_plugin_react_preamble_installed__ = true",
        ].join("\n");
      },
    },
    {
      name: "remix-hmr-runtime",
      enforce: "pre",
      resolveId(id) {
        if (id === hmrRuntimeId) return VirtualModule.resolve(hmrRuntimeId);
      },
      async load(id) {
        if (id !== VirtualModule.resolve(hmrRuntimeId)) return;

        let reactRefreshDir = path.dirname(
          require.resolve("react-refresh/package.json")
        );
        let reactRefreshRuntimePath = path.join(
          reactRefreshDir,
          "cjs/react-refresh-runtime.development.js"
        );

        return [
          "const exports = {}",
          await fse.readFile(reactRefreshRuntimePath, "utf8"),
          await fse.readFile(
            require.resolve("./static/refresh-utils.cjs"),
            "utf8"
          ),
          "export default exports",
        ].join("\n");
      },
    },
    {
      name: "remix-react-refresh-babel",
      enforce: "post",
      async transform(code, id, options) {
        if (viteCommand !== "serve") return;
        if (id.includes("/node_modules/")) return;

        let [filepath] = id.split("?");
        if (!/.[tj]sx?$/.test(filepath)) return;

        let devRuntime = "react/jsx-dev-runtime";
        let ssr = options?.ssr === true;
        let isJSX = filepath.endsWith("x");
        let useFastRefresh = !ssr && (isJSX || code.includes(devRuntime));
        if (!useFastRefresh) return;

        let result = await babel.transformAsync(code, {
          filename: id,
          sourceFileName: filepath,
          parserOpts: {
            sourceType: "module",
            allowAwaitOutsideFunction: true,
            plugins: ["jsx", "typescript"],
          },
          plugins: [[require("react-refresh/babel"), { skipEnvCheck: true }]],
          sourceMaps: true,
        });
        if (result === null) return;

        code = result.code!;
        let refreshContentRE = /\$Refresh(?:Reg|Sig)\$\(/;
        if (refreshContentRE.test(code)) {
          let pluginConfig =
            cachedPluginConfig || (await resolvePluginConfig());
          code = addRefreshWrapper(pluginConfig, code, id);
        }
        return { code, map: result.map };
      },
    },
    {
      name: "remix-hmr-updates",
      async handleHotUpdate({ server, file, modules }) {
        let pluginConfig = await resolvePluginConfig();
        // Update the config cache any time there is a file change
        cachedPluginConfig = pluginConfig;
        let route = getRoute(pluginConfig, file);

        server.ws.send({
          type: "custom",
          event: "remix:hmr",
          data: {
            route: route
              ? await getRouteMetadata(pluginConfig, viteChildCompiler, route)
              : null,
          },
        });

        return modules;
      },
    },
  ];
};

function addRefreshWrapper(
  pluginConfig: ResolvedRemixVitePluginConfig,
  code: string,
  id: string
): string {
  let isRoute = getRoute(pluginConfig, id);
  let acceptExports = isRoute
    ? ["handle", "meta", "links", "shouldRevalidate"]
    : [];
  return (
    REACT_REFRESH_HEADER.replace("__SOURCE__", JSON.stringify(id)) +
    code +
    REACT_REFRESH_FOOTER.replace("__SOURCE__", JSON.stringify(id)).replace(
      "__ACCEPT_EXPORTS__",
      JSON.stringify(acceptExports)
    )
  );
}

const REACT_REFRESH_HEADER = `
import RefreshRuntime from "${hmrRuntimeId}";

const inWebWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
let prevRefreshReg;
let prevRefreshSig;

if (import.meta.hot && !inWebWorker && window.__remixLiveReloadEnabled) {
  if (!window.__vite_plugin_react_preamble_installed__) {
    throw new Error(
      "Remix Vite plugin can't detect preamble. Something is wrong."
    );
  }

  prevRefreshReg = window.$RefreshReg$;
  prevRefreshSig = window.$RefreshSig$;
  window.$RefreshReg$ = (type, id) => {
    RefreshRuntime.register(type, __SOURCE__ + " " + id)
  };
  window.$RefreshSig$ = RefreshRuntime.createSignatureFunctionForTransform;
}`.replace(/\n+/g, "");

const REACT_REFRESH_FOOTER = `
if (import.meta.hot && !inWebWorker && window.__remixLiveReloadEnabled) {
  window.$RefreshReg$ = prevRefreshReg;
  window.$RefreshSig$ = prevRefreshSig;
  RefreshRuntime.__hmr_import(import.meta.url).then((currentExports) => {
    RefreshRuntime.registerExportsForReactRefresh(__SOURCE__, currentExports);
    import.meta.hot.accept((nextExports) => {
      if (!nextExports) return;
      const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate(currentExports, nextExports, __ACCEPT_EXPORTS__);
      if (invalidateMessage) import.meta.hot.invalidate(invalidateMessage);
    });
  });
}`;

function getRoute(
  pluginConfig: ResolvedRemixVitePluginConfig,
  file: string
): Route | undefined {
  if (!file.startsWith(vite.normalizePath(pluginConfig.appDirectory))) return;
  let routePath = vite.normalizePath(
    path.relative(pluginConfig.appDirectory, file)
  );
  let route = Object.values(pluginConfig.routes).find(
    (r) => r.file === routePath
  );
  return route;
}

async function getRouteMetadata(
  pluginConfig: ResolvedRemixVitePluginConfig,
  viteChildCompiler: Vite.ViteDevServer | null,
  route: Route
) {
  let sourceExports = await getRouteModuleExports(
    viteChildCompiler,
    pluginConfig,
    route.file
  );

  let info = {
    id: route.id,
    parentId: route.parentId,
    path: route.path,
    index: route.index,
    caseSensitive: route.caseSensitive,
    url:
      "/" +
      path.relative(
        pluginConfig.rootDirectory,
        resolveRelativeRouteFilePath(route, pluginConfig)
      ),
    module: `${resolveFileUrl(
      pluginConfig,
      resolveRelativeRouteFilePath(route, pluginConfig)
    )}?import`, // Ensure the Vite dev server responds with a JS module
    hasAction: sourceExports.includes("action"),
    hasLoader: sourceExports.includes("loader"),
    hasErrorBoundary: sourceExports.includes("ErrorBoundary"),
    imports: [],
  };
  return info;
}
