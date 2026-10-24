import {
  createApplication,
  type ApplicationModule,
} from "@yeatz/app-framework/application";
import type {} from "@yeatz/app-framework/command";
import {
  coreActions,
  DesktopError,
  parseCoreRequest,
  type CoreAction,
  type CoreInput,
  type CoreOutput,
} from "@media-marshal/contracts";
import { CoreDatabase } from "../infrastructure/database.js";
import { CoreService, DatabaseToken } from "../application/core-service.js";
import type { CoreHostGateway } from "@media-marshal/contracts/internal/rpc";
import { CloudHostToken, unavailableHost } from "../cloud/host-gateway.js";
import { CloudRepository } from "../cloud/repository.js";

declare module "@yeatz/app-framework/command" {
  interface Commands {
    "media.cloud.diagnostics": () => CoreOutput<"cloud.diagnostics">;
    "media.runtime.get": () => CoreOutput<"runtime.get">;
    "media.sources.list": () => CoreOutput<"sources.list">;
    "media.sources.save": (
      input: CoreInput<"sources.save">,
    ) => Promise<CoreOutput<"sources.save">>;
    "media.sources.pause": (
      input: CoreInput<"sources.pause">,
    ) => CoreOutput<"sources.pause">;
    "media.tasks.list": (
      input: CoreInput<"tasks.list">,
    ) => CoreOutput<"tasks.list">;
    "media.jobs.list": () => CoreOutput<"jobs.list">;
    "media.settings.get": () => CoreOutput<"settings.get">;
    "media.settings.save": (
      input: CoreInput<"settings.save">,
    ) => CoreOutput<"settings.save">;
  }
}

export function createMediaApplication(
  databasePath: string,
  extraModules: ApplicationModule[] = [],
  options: { host?: CoreHostGateway } = {},
) {
  const host: ApplicationModule = { id: "media.host", register(bind) { bind(CloudHostToken).toConstantValue(options.host ?? unavailableHost); } };
  const storage: ApplicationModule = {
    id: "media.storage",
    async start(ctx) {
      const db = await CoreDatabase.open(databasePath, undefined, { exclusiveOwner: true });
      // 取得后立即登记；下游启动失败时仍能关闭连接。
      ctx.disposables.add(() => db.close());
      ctx.container.bind(DatabaseToken).toConstantValue(db);
    },
  };
  const services: ApplicationModule = {
    id: "media.services",
    dependencies: ["media.storage"],
    register(bind) {
      bind(CoreService).toSelf().inSingletonScope();
    },
  };
  const commands: ApplicationModule = {
    id: "media.commands",
    dependencies: ["media.services"],
    start(ctx) {
      const service = ctx.get(CoreService);
      const registry = ctx.commandRegistry;
      const add = (dispose: () => void) => ctx.disposables.add(dispose);
      add(registry.register("media.cloud.diagnostics", () => new CloudRepository(ctx.get(DatabaseToken)).diagnosticCounts()));
      add(registry.register("media.runtime.get", () => service.getRuntime()));
      add(registry.register("media.sources.list", () => service.listSources()));
      add(
        registry.register("media.sources.save", (_, input) =>
          service.saveSource(coreActions["sources.save"].input.parse(input)),
        ),
      );
      add(
        registry.register("media.sources.pause", (_, input) =>
          service.pauseSource(input.id, input.paused),
        ),
      );
      add(
        registry.register("media.tasks.list", (_, input) =>
          service.listTasks(coreActions["tasks.list"].input.parse(input)),
        ),
      );
      add(registry.register("media.jobs.list", () => service.listJobs()));
      add(registry.register("media.settings.get", () => service.getSettings()));
      add(
        registry.register("media.settings.save", (_, input) =>
          service.saveSettings(coreActions["settings.save"].input.parse(input)),
        ),
      );
    },
  };
  const app = createApplication({
    modules: [host, storage, services, commands, ...extraModules],
  });
  const active = new Set<Promise<unknown>>();
  let accepting = true;
  return {
    app,
    async dispatch(value: unknown): Promise<unknown> {
      if (!accepting)
        throw new DesktopError("INTERRUPTED", "核心正在停止", true);
      const request = parseCoreRequest(value);
      // 动作来自严格契约；此映射不向 Renderer 暴露任意框架命令。
      const execute = app.commands.executeWithOptions.bind(app.commands) as (
        name: `media.${CoreAction}`,
        options: { timeout: number },
        payload: unknown,
      ) => Promise<unknown>;
      const task = execute(
        `media.${request.action}`,
        { timeout: 0 },
        request.payload,
      );
      active.add(task);
      try {
        return coreActions[request.action].output.parse(await task);
      } finally {
        active.delete(task);
      }
    },
    async stop() {
      accepting = false;
      if (app.state === "running") app.container.get(CoreService).quiesce();
      await Promise.allSettled([...active]);
      await app.stop();
    },
  };
}
