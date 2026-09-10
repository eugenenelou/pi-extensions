/**
 * Bundle each third-party npm extension into ~/.local/share/pi/bundles/<name>/,
 * so pi loads a handful of modules instead of the packages' full dependency
 * trees. (Not under ~/.pi: pi records paths there relative to its agent dir,
 * which a codass loop profile — a different agent dir — cannot resolve.)
 *
 * pi's API packages are virtual modules of pi's loader, and that loader only
 * sees an import Node cannot resolve natively — hence the output lives outside
 * this repo and its node_modules. A bundle that big must not go through pi's
 * loader itself (it transpiles, seconds per cold start), so each extension is
 * a tiny ESM entry that imports the virtual modules and hands them to the
 * bundled CommonJS body, which Node loads natively.
 */
import { build } from "esbuild";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(homedir(), ".local", "share", "pi", "bundles");
const PACKAGES = ["pi-mcp-adapter", "pi-web-access", "pi-vetter"];
const VIRTUAL = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/oauth",
  "@earendil-works/pi-ai/providers/all",
  "typebox",
  "typebox/compile",
  "typebox/value",
];
const REGISTRY = "globalThis.__piBundleVirtual";
// The keyring's native binding cannot be bundled; it is copied beside the
// bundles, where the body's require() finds it.
const NATIVE = [
  "@napi-rs/keyring",
  `@napi-rs/keyring-${process.platform}-${process.arch}-gnu`,
];
const RESOURCES = ["skills", "prompts", "themes"] as const;
// Data files a package reads relative to its own modules; they land next to
// the body, where `import.meta.url` now points.
const ASSET_EXTENSIONS = [".json", ".wasm", ".bpf", ".pem", ".txt"];

type PackageMeta = {
  version: string;
  pi?: { extensions?: string[] } & Partial<
    Record<(typeof RESOURCES)[number], string[]>
  >;
};

const shimDir = mkdtempSync(join(tmpdir(), "pi-bundle-shims-"));
const alias: Record<string, string> = {};
for (const name of VIRTUAL) {
  const shim = join(shimDir, `${name.replace(/[@/]/g, "_")}.cjs`);
  writeFileSync(shim, `module.exports = ${REGISTRY}[${JSON.stringify(name)}];\n`);
  alias[name] = shim;
}

for (const name of PACKAGES) {
  const dir = join(ROOT, "node_modules", name);
  const meta = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ) as PackageMeta;
  const outDir = join(OUT, name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const extensions: string[] = [];
  for (const [index, entry] of (meta.pi?.extensions ?? []).entries()) {
    const body = `body-${index}.cjs`;
    await build({
      entryPoints: [join(dir, entry)],
      outfile: join(outDir, body),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      alias,
      external: ["@napi-rs/*"],
      define: { "import.meta.url": "__importMetaUrl" },
      banner: {
        js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;',
      },
      logLevel: "warning",
    });
    const bodySource = readFileSync(join(outDir, body), "utf8");
    const used = VIRTUAL.filter((name) =>
      bodySource.includes(`${REGISTRY}[${JSON.stringify(name)}]`),
    );
    const entryFile = `extension-${index}.js`;
    writeFileSync(
      join(outDir, entryFile),
      [
        ...used.map((name, i) => `import * as m${i} from ${JSON.stringify(name)};`),
        'import { createRequire } from "node:module";',
        `${REGISTRY} = Object.assign(${REGISTRY} ?? {}, {`,
        ...used.map((name, i) => `  ${JSON.stringify(name)}: m${i},`),
        "});",
        `const body = createRequire(import.meta.url)(${JSON.stringify(`./${body}`)});`,
        "export default body.default ?? body;",
        "",
      ].join("\n"),
    );
    extensions.push(`./${entryFile}`);
  }

  const assets = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !relative(dir, entry.parentPath).split("/").includes("node_modules") &&
        entry.name !== "package.json" &&
        ASSET_EXTENSIONS.some((ext) => entry.name.endsWith(ext)),
    )
    .map((entry) => join(entry.parentPath, entry.name));
  const assetNames = assets.map((asset) => asset.split("/").pop());
  if (new Set(assetNames).size !== assetNames.length)
    throw new Error(`${name}: asset basenames collide: ${assetNames.join(", ")}`);
  for (const asset of assets) cpSync(asset, join(outDir, asset.split("/").pop()!));

  const pi: Record<string, string[]> = { extensions };
  for (const kind of RESOURCES) {
    const copied: string[] = [];
    for (const [index, entry] of (meta.pi?.[kind] ?? []).entries()) {
      const target = `${kind}-${index}`;
      cpSync(join(dir, entry), join(outDir, target), { recursive: true });
      copied.push(`./${target}`);
    }
    if (copied.length > 0) pi[kind] = copied;
  }
  writeFileSync(
    join(outDir, "package.json"),
    `${JSON.stringify({ name: `${name}-bundle`, version: meta.version, type: "module", pi }, null, 2)}\n`,
  );
  console.log(`bundled ${name}@${meta.version} -> ${outDir}`);
}
rmSync(shimDir, { recursive: true, force: true });

// The platform binding is an optional dependency of the keyring package, so it
// resolves from the keyring's own location.
rmSync(join(OUT, "node_modules"), { recursive: true, force: true });
let resolveFrom = join(ROOT, "package.json");
for (const name of NATIVE) {
  const source = dirname(
    createRequire(resolveFrom).resolve(`${name}/package.json`),
  );
  cpSync(source, join(OUT, "node_modules", name), {
    recursive: true,
    dereference: true,
  });
  resolveFrom = join(source, "package.json");
}
