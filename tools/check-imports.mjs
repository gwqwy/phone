// 机械检查：client/ 与 tests/ 里所有相对 import 都能解析到真实文件，
// 并且被 import 的名字在该模块里确实有导出。这能挡住"文件改了但忘了改导出"这类低级错误。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = process.cwd()
const files = []
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'unpackage') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(js|vue)$/.test(entry.name)) files.push(full)
  }
}
walk(join(ROOT, 'client'))
walk(join(ROOT, 'tests'))

const importRe = /import\s+(?:([\w*\s{},$]+?)\s+from\s+)?['"]([^'"]+)['"]/g
const exportRe = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g
const exportListRe = /export\s*\{([^}]+)\}/g

const exportsOf = new Map()
function exportsFor(file) {
  if (exportsOf.has(file)) return exportsOf.get(file)
  const source = readFileSync(file, 'utf8')
  const names = new Set()
  let m
  while ((m = exportRe.exec(source))) names.add(m[1])
  while ((m = exportListRe.exec(source))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim()
      if (name) names.add(name)
    }
  }
  if (/export\s+default/.test(source)) names.add('default')
  exportsOf.set(file, names)
  return names
}

let problems = 0
let checked = 0

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const script = file.endsWith('.vue') ? (source.match(/<script[^>]*>([\s\S]*?)<\/script>/) ?? [])[1] ?? '' : source
  let m
  importRe.lastIndex = 0
  while ((m = importRe.exec(script))) {
    const specifiers = m[1] ?? ''
    const spec = m[2]
    if (!spec.startsWith('.')) continue
    checked++
    const target = resolve(dirname(file), spec)
    if (!existsSync(target)) {
      console.log(`缺失文件: ${file.replace(ROOT, '.')} -> ${spec}`)
      problems++
      continue
    }
    const names = exportsFor(target)
    const hasBraces = specifiers.includes('{')
    if (!hasBraces) {
      // `import X from '...'` 绑定的是 default 导出，本地名字随便起。
      if (!names.has('default') && !target.endsWith('.vue')) {
        console.log(`缺少默认导出: ${file.replace(ROOT, '.')} -> ${spec}`)
        problems++
      }
      continue
    }
    for (const raw of specifiers.replace(/[{}]/g, ',').split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim()
      if (!name || name === '*' || name.startsWith('type ')) continue
      if (!names.has(name)) {
        console.log(`未导出: ${file.replace(ROOT, '.')} 从 ${spec} 引入 ${name}`)
        problems++
      }
    }
  }
}

console.log(`检查了 ${checked} 条相对 import，问题 ${problems} 处`)
process.exit(problems ? 1 : 0)
