import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { SkillsLockFile, SkillIndex, SkillUiEntry } from 'llm-tools'
import {
  buildSkillIndex,
  buildSkillCatalog,
  buildSkillCatalogFromIndex,
  buildSkillUiIndex
} from 'llm-tools'

export { buildSkillCatalogFromIndex }

export async function writeSkillArtifacts(
  projectRoot: string,
  lock: SkillsLockFile
): Promise<{ index: SkillIndex; uiIndex: SkillUiEntry[] }> {
  const cacheDir = join(projectRoot, '.agents', 'cache')
  await mkdir(cacheDir, { recursive: true })

  const index = buildSkillIndex(lock)
  const catalog = buildSkillCatalog(lock)
  const uiIndex = buildSkillUiIndex(lock)

  await Promise.all([
    writeFile(join(cacheDir, 'skill-index.json'), JSON.stringify(index, null, 2), 'utf-8'),
    writeFile(join(cacheDir, 'skill-catalog.yaml'), catalog, 'utf-8'),
    writeFile(join(cacheDir, 'skill-ui-index.json'), JSON.stringify(uiIndex, null, 2), 'utf-8')
  ])

  return { index, uiIndex }
}
