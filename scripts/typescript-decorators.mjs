import ts from "typescript";

// 显式使用与 tsc 相同的 legacy 装饰器语义，避免不同 bundler 默认语义漂移。
export function typescriptDecorators() {
  return {
    name: "media-marshal-typescript-decorators",
    enforce: "pre",
    transform(code, id) {
      if (
        id.includes("node_modules") ||
        !/\.tsx?$/.test(id) ||
        !/@(?:injectable|inject|unmanaged)\b/.test(code)
      )
        return;
      const output = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
          experimentalDecorators: true,
          emitDecoratorMetadata: false,
          useDefineForClassFields: true,
          sourceMap: true,
        },
      });
      return { code: output.outputText, map: output.sourceMapText };
    },
  };
}
