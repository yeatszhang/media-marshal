import { readFileSync } from 'node:fs'
import ts from 'typescript'

// 复用项目现有 TypeScript 编译器，让 Node 20 也能直接运行纯逻辑测试。
export async function loadUtility(name) {
  const source = readFileSync(new URL(`../src/utils/${name}.ts`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}
