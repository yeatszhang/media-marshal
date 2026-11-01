import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CoreDatabase } from "@media-marshal/media-core";
import {
  probeManagedVolume,
  probeReadOnlyVolume,
} from "../../apps/desktop/src/main/cloud/volume-probe.ts";
import { CloudRoots } from "../../packages/media-core/dist/cloud/roots.js";
import { CloudDownloads } from "../../packages/media-core/dist/cloud/downloads.js";
import { RemoteCatalog } from "../../packages/media-core/dist/cloud/catalog.js";
import { unavailableHost } from "../../packages/media-core/dist/cloud/host-gateway.js";
import { ConfigurationDirectories } from "../../packages/media-core/dist/sources/configuration-directories.js";
import { LocalSync } from "../../packages/media-core/dist/sources/local-sync.js";
import { SyncRules } from "../../packages/media-core/dist/sources/sync-rules.js";
import { sceneBytes, sceneIdentity, type ScenarioName } from "./scenarios.ts";

export async function seedContext(
  database: CoreDatabase,
  directory: string,
  name: ScenarioName,
  seed: string,
) {
  const inputPath = join(directory, "fixture-input"),
    targetPath = join(directory, "fixture-downloads"),
    mediaPath = join(directory, "fixture-media");
  for (const path of [inputPath, targetPath, mediaPath]) await mkdir(path, { mode: 0o700 });
  const bytes = sceneBytes(name, seed),
    file = join(inputPath, "合成电影.2026.mp4");
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  const input = await probeReadOnlyVolume(inputPath, sceneIdentity(name, seed, "input"));
  const target = await probeManagedVolume(targetPath, sceneIdentity(name, seed, "downloads"));
  const media = await probeManagedVolume(mediaPath, sceneIdentity(name, seed, "media"));
  const roots = new CloudRoots(database),
    directories = new ConfigurationDirectories(database, roots);
  const downloads = new CloudDownloads(
    database,
    unavailableHost,
    new RemoteCatalog(database, unavailableHost),
    roots,
  );
  const local = new LocalSync(database, directories, roots),
    sync = new SyncRules(database, directories, downloads, local);
  try {
    await directories.authorize(input, "ordinary");
    await directories.authorize(target, "managed");
    await directories.authorize(media, "media");
    directories.setDefault({
      directoryId: target.id,
      expectedVersion: 0,
      requestKey: sceneIdentity(name, seed, "default"),
    });
  } catch (error) {
    await roots.close();
    throw error;
  }
  const close = async () => {
    await sync.close();
    await local.close();
    await downloads.close();
    await directories.close();
    await roots.close();
  };
  return {
    database,
    input,
    target,
    media,
    roots,
    directories,
    downloads,
    local,
    sync,
    bytes,
    file,
    close,
  };
}
export type SeedContext = Awaited<ReturnType<typeof seedContext>>;
