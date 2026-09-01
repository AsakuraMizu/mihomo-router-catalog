import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar-stream";
import {
  CatalogError,
  COMPONENTS_BY_KEY,
  assetUrl,
  ensureTransition,
  selectReleaseAsset,
  validateCore,
  validateDashboard,
  type Catalog,
  type CatalogEntry,
  type Component,
} from "../scripts/update-catalog.ts";

function releasePayload(
  component: Component,
  version: string,
  url = assetUrl(component, version),
): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: component.assetTemplate.replace("{version}", version),
        size: 10,
        digest: null,
        browser_download_url: url,
      },
    ],
  };
}

function catalogEntry(
  component: Component,
  version: string,
  marker: string,
): CatalogEntry {
  return {
    version,
    url: assetUrl(component, version),
    size: 10,
    sha256: marker.repeat(64),
  };
}

function catalogDocument(mihomoVersion = "1.19.30", marker = "a"): Catalog {
  return {
    schema_version: 1,
    updated_at: "2026-09-01T00:00:00Z",
    components: {
      mihomo: catalogEntry(COMPONENTS_BY_KEY.mihomo, mihomoVersion, marker),
      metacubexd: catalogEntry(COMPONENTS_BY_KEY.metacubexd, "1.273.0", marker),
    },
  };
}

test("selects the exact asset without using the upstream digest", () => {
  const component = COMPONENTS_BY_KEY.mihomo;
  const release = releasePayload(component, "1.19.30");
  release.assets = [
    {
      name: "mihomo-linux-amd64-compatible-v1.19.30.gz",
      size: 10,
      browser_download_url: "https://example.invalid/compatible",
    },
    (release.assets as unknown[])[0],
  ];
  expect(selectReleaseAsset(component, release)).toEqual({
    version: "1.19.30",
    url: assetUrl(component, "1.19.30"),
    size: 10,
  });
});

test("rejects a non-official asset URL", () => {
  const component = COMPONENTS_BY_KEY.metacubexd;
  expect(() =>
    selectReleaseAsset(
      component,
      releasePayload(component, "1.273.0", "https://example.invalid/compressed-dist.tgz"),
    ),
  ).toThrow("official release URL");
});

test("rejects changed content for an existing version", () => {
  expect(() => ensureTransition(catalogDocument("1.19.30", "a"), catalogDocument("1.19.30", "b"))).toThrow(
    "existing version",
  );
});

test("rejects a version regression", () => {
  expect(() => ensureTransition(catalogDocument("1.19.30"), catalogDocument("1.19.29"))).toThrow(
    "regression",
  );
});

test("validates an executable Mihomo gzip", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-core-test-"));
  try {
    const archive = join(root, "mihomo.gz");
    const script = new TextEncoder().encode(
      "#!/bin/sh\n" +
        "if [ \"${1:-}\" = \"-v\" ]; then\n" +
        "  echo 'Mihomo Meta v1.2.3 linux amd64'\n" +
        "  exit 0\n" +
        "fi\n" +
        "if [ \"${1:-}\" = \"-t\" ]; then exit 0; fi\n" +
        "exit 2\n",
    );
    await Bun.write(archive, Bun.gzipSync(script));
    await validateCore(COMPONENTS_BY_KEY.mihomo, archive, "1.2.3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates a MetaCubeXD archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-dashboard-test-"));
  try {
    const archive = join(root, "dashboard.tgz");
    await writeTarGzip(archive, [
      { name: "index.html", type: "file", body: "<html>dashboard</html>" },
    ]);
    await validateDashboard(COMPONENTS_BY_KEY.metacubexd, archive);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unsafe Dashboard path", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-dashboard-test-"));
  try {
    const archive = join(root, "unsafe.tgz");
    await writeTarGzip(archive, [{ name: "../secret", type: "file", body: "secret" }]);
    await expect(validateDashboard(COMPONENTS_BY_KEY.metacubexd, archive)).rejects.toThrow(
      "unsafe archive path",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a Dashboard symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-dashboard-test-"));
  try {
    const archive = join(root, "symlink.tgz");
    await writeTarGzip(archive, [
      { name: "index.html", type: "file", body: "<html></html>" },
      {
        name: "assets/current.js",
        type: "symlink",
        linkname: "../app.js",
        body: "",
      },
    ]);
    await expect(validateDashboard(COMPONENTS_BY_KEY.metacubexd, archive)).rejects.toThrow(
      "unsupported entry",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface TarEntry {
  name: string;
  type: "file" | "symlink";
  body: string;
  linkname?: string;
}

async function writeTarGzip(path: string, entries: TarEntry[]): Promise<void> {
  const pack = tar.pack();
  const contents = collect(pack);
  for (const entry of entries) {
    const body = new TextEncoder().encode(entry.body);
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name: entry.name,
          type: entry.type,
          ...(entry.linkname ? { linkname: entry.linkname } : {}),
        },
        body,
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
  pack.finalize();
  await Bun.write(path, new Uint8Array(Bun.gzipSync(await contents)));
}

async function collect(stream: AsyncIterable<unknown>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) {
      throw new CatalogError("tar stream emitted a non-byte chunk");
    }
    const copy = new Uint8Array(chunk);
    chunks.push(copy);
    length += copy.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
