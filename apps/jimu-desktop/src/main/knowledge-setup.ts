import { cp, lstat, realpath, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export interface StarterInspection {
  phase: string
  root?: string
  compatibility?: string
  error?: string
}

export function parseStarterFolderName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('知识库目录名无效')
  const name = value.trim()
  if (!name || name.length > 80 || name === '.' || name === '..' || isAbsolute(name) || basename(name) !== name || /[\\/\0]/u.test(name)) {
    throw new Error('知识库目录名必须是不含路径分隔符的普通名称')
  }
  return name
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

export async function createStarterDirectory(options: {
  parent: string
  folderName: unknown
  templateRoot: string
  inspectRoot: (root: string) => Promise<StarterInspection>
}): Promise<{ target: string; inspection: StarterInspection }> {
  const folderName = parseStarterFolderName(options.folderName)
  const parent = await realpath(options.parent)
  const target = join(parent, folderName)
  if (resolve(dirname(target)) !== resolve(parent) || await exists(target)) throw new Error('目标目录已存在或位置无效')

  const templateInspection = await options.inspectRoot(options.templateRoot)
  if (templateInspection.phase !== 'ready' || templateInspection.compatibility !== 'schema-1') {
    throw new Error('内置空白知识库不可用或校验失败')
  }

  const temporary = join(parent, `.${folderName}.jimu-${randomUUID()}.tmp`)
  let renamed = false
  try {
    await cp(options.templateRoot, temporary, { recursive: true, force: false, errorOnExist: true })
    const temporaryInspection = await options.inspectRoot(temporary)
    if (temporaryInspection.phase !== 'ready' || temporaryInspection.compatibility !== 'schema-1') {
      throw new Error(temporaryInspection.error ?? '新知识库校验失败')
    }
    await rename(temporary, target)
    renamed = true
    return { target, inspection: await options.inspectRoot(target) }
  } finally {
    if (!renamed) await rm(temporary, { recursive: true, force: true })
  }
}
