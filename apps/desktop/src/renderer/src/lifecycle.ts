/** 受控重载和 HMR 共用一次清理；即使 React 清理抛错，也要释放应用资源。 */
export function rendererStop(unmount: () => void, stopApplication: () => Promise<unknown>) {
  let flight: Promise<void> | undefined;
  return () => {
    if (flight) return flight;
    let resolve!: () => void, reject!: (error: unknown) => void;
    flight = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void (async () => {
      const errors: unknown[] = [];
      try { unmount(); } catch (error) { errors.push(error); }
      try { await stopApplication(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "界面清理未完成");
    })().then(resolve, reject);
    return flight;
  };
}

/** 替换发生在启动期间时，等待启动落定并清理，不再挂载旧一代页面。 */
export function rendererGeneration(start: (isStopping: () => boolean) => Promise<boolean>, mount: () => void, cleanup: () => Promise<void>) {
  let stopping = false, flight: Promise<void> | undefined;
  const ready = (async () => {
    try { const started = await start(() => stopping); if (started && !stopping) mount(); }
    catch (error) { await cleanup(); throw error; }
  })();
  return { ready, stop: () => { stopping = true; return flight ??= ready.then(cleanup); } };
}
