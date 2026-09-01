import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import * as tar from "tar-stream";

const ROOT = dirname(import.meta.dir);
const DEFAULT_OUTPUT = join(ROOT, "public", "v1", "catalog.json");
const USER_AGENT = "mihomo-router-catalog";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_RELEASE_JSON_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

type ComponentKey = "mihomo" | "metacubexd";
type ComponentKind = "core" | "dashboard";

export class CatalogError extends Error {}

export interface Component {
  key: ComponentKey;
  label: string;
  repository: string;
  assetTemplate: string;
  archiveLimit: number;
  extractedLimit: number;
  kind: ComponentKind;
}

export interface CatalogEntry {
  version: string;
  url: string;
  size: number;
  sha256: string;
}

export interface Catalog {
  schema_version: 1;
  updated_at: string;
  components: Record<ComponentKey, CatalogEntry>;
}

interface ReleaseAsset {
  version: string;
  url: string;
  size: number;
}

interface CandidateResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const COMPONENTS: readonly Component[] = [
  {
    key: "mihomo",
    label: "Mihomo",
    repository: "MetaCubeX/mihomo",
    assetTemplate: "mihomo-linux-amd64-v{version}.gz",
    archiveLimit: 64 * 1024 * 1024,
    extractedLimit: 128 * 1024 * 1024,
    kind: "core",
  },
  {
    key: "metacubexd",
    label: "MetaCubeXD",
    repository: "MetaCubeX/metacubexd",
    assetTemplate: "compressed-dist.tgz",
    archiveLimit: 32 * 1024 * 1024,
    extractedLimit: 128 * 1024 * 1024,
    kind: "dashboard",
  },
];

export const COMPONENTS_BY_KEY = Object.fromEntries(
  COMPONENTS.map((component) => [component.key, component]),
) as Record<ComponentKey, Component>;

export function assetName(component: Component, version: string): string {
  return component.assetTemplate.replace("{version}", version);
}

export function assetUrl(component: Component, version: string): string {
  return `https://github.com/${component.repository}/releases/download/v${version}/${assetName(component, version)}`;
}

export function normalizeVersion(value: unknown): string {
  if (typeof value !== "string") {
    throw new CatalogError("release version must be a string");
  }
  const version = value.startsWith("v") ? value.slice(1) : value;
  if (!VERSION_RE.test(version)) {
    throw new CatalogError(`unsupported release version: ${JSON.stringify(value)}`);
  }
  return version;
}

export function selectReleaseAsset(
  component: Component,
  value: unknown,
): ReleaseAsset {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogError(`${component.label} release must be an object`);
  }
  const release = value as Record<string, unknown>;
  if (release.draft !== false || release.prerelease !== false) {
    throw new CatalogError(`refusing draft or prerelease ${component.label} release`);
  }
  const version = normalizeVersion(release.tag_name);
  if (!Array.isArray(release.assets)) {
    throw new CatalogError(`${component.label} release assets must be an array`);
  }
  const expectedName = assetName(component, version);
  const matches = release.assets.filter((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return false;
    }
    return (candidate as Record<string, unknown>).name === expectedName;
  });
  if (matches.length !== 1) {
    throw new CatalogError(
      `${component.label} release v${version} must contain exactly one ${expectedName} asset`,
    );
  }
  const selected = matches[0] as Record<string, unknown>;
  if (!Number.isSafeInteger(selected.size)) {
    throw new CatalogError(`${component.label} asset size must be an integer`);
  }
  const size = selected.size as number;
  if (size <= 0 || size > component.archiveLimit) {
    throw new CatalogError(
      `${component.label} asset size ${size} is outside the allowed range`,
    );
  }
  const url = selected.browser_download_url;
  if (url !== assetUrl(component, version)) {
    throw new CatalogError(
      `${component.label} asset URL is not the expected official release URL`,
    );
  }
  return { version, url, size };
}

async function fetchLatestRelease(
  component: Component,
  token: string | undefined,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "Accept-Encoding": "identity",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchChecked(
    `https://api.github.com/repos/${component.repository}/releases/latest`,
    `${component.repository} latest release`,
    headers,
    60_000,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_RELEASE_JSON_BYTES) {
    throw new CatalogError(
      `${component.repository} latest release exceeds ${MAX_RELEASE_JSON_BYTES} bytes`,
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new CatalogError(
      `invalid JSON from ${component.repository} latest release: ${errorMessage(error)}`,
    );
  }
}

async function fetchChecked(
  url: string,
  label: string,
  headers: Record<string, string>,
  timeout: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new CatalogError(`${label} request failed: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 4096);
    throw new CatalogError(
      `${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return response;
}

async function downloadAsset(
  component: Component,
  release: ReleaseAsset,
  destination: string,
): Promise<string> {
  const response = await fetchChecked(
    release.url,
    `${component.label} asset`,
    {
      Accept: "application/octet-stream",
      "Accept-Encoding": "identity",
      "User-Agent": USER_AGENT,
    },
    180_000,
  );
  if (!response.body) {
    throw new CatalogError(`${component.label} asset response has no body`);
  }
  await mkdir(dirname(destination), { recursive: true });
  const reader = response.body.getReader();
  const writer = Bun.file(destination).writer({ highWaterMark: CHUNK_BYTES });
  const digest = createHash("sha256");
  let downloaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.length;
      if (downloaded > component.archiveLimit) {
        throw new CatalogError(
          `${component.label} asset exceeds ${component.archiveLimit} bytes`,
        );
      }
      digest.update(value);
      writer.write(value);
    }
  } finally {
    writer.end();
    reader.releaseLock();
  }
  if (downloaded !== release.size) {
    throw new CatalogError(
      `${component.label} asset size mismatch: expected ${release.size}, got ${downloaded}`,
    );
  }
  return digest.digest("hex");
}

export async function validateCore(
  component: Component,
  archive: string,
  version: string,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mihomo-catalog-core-"));
  try {
    let binary: Uint8Array;
    try {
      binary = Bun.gunzipSync(await Bun.file(archive).bytes());
    } catch (error) {
      throw new CatalogError(
        `invalid ${component.label} gzip archive: ${errorMessage(error)}`,
      );
    }
    if (binary.length === 0 || binary.length > component.extractedLimit) {
      throw new CatalogError(`${component.label} binary size is outside the allowed range`);
    }
    const binaryPath = join(root, "mihomo");
    await Bun.write(binaryPath, binary);
    await chmod(binaryPath, 0o755);

    const versionResult = await runCandidate([binaryPath, "-v"], root, 30_000);
    const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
    if (versionResult.exitCode !== 0) {
      throw new CatalogError(
        `${component.label} -v failed with exit ${versionResult.exitCode}: ${shortOutput(versionOutput)}`,
      );
    }
    if (!versionOutput.includes("Mihomo") || !versionOutput.includes(version)) {
      throw new CatalogError(
        `${component.label} -v output does not identify v${version}: ${shortOutput(versionOutput)}`,
      );
    }

    const configPath = join(root, "config.yaml");
    await Bun.write(
      configPath,
      "mixed-port: 7890\n" +
        "allow-lan: false\n" +
        "mode: rule\n" +
        "log-level: silent\n" +
        "ipv6: false\n" +
        "proxies: []\n" +
        "proxy-groups: []\n" +
        "rules:\n" +
        "  - MATCH,DIRECT\n",
    );
    const dataPath = join(root, "data");
    await mkdir(dataPath);
    const testResult = await runCandidate(
      [binaryPath, "-t", "-d", dataPath, "-f", configPath],
      root,
      60_000,
    );
    if (testResult.exitCode !== 0) {
      throw new CatalogError(
        `${component.label} -t failed with exit ${testResult.exitCode}: ${shortOutput(`${testResult.stdout}\n${testResult.stderr}`)}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function validateDashboard(
  component: Component,
  archive: string,
): Promise<void> {
  let unpacked: Uint8Array;
  try {
    unpacked = Bun.gunzipSync(await Bun.file(archive).bytes());
  } catch (error) {
    throw new CatalogError(
      `invalid ${component.label} gzip archive: ${errorMessage(error)}`,
    );
  }

  const extract = tar.extract();
  let entries = 0;
  let total = 0;
  let indexFound = false;
  const consume = (async () => {
    for await (const entry of extract) {
      const { header } = entry;
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) {
        throw new CatalogError(
          `${component.label} archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`,
        );
      }
      const parts = header.name.split("/").filter((part) => part !== "" && part !== ".");
      if (isAbsolute(header.name) || parts.includes("..")) {
        throw new CatalogError(`unsafe archive path: ${JSON.stringify(header.name)}`);
      }
      const relative = parts.join("/");
      if (header.type === "directory") {
        entry.resume();
        continue;
      }
      if (header.type !== "file") {
        throw new CatalogError(
          `${component.label} archive contains unsupported entry ${header.name}`,
        );
      }
      total += header.size;
      if (total > component.extractedLimit) {
        throw new CatalogError(
          `${component.label} archive expands beyond ${component.extractedLimit} bytes`,
        );
      }
      let actual = 0;
      for await (const chunk of entry) {
        if (!(chunk instanceof Uint8Array)) {
          throw new CatalogError(`${component.label} archive entry ${header.name} is invalid`);
        }
        actual += chunk.length;
      }
      if (actual !== header.size) {
        throw new CatalogError(
          `${component.label} archive entry ${header.name} is truncated`,
        );
      }
      if (relative === "index.html") {
        if (actual === 0) {
          throw new CatalogError(`${component.label} archive contains an empty index.html`);
        }
        indexFound = true;
      }
    }
  })();

  try {
    extract.end(unpacked);
    await consume;
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError(
      `invalid ${component.label} tar archive: ${errorMessage(error)}`,
    );
  }
  if (!indexFound) {
    throw new CatalogError(`${component.label} archive does not contain index.html`);
  }
}

export function validateCatalog(value: unknown): Catalog {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogError("catalog must be an object");
  }
  const catalog = value as Record<string, unknown>;
  requireKeys(catalog, ["schema_version", "updated_at", "components"], "catalog");
  if (catalog.schema_version !== 1) {
    throw new CatalogError(`unsupported schema version: ${JSON.stringify(catalog.schema_version)}`);
  }
  if (
    typeof catalog.updated_at !== "string" ||
    !TIMESTAMP_RE.test(catalog.updated_at) ||
    Number.isNaN(Date.parse(catalog.updated_at))
  ) {
    throw new CatalogError("invalid catalog updated_at");
  }
  if (
    typeof catalog.components !== "object" ||
    catalog.components === null ||
    Array.isArray(catalog.components)
  ) {
    throw new CatalogError("catalog components must be an object");
  }
  const rawComponents = catalog.components as Record<string, unknown>;
  requireKeys(rawComponents, ["mihomo", "metacubexd"], "catalog components");
  const components = {} as Record<ComponentKey, CatalogEntry>;
  for (const component of COMPONENTS) {
    const rawEntry = rawComponents[component.key];
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      throw new CatalogError(`${component.label} catalog entry must be an object`);
    }
    const entry = rawEntry as Record<string, unknown>;
    requireKeys(entry, ["version", "url", "size", "sha256"], `${component.label} catalog entry`);
    const version = normalizeVersion(entry.version);
    if (!Number.isSafeInteger(entry.size)) {
      throw new CatalogError(`invalid ${component.label} catalog size`);
    }
    const size = entry.size as number;
    if (size <= 0 || size > component.archiveLimit) {
      throw new CatalogError(`invalid ${component.label} catalog size`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      throw new CatalogError(`invalid ${component.label} catalog SHA-256`);
    }
    if (entry.url !== assetUrl(component, version)) {
      throw new CatalogError(`invalid ${component.label} catalog URL`);
    }
    components[component.key] = {
      version,
      url: entry.url,
      size,
      sha256: entry.sha256,
    };
  }
  return {
    schema_version: 1,
    updated_at: catalog.updated_at,
    components,
  };
}

export function ensureTransition(current: Catalog | null, candidate: Catalog): void {
  if (!current) return;
  for (const component of COMPONENTS) {
    const previous = current.components[component.key];
    const upcoming = candidate.components[component.key];
    const order = compareVersions(upcoming.version, previous.version);
    if (order < 0) {
      throw new CatalogError(
        `refusing ${component.label} regression from v${previous.version} to v${upcoming.version}`,
      );
    }
    if (order === 0 && !Bun.deepEquals(upcoming, previous, true)) {
      throw new CatalogError(
        `refusing changed ${component.label} asset for existing version v${previous.version}`,
      );
    }
  }
}

export async function loadCatalog(path: string): Promise<Catalog> {
  try {
    return validateCatalog(await Bun.file(path).json());
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError(`failed to read catalog ${path}: ${errorMessage(error)}`);
  }
}

export async function updateCatalog(
  output: string,
  token: string | undefined,
): Promise<boolean> {
  const current = (await Bun.file(output).exists()) ? await loadCatalog(output) : null;
  const root = await mkdtemp(join(tmpdir(), "mihomo-router-catalog-"));
  const components = {} as Record<ComponentKey, CatalogEntry>;
  try {
    for (const component of COMPONENTS) {
      const release = selectReleaseAsset(
        component,
        await fetchLatestRelease(component, token),
      );
      const archive = join(root, `${component.key}-${assetName(component, release.version)}`);
      const sha256 = await downloadAsset(component, release, archive);
      if (component.kind === "core") {
        await validateCore(component, archive, release.version);
      } else {
        await validateDashboard(component, archive);
      }
      components[component.key] = { ...release, sha256 };
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  if (current && Bun.deepEquals(current.components, components, true)) {
    console.log("catalog unchanged");
    return false;
  }
  const candidate: Catalog = {
    schema_version: 1,
    updated_at: new Date(Math.floor(Date.now() / 1000) * 1000)
      .toISOString()
      .replace(".000Z", "Z"),
    components,
  };
  ensureTransition(current, candidate);
  await mkdir(dirname(output), { recursive: true });
  await Bun.write(output, `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(
    `catalog updated: ${COMPONENTS.map((component) => `${component.label} v${components[component.key].version}`).join(", ")}`,
  );
  return true;
}

async function runCandidate(
  command: string[],
  cwd: string,
  timeout: number,
): Promise<CandidateResult> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "GITHUB_TOKEN") {
      environment[key] = value;
    }
  }
  environment.HOME = cwd;
  environment.NO_COLOR = "1";
  const processHandle = Bun.spawn({
    cmd: command,
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}


function requireKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!Bun.deepEquals(keys, wanted, true)) {
    throw new CatalogError(`invalid ${label} fields`);
  }
}

function shortOutput(value: string, limit = 4096): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return "no output";
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandLine(): { command: string; output: string; checkPath?: string } {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { output: { type: "string", default: DEFAULT_OUTPUT } },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0];
  if (command !== "update" && command !== "check") {
    throw new CatalogError("usage: update-catalog.ts [--output PATH] <update|check> [PATH]");
  }
  return {
    command,
    output: values.output,
    ...(positionals[1] ? { checkPath: positionals[1] } : {}),
  };
}

async function main(): Promise<void> {
  const arguments_ = commandLine();
  if (arguments_.command === "update") {
    await updateCatalog(arguments_.output, process.env.GITHUB_TOKEN);
  } else {
    const path = arguments_.checkPath ?? arguments_.output;
    await loadCatalog(path);
    console.log(`catalog valid: ${path}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`error: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
