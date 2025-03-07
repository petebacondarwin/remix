import type { Writable } from "node:stream";
import path from "node:path";
import url from "node:url";
import fse from "fs-extra";
import express from "express";
import getPort from "get-port";
import dedent from "dedent";
import resolveBin from "resolve-bin";
import stripIndent from "strip-indent";
import serializeJavaScript from "serialize-javascript";
import { sync as spawnSync, spawn } from "cross-spawn";
import type { JsonObject } from "type-fest";
import type { AppConfig } from "@remix-run/dev";

import { ServerMode } from "../../build/node_modules/@remix-run/server-runtime/dist/mode.js";
import type { ServerBuild } from "../../build/node_modules/@remix-run/server-runtime/dist/index.js";
import { createRequestHandler } from "../../build/node_modules/@remix-run/server-runtime/dist/index.js";
import { createRequestHandler as createExpressHandler } from "../../build/node_modules/@remix-run/express/dist/index.js";
// @ts-ignore
import { installGlobals } from "../../build/node_modules/@remix-run/node/dist/index.js";

const TMP_DIR = path.join(process.cwd(), ".tmp", "integration");
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const viteBin = resolveBin.sync("vite");

export interface FixtureInit {
  buildStdio?: Writable;
  sourcemap?: boolean;
  files?: { [filename: string]: string };
  template?: "cf-template" | "deno-template" | "node-template";
  config?: Partial<AppConfig>;
  useRemixServe?: boolean;
  compiler?: "remix" | "vite";
}

export type Fixture = Awaited<ReturnType<typeof createFixture>>;
export type AppFixture = Awaited<ReturnType<typeof createAppFixture>>;

export const js = String.raw;
export const mdx = String.raw;
export const css = String.raw;
export function json(value: JsonObject) {
  return JSON.stringify(value, null, 2);
}

export async function createFixture(init: FixtureInit, mode?: ServerMode) {
  installGlobals();
  let projectDir = await createFixtureProject(init, mode);
  let buildPath = url.pathToFileURL(
    path.join(projectDir, "build/index.js")
  ).href;
  let app: ServerBuild = await import(buildPath);
  let handler = createRequestHandler(app, mode || ServerMode.Production);

  let requestDocument = async (href: string, init?: RequestInit) => {
    let url = new URL(href, "test://test");
    let request = new Request(url.toString(), {
      ...init,
      signal: init?.signal || new AbortController().signal,
    });
    return handler(request);
  };

  let requestData = async (
    href: string,
    routeId: string,
    init?: RequestInit
  ) => {
    init = init || {};
    init.signal = init.signal || new AbortController().signal;
    let url = new URL(href, "test://test");
    url.searchParams.set("_data", routeId);
    let request = new Request(url.toString(), init);
    return handler(request);
  };

  let postDocument = async (href: string, data: URLSearchParams | FormData) => {
    return requestDocument(href, {
      method: "POST",
      body: data,
      headers: {
        "Content-Type":
          data instanceof URLSearchParams
            ? "application/x-www-form-urlencoded"
            : "multipart/form-data",
      },
    });
  };

  let getBrowserAsset = async (asset: string) => {
    return fse.readFile(
      path.join(projectDir, "public", asset.replace(/^\//, "")),
      "utf8"
    );
  };

  return {
    projectDir,
    build: app,
    requestDocument,
    requestData,
    postDocument,
    getBrowserAsset,
    useRemixServe: init.useRemixServe,
  };
}

export async function createAppFixture(fixture: Fixture, mode?: ServerMode) {
  let startAppServer = async (): Promise<{
    port: number;
    stop: VoidFunction;
  }> => {
    if (fixture.useRemixServe) {
      return new Promise(async (accept, reject) => {
        let port = await getPort();

        let nodebin = process.argv[0];
        let serveProcess = spawn(
          nodebin,
          ["node_modules/@remix-run/serve/dist/cli.js", "build/index.js"],
          {
            env: {
              NODE_ENV: mode || "production",
              PORT: port.toFixed(0),
            },
            cwd: fixture.projectDir,
            stdio: "pipe",
          }
        );
        // Wait for `started at http://localhost:${port}` to be printed
        // and extract the port from it.
        let started = false;
        let stdout = "";
        let rejectTimeout = setTimeout(() => {
          reject(new Error("Timed out waiting for remix-serve to start"));
        }, 20000);
        serveProcess.stderr.pipe(process.stderr);
        serveProcess.stdout.on("data", (chunk) => {
          if (started) return;
          let newChunk = chunk.toString();
          stdout += newChunk;
          let match: RegExpMatchArray | null = stdout.match(
            /\[remix-serve\] http:\/\/localhost:(\d+)\s/
          );
          if (match) {
            clearTimeout(rejectTimeout);
            started = true;
            let parsedPort = parseInt(match[1], 10);

            if (port !== parsedPort) {
              reject(
                new Error(
                  `Expected remix-serve to start on port ${port}, but it started on port ${parsedPort}`
                )
              );
              return;
            }

            accept({
              stop: () => {
                serveProcess.kill();
              },
              port,
            });
          }
        });
      });
    }

    return new Promise(async (accept) => {
      let port = await getPort();
      let app = express();
      app.use(express.static(path.join(fixture.projectDir, "public")));

      app.all(
        "*",
        createExpressHandler({
          build: fixture.build,
          mode: mode || ServerMode.Production,
        })
      );

      let server = app.listen(port);

      accept({ stop: server.close.bind(server), port });
    });
  };

  let start = async () => {
    let { stop, port } = await startAppServer();

    let serverUrl = `http://localhost:${port}`;

    return {
      serverUrl,
      /**
       * Shuts down the fixture app, **you need to call this
       * at the end of a test** or `afterAll` if the fixture is initialized in a
       * `beforeAll` block. Also make sure to `app.close()` or else you'll
       * have memory leaks.
       */
      close: () => {
        return stop();
      },
    };
  };

  return start();
}

////////////////////////////////////////////////////////////////////////////////

export async function createFixtureProject(
  init: FixtureInit = {},
  mode?: ServerMode
): Promise<string> {
  let template = init.template ?? "node-template";
  let integrationTemplateDir = path.resolve(__dirname, template);
  let projectName = `remix-${template}-${Math.random().toString(32).slice(2)}`;
  let projectDir = path.join(TMP_DIR, projectName);
  let compiler = init.compiler ?? "remix";

  await fse.ensureDir(projectDir);
  await fse.copy(integrationTemplateDir, projectDir);
  await fse.copy(
    path.join(__dirname, "../../build/node_modules"),
    path.join(projectDir, "node_modules"),
    { overwrite: true }
  );
  // let remixDev = path.join(
  //   projectDir,
  //   "node_modules/@remix-run/dev/dist/cli.js"
  // );
  // await fse.chmod(remixDev, 0o755);
  // await fse.ensureSymlink(
  //   remixDev,
  //   path.join(projectDir, "node_modules/.bin/remix")
  // );
  //
  // let remixServe = path.join(
  //   projectDir,
  //   "node_modules/@remix-run/serve/dist/cli.js"
  // );
  // await fse.chmod(remixServe, 0o755);
  // await fse.ensureSymlink(
  //   remixServe,
  //   path.join(projectDir, "node_modules/.bin/remix-serve")
  // );

  await writeTestFiles(init, projectDir);

  // We update the config file *after* writing test files so that tests can provide a custom
  // `remix.config.js` file while still supporting the type-checked `config`
  // property on the fixture object. This is useful for config values that can't
  // be serialized, e.g. usage of imported functions within `remix.config.js`.
  let contents = fse.readFileSync(
    path.join(projectDir, "remix.config.js"),
    "utf-8"
  );
  if (
    init.config &&
    !contents.includes("global.INJECTED_FIXTURE_REMIX_CONFIG")
  ) {
    throw new Error(dedent`
      Cannot provide a \`config\` fixture option and a \`remix.config.js\` file
      at the same time, unless the \`remix.config.js\` file contains a reference
      to the \`global.INJECTED_FIXTURE_REMIX_CONFIG\` placeholder so it can
      accept the injected config values. Either move all config values into
      \`remix.config.js\` file, or spread the  injected config, 
      e.g. \`export default { ...global.INJECTED_FIXTURE_REMIX_CONFIG }\`.
    `);
  }
  contents = contents.replace(
    "global.INJECTED_FIXTURE_REMIX_CONFIG",
    `${serializeJavaScript(init.config ?? {})}`
  );
  fse.writeFileSync(path.join(projectDir, "remix.config.js"), contents);

  build(projectDir, init.buildStdio, init.sourcemap, mode, compiler);

  return projectDir;
}

function build(
  projectDir: string,
  buildStdio?: Writable,
  sourcemap?: boolean,
  mode?: ServerMode,
  compiler?: "remix" | "vite"
) {
  // We have a "require" instead of a dynamic import in readConfig gated
  // behind mode === ServerMode.Test to make jest happy, but that doesn't
  // work for ESM configs, those MUST be dynamic imports. So we need to
  // force the mode to be production for ESM configs when runtime mode is
  // tested.
  mode = mode === ServerMode.Test ? ServerMode.Production : mode;

  let remixBin = "node_modules/@remix-run/dev/dist/cli.js";

  let commands: string[][] =
    compiler === "vite"
      ? [
          [viteBin, "build"],
          [viteBin, "build", "--ssr"],
        ]
      : [[remixBin, "build", ...(sourcemap ? ["--sourcemap"] : [])]];

  commands.forEach((buildArgs) => {
    let buildSpawn = spawnSync("node", buildArgs, {
      cwd: projectDir,
      env: {
        ...process.env,
        NODE_ENV: mode || ServerMode.Production,
      },
    });

    // These logs are helpful for debugging. Remove comments if needed.
    // console.log("spawning node " + buildArgs.join(" ") + ":\n");
    // console.log("  STDOUT:");
    // console.log("  " + buildSpawn.stdout.toString("utf-8"));
    // console.log("  STDERR:");
    // console.log("  " + buildSpawn.stderr.toString("utf-8"));

    if (buildStdio) {
      buildStdio.write(buildSpawn.stdout.toString("utf-8"));
      buildStdio.write(buildSpawn.stderr.toString("utf-8"));
      buildStdio.end();
    }

    if (buildSpawn.error || buildSpawn.status) {
      console.error(buildSpawn.stderr.toString("utf-8"));
      throw (
        buildSpawn.error || new Error(`Build failed, check the output above`)
      );
    }
  });
}

async function writeTestFiles(init: FixtureInit, dir: string) {
  await Promise.all(
    Object.keys(init.files ?? {}).map(async (filename) => {
      let filePath = path.join(dir, filename);
      await fse.ensureDir(path.dirname(filePath));
      let file = init.files![filename];

      await fse.writeFile(filePath, stripIndent(file));
    })
  );
}
