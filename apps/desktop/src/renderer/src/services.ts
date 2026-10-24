import {
  createApplication,
  type ApplicationModule,
} from "@yeatz/app-framework/application";
import {
  createIdentifier,
  inject,
  injectable,
  StatefulService,
} from "@yeatz/app-framework/ioc";
import type {
  DesktopApi,
  DesktopRuntime,
  DesktopSource,
  DesktopSettings,
  SourceDraft,
  TaskPage,
  SettingsDraft,
} from "@media-marshal/contracts";

export const DesktopClient = createIdentifier<DesktopApi>(
  "renderer.desktop-client",
);
function message(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试";
}

@injectable()
export class RuntimeViewModel extends StatefulService<{
  runtime: DesktopRuntime | null;
  error: string | null;
}> {
  protected initState = { runtime: null, error: null };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchers = 0;
  private stopped = false;
  private pollingGeneration = 0;
  private flight?: Promise<void>;
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) {
    super();
  }
  refresh(): Promise<void> {
    return (this.flight ??= this.client
      .getRuntime()
      .then(
        (runtime) => {
          if (!this.stopped) this.setState({ runtime, error: null });
        },
        (error) => {
          if (!this.stopped) this.setState({ error: message(error) });
        },
      )
      .finally(() => {
        this.flight = undefined;
      }));
  }
  watch(): () => void {
    this.watchers++;
    if (this.watchers === 1) {
      const generation = ++this.pollingGeneration;
      const tick = async () => {
        await this.refresh();
        if (
          this.watchers > 0 &&
          !this.stopped &&
          generation === this.pollingGeneration
        )
          this.timer = setTimeout(() => {
            void tick();
          }, 2000);
      };
      void tick();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.watchers--;
      if (!this.watchers) {
        this.pollingGeneration++;
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
      }
    };
  }
  async restart() {
    try {
      await this.client.restartCore();
      await this.refresh();
    } catch (error) {
      this.setState({ error: message(error) });
    }
  }
  protected dispose() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
@injectable()
export class SourcesViewModel extends StatefulService<{
  items: DesktopSource[];
  loading: boolean;
  error: string | null;
}> {
  protected initState = { items: [], loading: false, error: null };
  constructor(@inject(DesktopClient) readonly client: DesktopApi) {
    super();
  }
  async refresh() {
    this.setState({ loading: true, error: null });
    try {
      this.setState({ items: await this.client.listSources() });
    } catch (error) {
      this.setState({ error: message(error) });
    } finally {
      this.setState({ loading: false });
    }
  }
  async save(input: SourceDraft) {
    this.setState({ error: null });
    try {
      const saved = await this.client.saveSource(input);
      await this.refresh();
      return saved;
    } catch (error) {
      this.setState({ error: message(error) });
      throw error;
    }
  }
  async pause(id: string, paused: boolean) {
    try {
      await this.client.pauseSource(id, paused);
      await this.refresh();
    } catch (error) {
      this.setState({ error: message(error) });
    }
  }
}
@injectable()
export class TasksViewModel extends StatefulService<{
  data: TaskPage;
  loading: boolean;
  error: string | null;
}> {
  protected initState = {
    data: { items: [], total: 0, page: 1, pageSize: 25 },
    loading: false,
    error: null,
  };
  private generation = 0;
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) {
    super();
  }
  async refresh(page = 1, review = false) {
    const generation = ++this.generation;
    this.setState({ loading: true, error: null });
    try {
      const data = await this.client.listTasks({
        page,
        pageSize: 25,
        ...(review ? { status: "AWAITING_CONFIRMATION" as const } : {}),
      });
      if (generation === this.generation) this.setState({ data });
    } catch (error) {
      if (generation === this.generation)
        this.setState({ error: message(error) });
    } finally {
      if (generation === this.generation) this.setState({ loading: false });
    }
  }
  protected dispose() {
    this.generation++;
  }
}
@injectable()
export class SettingsViewModel extends StatefulService<{
  settings: DesktopSettings | null;
  loading: boolean;
  error: string | null;
}> {
  protected initState = { settings: null, loading: false, error: null };
  constructor(@inject(DesktopClient) readonly client: DesktopApi) {
    super();
  }
  async refresh() {
    this.setState({ loading: true, error: null });
    try {
      this.setState({ settings: await this.client.getSettings() });
    } catch (error) {
      this.setState({ error: message(error) });
    } finally {
      this.setState({ loading: false });
    }
  }
  async save(input: SettingsDraft) {
    try {
      await this.client.saveSettings(input);
      await this.refresh();
    } catch (error) {
      this.setState({ error: message(error) });
      throw error;
    }
  }
  async saveKey(kind: "tmdb" | "emby", value: string) {
    try {
      await this.client.saveCredential(kind, value);
      await this.refresh();
    } catch (error) {
      this.setState({ error: message(error) });
      throw error;
    }
  }
  async exportDiagnostics() {
    try { return await this.client.exportDiagnostics(); }
    catch (error) { this.setState({ error: message(error) }); throw error; }
  }
}
export function createRendererApplication(client: DesktopApi) {
  const connection: ApplicationModule = {
    id: "renderer.desktop-client",
    register(bind) {
      bind(DesktopClient).toConstantValue(client);
    },
  };
  const modules: ApplicationModule[] = [
    {
      id: "renderer.runtime",
      dependencies: [connection.id],
      register(bind) {
        bind(RuntimeViewModel).toSelf().inSingletonScope();
      },
    },
    {
      id: "renderer.sources",
      dependencies: [connection.id],
      register(bind) {
        bind(SourcesViewModel).toSelf().inSingletonScope();
      },
    },
    {
      id: "renderer.tasks",
      dependencies: [connection.id],
      register(bind) {
        bind(TasksViewModel).toSelf().inSingletonScope();
      },
    },
    {
      id: "renderer.settings",
      dependencies: [connection.id],
      register(bind) {
        bind(SettingsViewModel).toSelf().inSingletonScope();
      },
    },
  ];
  return createApplication({ modules: [connection, ...modules] });
}
