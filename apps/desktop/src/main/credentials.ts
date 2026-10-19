import { safeStorage } from "electron";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { DesktopError } from "@media-marshal/contracts";

export class Credentials {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<
        string,
        string
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new DesktopError(
        "STORAGE_ERROR",
        "凭据文件无法读取，请检查数据目录",
      );
    }
  }
  async configured(): Promise<{
    tmdbKeyConfigured: boolean;
    embyKeyConfigured: boolean;
  }> {
    const values = await this.read();
    return {
      tmdbKeyConfigured: Boolean(values.tmdb),
      embyKeyConfigured: Boolean(values.emby),
    };
  }
  save(kind: "tmdb" | "emby", value: string): Promise<void> {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        if (!safeStorage.isEncryptionAvailable())
          throw new DesktopError(
            "STORAGE_ERROR",
            "系统凭据保护当前不可用，请稍后重试",
          );
        const values = await this.read();
        if (value)
          values[kind] = safeStorage.encryptString(value).toString("base64");
        else delete values[kind];
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.tmp`;
        await writeFile(temporary, JSON.stringify(values), { mode: 0o600 });
        await rename(temporary, this.path);
      });
    this.queue = task;
    return task;
  }
}
