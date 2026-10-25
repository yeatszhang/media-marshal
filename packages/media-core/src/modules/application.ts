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
import { CoreService, DatabaseToken, ComponentsToken } from "../application/core-service.js";
import type { CoreHostGateway } from "@media-marshal/contracts/internal/rpc";
import { CloudHostToken, unavailableHost } from "../cloud/host-gateway.js";
import { CloudRepository } from "../cloud/repository.js";
import { RemoteCatalog } from "../cloud/catalog.js";
import { CloudAccounts } from "../cloud/accounts.js";
import { privateCoreActions, privateCoreRequestSchema } from "@media-marshal/contracts/internal/core";
import { CloudRoots } from "../cloud/roots.js";
import { managedRootGrantSchema } from "@media-marshal/contracts/internal";
import { CloudDownloads } from "../cloud/downloads.js";
import { CloudBindingValidator } from "../cloud/bindings.js";
import { CloudError, cloudFailure } from "@media-marshal/contracts";
import { CloudSubscriptions } from "../cloud/subscriptions.js";
import { IngestionOutbox, type ManagedIngestionSink } from "../cloud/outbox.js";
import type { ParserLaunch } from "@media-marshal/contracts/internal";
import { ParserProcess } from "../infrastructure/parser-process.js";
import { verifyParserResources } from "../infrastructure/parser-resources.js";
import { MediaConnections, MediaConnectionsToken } from "../application/media-connections.js";
import { IngestionPipeline } from "../ingestion/pipeline.js";
import { EmbyDelivery } from "../ingestion/emby-delivery.js";

declare module "@yeatz/app-framework/command" {
  interface Commands {
    "media.media.libraries": () => CoreOutput<"media.libraries">;
    "media.emby.configuration": () => CoreOutput<"emby.configuration">;
    "media.emby.libraries": () => Promise<CoreOutput<"emby.libraries">>;
    "media.emby.connect": (input: CoreInput<"emby.connect">) => Promise<CoreOutput<"emby.connect">>;
    "media.emby.retry": (input: CoreInput<"emby.retry">) => CoreOutput<"emby.retry">;
    "media.ingestion.candidates": (input: CoreInput<"ingestion.candidates">) => CoreOutput<"ingestion.candidates">;
    "media.ingestion.scan": (input: CoreInput<"ingestion.scan">) => Promise<CoreOutput<"ingestion.scan">>;
    "media.ingestion.recognize": (input: CoreInput<"ingestion.recognize">) => Promise<CoreOutput<"ingestion.recognize">>;
    "media.ingestion.task": (input: CoreInput<"ingestion.task">) => CoreOutput<"ingestion.task">;
    "media.ingestion.preview": (input: CoreInput<"ingestion.preview">) => Promise<CoreOutput<"ingestion.preview">>;
    "media.ingestion.confirm": (input: CoreInput<"ingestion.confirm">) => Promise<CoreOutput<"ingestion.confirm">>;
    "media.ingestion.retry": (input: CoreInput<"ingestion.retry">) => CoreOutput<"ingestion.retry">;
    "media.cloud.downloads.pause-status": () => CoreOutput<"cloud.downloads.pause-status">;
    "media.cloud.downloads.set-paused": (input: CoreInput<"cloud.downloads.set-paused">) => CoreOutput<"cloud.downloads.set-paused">;
    "media.cloud.subscriptions.configure": (input: CoreInput<"cloud.subscriptions.configure">) => CoreOutput<"cloud.subscriptions.configure">;
    "media.cloud.subscriptions.list": (input: CoreInput<"cloud.subscriptions.list">) => CoreOutput<"cloud.subscriptions.list">;
    "media.cloud.subscriptions.control": (input: CoreInput<"cloud.subscriptions.control">) => CoreOutput<"cloud.subscriptions.control">;
    "media.cloud.roots.list": () => Promise<CoreOutput<"cloud.roots.list">>;
    "media.cloud.downloads.preview": (input: CoreInput<"cloud.downloads.preview">) => CoreOutput<"cloud.downloads.preview">;
    "media.cloud.downloads.get-preview": (input: CoreInput<"cloud.downloads.get-preview">) => CoreOutput<"cloud.downloads.get-preview">;
    "media.cloud.downloads.confirm": (input: CoreInput<"cloud.downloads.confirm">) => Promise<CoreOutput<"cloud.downloads.confirm">>;
    "media.cloud.downloads.list": (input: CoreInput<"cloud.downloads.list">) => CoreOutput<"cloud.downloads.list">;
    "media.cloud.downloads.control": (input: CoreInput<"cloud.downloads.control">) => CoreOutput<"cloud.downloads.control">;
    "media.cloud.accounts.list": () => CoreOutput<"cloud.accounts.list">;
    "media.cloud.authorizations.get": (input: CoreInput<"cloud.authorizations.get">) => CoreOutput<"cloud.authorizations.get">;
    "media.cloud.remote.list": (input: CoreInput<"cloud.remote.list">) => Promise<CoreOutput<"cloud.remote.list">>;
    "media.cloud.remote.stat": (input: CoreInput<"cloud.remote.stat">) => Promise<CoreOutput<"cloud.remote.stat">>;
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
  options: { host?: CoreHostGateway; ingestion?: ManagedIngestionSink; parser?: ParserLaunch } = {},
) {
  const host: ApplicationModule = { id: "media.host", register(bind) { bind(CloudHostToken).toConstantValue(options.host ?? unavailableHost); } };
  const storage: ApplicationModule = {
    id: "media.storage",
    async start(ctx) {
      const db = await CoreDatabase.open(databasePath, undefined, { exclusiveOwner: true });
      // 取得后立即登记；下游启动失败时仍能关闭连接。
      ctx.disposables.add(() => db.close());
      ctx.container.bind(DatabaseToken).toConstantValue(db);
      accounts = new CloudAccounts(db); accounts.recover();
      roots = new CloudRoots(db); ctx.disposables.add(() => roots.close());
      catalog = new RemoteCatalog(db, options.host ?? unavailableHost, Date.now, (binding) => accounts.isReady(binding));
      downloads = new CloudDownloads(db, options.host ?? unavailableHost, catalog, roots);
      ctx.disposables.add(() => downloads.close());
      subscriptions = new CloudSubscriptions(db, downloads, catalog, roots);
      ctx.disposables.add(() => subscriptions.close());
    },
  };
  const services: ApplicationModule = {
    id: "media.services",
    dependencies: ["media.storage"],
    register(bind) {
      bind(CoreService).toSelf().inSingletonScope();
      bind(ComponentsToken).toConstantValue({ parserReady: () => parser?.ready ?? false });
    },
  };
  const parsing: ApplicationModule = { id: "media.parser", dependencies: ["media.storage"], async start(ctx) {
    if (!options.parser) return;
    try { const executable = await verifyParserResources(options.parser); parser = new ParserProcess(executable); ctx.disposables.add(() => parser!.close()); await parser.start(); }
    catch { /* 解析器不可用时阻止新整理；已下载成果和云端队列仍可查询。 */ }
  } };
  const commands: ApplicationModule = {
    id: "media.commands",
    dependencies: ["media.services", "media.parser"],
    start(ctx) {
      const service = ctx.get(CoreService);
      connections = new MediaConnections(ctx.get(DatabaseToken), () => service.getSettings());
      ctx.container.bind(MediaConnectionsToken).toConstantValue(connections);
      ctx.disposables.add(() => connections.close());
      ingestion = new IngestionPipeline(ctx.get(DatabaseToken), () => parser, connections);
      ctx.disposables.add(() => ingestion.close());
      outbox = new IngestionOutbox(ctx.get(DatabaseToken), roots, options.ingestion ?? ingestion);
      ctx.disposables.add(() => outbox.close());
      delivery = new EmbyDelivery(ctx.get(DatabaseToken), connections, () => service.getSettings(), ingestion);
      ctx.disposables.add(() => delivery.close());
      const registry = ctx.commandRegistry;
      const add = (dispose: () => void) => ctx.disposables.add(dispose);
      add(registry.register("media.media.libraries", () => ingestion.libraries()));
      add(registry.register("media.emby.configuration", () => delivery.configuration()));
      add(registry.register("media.emby.libraries", () => delivery.libraries()));
      add(registry.register("media.emby.connect", (_, input) => delivery.connect(input)));
      add(registry.register("media.emby.retry", (_, input) => delivery.retry(input.taskId)));
      add(registry.register("media.ingestion.candidates", (_, input) => ingestion.list(input)));
      add(registry.register("media.ingestion.scan", (_, input) => ingestion.scan(input.sourceId)));
      add(registry.register("media.ingestion.recognize", (_, input) => ingestion.recognize(input)));
      add(registry.register("media.ingestion.task", (_, input) => ingestion.task(input.taskId)));
      add(registry.register("media.ingestion.preview", (_, input) => ingestion.preview(input)));
      add(registry.register("media.ingestion.confirm", (_, input) => ingestion.confirm(input)));
      add(registry.register("media.ingestion.retry", (_, input) => ingestion.retry(input.taskId)));
      add(registry.register("media.cloud.downloads.pause-status", () => downloads.pauseStatus()));
      add(registry.register("media.cloud.downloads.set-paused", (_, input) => downloads.setPaused(input)));
      add(registry.register("media.cloud.subscriptions.configure", (_, input) => subscriptions.configure(input)));
      add(registry.register("media.cloud.subscriptions.list", (_, input) => subscriptions.list(input)));
      add(registry.register("media.cloud.subscriptions.control", (_, input) => subscriptions.control(input)));
      add(registry.register("media.cloud.roots.list", () => roots.list()));
      add(registry.register("media.cloud.downloads.preview", (_, input) => downloads.previews.start(input)));
      add(registry.register("media.cloud.downloads.get-preview", (_, input) => downloads.previews.get(input.requestKey)));
      add(registry.register("media.cloud.downloads.confirm", (_, input) => downloads.confirm(input)));
      add(registry.register("media.cloud.downloads.list", (_, input) => downloads.list(input)));
      add(registry.register("media.cloud.downloads.control", (_, input) => downloads.control(input)));
      add(registry.register("media.cloud.accounts.list", () => catalog.accounts()));
      add(registry.register("media.cloud.authorizations.get", (_, input) => accounts.authorization(input.requestKey)));
      add(registry.register("media.cloud.remote.list", (_, input) => catalog.list(input)));
      add(registry.register("media.cloud.remote.stat", (_, input) => catalog.stat(input.accountId, input.ref)));
      add(registry.register("media.cloud.diagnostics", () => new CloudRepository(ctx.get(DatabaseToken)).diagnosticCounts()));
      add(registry.register("media.runtime.get", () => service.getRuntime()));
      add(registry.register("media.sources.list", () => service.listSources()));
      add(
        registry.register("media.sources.save", (_, input) =>
          service.saveSource(coreActions["sources.save"].input.parse(input)).then((saved) => { ingestion.sourceChanged(saved.id); return saved; }),
        ),
      );
      add(
        registry.register("media.sources.pause", (_, input) =>
          { const saved = service.pauseSource(input.id, input.paused); ingestion.sourceChanged(saved.id); return saved; },
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
          { const previous = service.getSettings(), saved = service.saveSettings(coreActions["settings.save"].input.parse(input)); connections.reconfigure(); if (previous.embyUrl !== saved.embyUrl) delivery.invalidate(); return saved; },
        ),
      );
    },
  };
  const transfers: ApplicationModule = { id: "media.cloud-downloads", dependencies: ["media.commands"], start() { downloads.start(); subscriptions.start(); outbox.start(); ingestion.start(); delivery.start(); } };
  let accounts: CloudAccounts, catalog: RemoteCatalog, roots: CloudRoots, downloads: CloudDownloads, subscriptions: CloudSubscriptions, outbox: IngestionOutbox, parser: ParserProcess | undefined, connections: MediaConnections, ingestion: IngestionPipeline, delivery: EmbyDelivery;
  const app = createApplication({
    modules: [host, storage, services, parsing, commands, transfers, ...extraModules],
  });
  const active = new Set<Promise<unknown>>();
  let accepting = true;
  return {
    app,
    invalidateCloudRuntime() { accounts?.invalidateRuntime(); },
    confirmCloudWritersStopped(hostGeneration: string) { downloads?.writersReaped(hostGeneration); },
    async dispatchPrivate(value: unknown) {
      if (!accepting || app.state !== "running") throw new DesktopError("INTERRUPTED", "核心正在停止", true);
      const request = privateCoreRequestSchema.parse(value);
      const payload = privateCoreActions[request.action].input.parse(request.payload);
      const task = (async () => {
        if (request.action === "media.credentials.install") return connections.install(privateCoreActions["media.credentials.install"].input.parse(payload));
        if (request.action === "media.sources.bootstrap") return ingestion.bootstrap();
        if (request.action === "media.sources.authorize") return ingestion.authorize(privateCoreActions["media.sources.authorize"].input.parse(payload));
        if (request.action === "media.sources.configure-managed") return ingestion.configureManaged(privateCoreActions["media.sources.configure-managed"].input.parse(payload));
        if (request.action === "media.library.bootstrap") return ingestion.libraryBootstrap();
        if (request.action === "media.library.authorize") { const input = privateCoreActions["media.library.authorize"].input.parse(payload), previous = ingestion.libraryBootstrap().find((row) => row.mediaType === input.mediaType); const result = await ingestion.authorizeLibrary(input); if (previous && previous.target.id !== input.target.id) delivery.invalidate(); return result; }
        if (request.action === "media.emby.open-url") return delivery.openUrl((payload as { taskId: string }).taskId);
        if (request.action === "cloud.downloads.reconcile-restored") { downloads.reconcileRestored(); return {}; }
        if (request.action === "cloud.downloads.quiesce") { downloads.quiesce(); return {}; }
        if (request.action === "cloud.account.writers-stopped") { await downloads.accountWritersStopped((payload as { accountId: string }).accountId); return {}; }
        if (request.action === "cloud.runtime.wake") { ingestion.resetObservations(); await downloads.wake(); await subscriptions.wake((payload as { hostGeneration: string }).hostGeneration); return {}; }
        if (request.action === "cloud.authorization.finish") {
          const input = privateCoreActions["cloud.authorization.finish"].input.parse(payload), validator = new CloudBindingValidator(app.container.get(DatabaseToken), options.host ?? unavailableHost);
          const wasRunning = !!app.container.get(DatabaseToken).connection.prepare("SELECT 1 FROM cloud_authorization WHERE id=? AND state='RUNNING'").get(input.jobId);
          let mapping;
          try { mapping = await validator.validate(input); }
          catch (error) { input.failure = cloudFailure(error instanceof CloudError ? error : new CloudError("COMPONENT_UNAVAILABLE")); }
          const result = accounts.finish(input, mapping);
          if (wasRunning && result.state === "SUCCEEDED") { downloads.retireAccountPlans(result.accountId); await downloads.wake(); }
          return result;
        }
        if (request.action === "cloud.roots.bootstrap") return roots.bootstrap();
        if (request.action === "cloud.roots.authorize") return roots.authorize(managedRootGrantSchema.parse(payload));
        if (request.action === "cloud.roots.unavailable") return roots.unavailable((payload as { id: string }).id);
        if (request.action === "cloud.downloads.completed-root") return downloads.completedRoot((payload as { jobId: string }).jobId);
        return accounts.dispatch(request.action, payload as never);
      })();
      active.add(task);
      try { return privateCoreActions[request.action].output.parse(await task); }
      finally { active.delete(task); }
    },
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
      connections?.close();
      await Promise.allSettled([ingestion?.quiesce(), delivery?.close()]);
      await Promise.allSettled([...active]);
      await Promise.allSettled([outbox?.close(), subscriptions?.close(), downloads?.close()]);
      await app.stop();
    },
  };
}
