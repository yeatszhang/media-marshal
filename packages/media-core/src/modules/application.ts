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
import { SourceRules } from "../sources/rules.js";

declare module "@yeatz/app-framework/command" {
  interface Commands {
    "media.source-rules.resolve-legacy": (input: CoreInput<"source-rules.resolve-legacy">) => CoreOutput<"source-rules.resolve-legacy">;
    "media.source-rules.control": (input: CoreInput<"source-rules.control">) => CoreOutput<"source-rules.control">;
    "media.source-rules.preview-execution": (input: CoreInput<"source-rules.preview-execution">) => CoreOutput<"source-rules.preview-execution">;
    "media.source-rules.get-execution-preview": (input: CoreInput<"source-rules.get-execution-preview">) => CoreOutput<"source-rules.get-execution-preview">;
    "media.source-rules.execute": (input: CoreInput<"source-rules.execute">) => CoreOutput<"source-rules.execute">;
    "media.source-rules.run-once": (input: CoreInput<"source-rules.run-once">) => CoreOutput<"source-rules.run-once">;
    "media.source-rules.runs": (input: CoreInput<"source-rules.runs">) => CoreOutput<"source-rules.runs">;
    "media.ingestion.pause-status": () => CoreOutput<"ingestion.pause-status">;
    "media.ingestion.set-paused": (input: CoreInput<"ingestion.set-paused">) => CoreOutput<"ingestion.set-paused">;
    "media.source-rules.legacy": (input: CoreInput<"source-rules.legacy">) => CoreOutput<"source-rules.legacy">;
    "media.source-rules.configure": (input: CoreInput<"source-rules.configure">) => CoreOutput<"source-rules.configure">;
    "media.source-rules.list": (input: CoreInput<"source-rules.list">) => CoreOutput<"source-rules.list">;
    "media.source-rules.remove": (input: CoreInput<"source-rules.remove">) => CoreOutput<"source-rules.remove">;
    "media.source-rules.restore": (input: CoreInput<"source-rules.restore">) => CoreOutput<"source-rules.restore">;
    "media.source-rules.get": (input: CoreInput<"source-rules.get">) => CoreOutput<"source-rules.get">;
    "media.source-rules.preview": (input: CoreInput<"source-rules.preview">) => CoreOutput<"source-rules.preview">;
    "media.source-rules.get-preview": (input: CoreInput<"source-rules.get-preview">) => CoreOutput<"source-rules.get-preview">;
    "media.source-rules.apply": (input: CoreInput<"source-rules.apply">) => CoreOutput<"source-rules.apply">;
    "media.media.libraries": () => CoreOutput<"media.libraries">;
    "media.emby.configuration": () => CoreOutput<"emby.configuration">;
    "media.emby.libraries": () => Promise<CoreOutput<"emby.libraries">>;
    "media.emby.connect": (input: CoreInput<"emby.connect">) => Promise<CoreOutput<"emby.connect">>;
    "media.emby.retry": (input: CoreInput<"emby.retry">) => CoreOutput<"emby.retry">;
    "media.ingestion.candidates": (input: CoreInput<"ingestion.candidates">) => CoreOutput<"ingestion.candidates">;
    "media.ingestion.scan": (input: CoreInput<"ingestion.scan">) => Promise<CoreOutput<"ingestion.scan">>;
    "media.ingestion.review-content": (input: CoreInput<"ingestion.review-content">) => CoreOutput<"ingestion.review-content">;
    "media.ingestion.content-reviews": (input: CoreInput<"ingestion.content-reviews">) => CoreOutput<"ingestion.content-reviews">;
    "media.ingestion.content-review-files": (input: CoreInput<"ingestion.content-review-files">) => CoreOutput<"ingestion.content-review-files">;
    "media.ingestion.cancel-content-review": (input: CoreInput<"ingestion.cancel-content-review">) => CoreOutput<"ingestion.cancel-content-review">;
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
  options: { host?: CoreHostGateway; ingestion?: ManagedIngestionSink; parser?: ParserLaunch; cancelHostRequests?: () => void } = {},
) {
  let accepting = true, stopFlight: Promise<void> | undefined, quiescence: Promise<PromiseSettledResult<unknown>[]> | undefined;
  const ensureAccepting = () => { if (!accepting) throw new DesktopError("INTERRUPTED", "核心正在停止", true); };
  const host: ApplicationModule = { id: "media.host", register(bind, ctx) {
    bind(CloudHostToken).toConstantValue(options.host ?? unavailableHost);
    // 框架启动回滚也先取消响应等待，避免 drain 被尚未结束的任务阻塞。
    const abort = () => { void quiesceOwners(); };
    ctx.signal.addEventListener("abort", abort, { once: true });
    ctx.disposables.add(() => ctx.signal.removeEventListener("abort", abort));
  } };
  const storage: ApplicationModule = {
    id: "media.storage",
    async start(ctx) {
      ensureAccepting();
      const db = await CoreDatabase.open(databasePath, undefined, { exclusiveOwner: true });
      // 取得后立即登记；下游启动失败时仍能关闭连接。
      ctx.disposables.add(() => db.close());
      ensureAccepting();
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
    ensureAccepting();
    if (!options.parser) return;
    try { const executable = await verifyParserResources(options.parser); ensureAccepting(); parser = new ParserProcess(executable); ctx.disposables.add(() => parser!.close()); await parser.start(); }
    catch { /* 解析器不可用时阻止新整理；已下载成果和云端队列仍可查询。 */ }
  } };
  const commands: ApplicationModule = {
    id: "media.commands",
    dependencies: ["media.services", "media.parser"],
    start(ctx) {
      ensureAccepting();
      const service = ctx.get(CoreService);
      connections = new MediaConnections(ctx.get(DatabaseToken), () => service.getSettings());
      ctx.container.bind(MediaConnectionsToken).toConstantValue(connections);
      ctx.disposables.add(() => connections.close());
      ingestion = new IngestionPipeline(ctx.get(DatabaseToken), () => parser, connections);
      ctx.disposables.add(() => ingestion.close());
      sourceRules = new SourceRules(ctx.get(DatabaseToken), downloads, subscriptions, ingestion);
      ctx.disposables.add(() => sourceRules.close());
      outbox = new IngestionOutbox(ctx.get(DatabaseToken), roots, options.ingestion ?? ingestion);
      ctx.disposables.add(() => outbox.close());
      delivery = new EmbyDelivery(ctx.get(DatabaseToken), connections, () => service.getSettings(), ingestion);
      ctx.disposables.add(() => delivery.close());
      const registry = ctx.commandRegistry;
      const add = (dispose: () => void) => ctx.disposables.add(dispose);
      add(registry.register("media.source-rules.resolve-legacy", (_, input) => sourceRules.resolveLegacy(input)));
      add(registry.register("media.source-rules.control", (_, input) => sourceRules.control(input)));
      add(registry.register("media.source-rules.preview-execution", (_, input) => sourceRules.executions.start(input)));
      add(registry.register("media.source-rules.get-execution-preview", (_, input) => sourceRules.executions.get(input.id)));
      add(registry.register("media.source-rules.execute", (_, input) => sourceRules.executions.confirm(input)));
      add(registry.register("media.source-rules.run-once", (_, input) => sourceRules.runs.enqueue(input)));
      add(registry.register("media.source-rules.runs", (_, input) => sourceRules.runs.list(input)));
      add(registry.register("media.ingestion.pause-status", () => ingestion.pauseStatus()));
      add(registry.register("media.ingestion.set-paused", (_, input) => ingestion.setPaused(input)));
      add(registry.register("media.source-rules.legacy", (_, input) => sourceRules.legacy(input)));
      add(registry.register("media.source-rules.configure", (_, input) => sourceRules.configure(input)));
      add(registry.register("media.source-rules.list", (_, input) => sourceRules.list(input.includeDeleted)));
      add(registry.register("media.source-rules.remove", (_, input) => sourceRules.lifecycle(input, "remove")));
      add(registry.register("media.source-rules.restore", (_, input) => sourceRules.lifecycle(input, "restore")));
      add(registry.register("media.source-rules.get", (_, input) => sourceRules.get(input.id)));
      add(registry.register("media.source-rules.preview", (_, input) => sourceRules.preview(input)));
      add(registry.register("media.source-rules.get-preview", (_, input) => sourceRules.getPreview(input.id)));
      add(registry.register("media.source-rules.apply", () => { throw new DesktopError("FORBIDDEN", "来源确认必须经过宿主目录授权"); }));
      add(registry.register("media.media.libraries", () => ingestion.libraries()));
      add(registry.register("media.emby.configuration", () => delivery.configuration()));
      add(registry.register("media.emby.libraries", () => delivery.libraries()));
      add(registry.register("media.emby.connect", (_, input) => delivery.connect(input)));
      add(registry.register("media.emby.retry", (_, input) => delivery.retry(input.taskId)));
      add(registry.register("media.ingestion.candidates", (_, input) => ingestion.list(input)));
      add(registry.register("media.ingestion.review-content", (_, input) => {
        const source = sourceRules.get(input.sourceId);
        if (!source) return ingestion.reviewContent(input);
        if (source.type !== "local" || !source.localSourceId) throw new DesktopError("CONFLICT", "全量内容复核仅用于已确认的本地来源；网盘请在来源页使用强制重新下载");
        return ingestion.reviewContent({ ...input, sourceId: source.localSourceId });
      }));
      add(registry.register("media.ingestion.content-reviews", (_, input) => ingestion.contentReviews.list(input)));
      add(registry.register("media.ingestion.content-review-files", (_, input) => ingestion.contentReviews.items(input)));
      add(registry.register("media.ingestion.cancel-content-review", (_, input) => ingestion.contentReviews.cancel(input.id)));
      add(registry.register("media.ingestion.scan", (_, input) => {
        const source = sourceRules.get(input.sourceId);
        if (!source) return ingestion.scan(input.sourceId);
        const physicalId = source.localSourceId ?? source.ingestionSourceId;
        if (!physicalId || source.paused || source.reviewRequired || !source.configuration?.organization) throw new DesktopError("CONFLICT", "来源未启用整理、已经暂停或需要核对，请检查来源配置");
        return ingestion.scan(physicalId);
      }));
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
  const transfers: ApplicationModule = { id: "media.cloud-downloads", dependencies: ["media.commands"], start() { ensureAccepting(); sourceRules.start(); downloads.start(); subscriptions.start(); outbox.start(); ingestion.start(); delivery.start(); } };
  let accounts: CloudAccounts, catalog: RemoteCatalog, roots: CloudRoots, downloads: CloudDownloads, subscriptions: CloudSubscriptions, outbox: IngestionOutbox, parser: ParserProcess | undefined, connections: MediaConnections, ingestion: IngestionPipeline, delivery: EmbyDelivery, sourceRules: SourceRules;
  const app = createApplication({
    modules: [host, storage, services, parsing, commands, transfers, ...extraModules],
  });
  const active = new Set<Promise<unknown>>();
  function quiesceOwners() {
    if (quiescence) return quiescence;
    accepting = false;
    sourceRules?.quiesce(); downloads?.quiesce();
    if (app.state === "running") app.container.get(CoreService).quiesce();
    connections?.close();
    // 取消等待不等同于文件回滚或写入者已停止；后者仍由 Main／Host 回收证明。
    let cancelFailure: unknown;
    try { options.cancelHostRequests?.(); } catch (error) { cancelFailure = error; }
    return quiescence = Promise.allSettled([sourceRules?.close(), ingestion?.quiesce(), delivery?.close(), parser?.close(), outbox?.close(), subscriptions?.close(), downloads?.close(), ...(cancelFailure ? [Promise.reject(cancelFailure)] : [])]);
  }
  return {
    app,
    invalidateCloudRuntime() { accounts?.invalidateRuntime(); },
    confirmCloudWritersStopped(hostGeneration: string) { downloads?.writersReaped(hostGeneration); },
    async dispatchPrivate(value: unknown) {
      if (!accepting || app.state !== "running") throw new DesktopError("INTERRUPTED", "核心正在停止", true);
      const request = privateCoreRequestSchema.parse(value);
      const payload = privateCoreActions[request.action].input.parse(request.payload);
      const task = (async () => {
        if (request.action === "media.observations.reset") { ingestion.resetObservations(); return {}; }
        if (request.action === "desktop.state.reconcile-restored") { ingestion.reconcileRestored(); downloads.reconcileRestored(); return {}; }
        if (request.action === "source-rules.apply") { const input = privateCoreActions["source-rules.apply"].input.parse(payload); return sourceRules.apply({ previewId: input.previewId, requestKey: input.requestKey, runOnce: input.runOnce }, input.grants); }
        if (request.action === "media.targets.find") return ingestion.targetGrant((payload as { path: string }).path);
        if (request.action === "media.targets.bootstrap") return ingestion.targetBootstrap();
        if (request.action === "media.targets.authorize") return ingestion.authorizeTarget(privateCoreActions["media.targets.authorize"].input.parse(payload));
        if (request.action === "media.sources.authorize-managed") return ingestion.authorizeManagedSource(privateCoreActions["media.sources.authorize-managed"].input.parse(payload));
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
        if (request.action === "cloud.runtime.wake") { ingestion.resetObservations(); sourceRules.synchronize(); await downloads.wake(); await subscriptions.wake((payload as { hostGeneration: string }).hostGeneration); return {}; }
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
      if (!accepting || app.state !== "running")
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
    stop(): Promise<void> {
      if (stopFlight) return stopFlight;
      const settling = quiesceOwners();
      stopFlight = (async () => {
        const results = await settling;
        await Promise.allSettled([...active]);
        try { await app.stop(); }
        catch (error) { results.push({ status: "rejected", reason: error }); }
        const errors = results.filter((row): row is PromiseRejectedResult => row.status === "rejected").map((row) => row.reason);
        if (errors.length) throw new AggregateError(errors, "核心资源清理未全部完成");
      })();
      return stopFlight;
    },
  };
}
