import { readFile, writeFile } from "@/commands/fs"
import type { ReviewItem } from "@/stores/review-store"
import { normalizePath } from "@/lib/path-utils"
import { makeQueryFileName } from "@/lib/wiki-filename"
import { createReviewPageDrafts } from "@/lib/review-create-page"

/**
 * Eligibility + bulk "create page" for the review queue.
 *
 * These were added as QoL: the review pane's multi-select bar previously only
 * offered "mark resolved" / "dismiss", forcing one-by-one "Create Page" clicks.
 * Extracting the create-write path here lets both the per-item fix and the bulk
 * "Create pages" action share one implementation (single source of truth for
 * how a review item becomes a page — file, index, and log).
 */

/** Is this item one whose options/type can produce a page? Anything with a
 *  non-dismissal, non-open, non-delete, non-research `Create`-style option, or
 *  a `missing-page` / `suggestion` type (which always offer create). */
export function createPageEligible(item: ReviewItem): boolean {
  if (item.type === "missing-page" || item.type === "suggestion") return true
  return item.options.some((opt) => actionIsCreate(opt.action))
}

/** Is this item eligible for Deep Research (has a 🔍 research action)? */
export function researchEligible(item: ReviewItem): boolean {
  return item.type === "suggestion" || item.type === "missing-page"
}

/** Resolve the create action string for an item. Prefers an explicit create
 *  option; falls back to the `__create_page__:` sentinel (the same entry point
 *  the "no search API" fallback uses in the single-item handler). */
export function deriveCreateAction(item: ReviewItem): string {
  const create = item.options.find((opt) => actionIsCreate(opt.action))
  return create ? create.action : "__create_page__:Create Page"
}

/** A page actually written for one review item. */
export interface WrittenReviewPage {
  id: string
  dir: string
  fileName: string
  filePath: string
  pageContent: string
  pageType: string
  title: string
  date: string
}

/**
 * Create pages for every eligible item, updating `wiki/index.md` and
 * `wiki/log.md` once for the whole batch. Returns the pages written (empty for
 * items that fail or produce no drafts). Callers resolve the review items and
 * refresh the file tree themselves.
 */
export async function writeReviewPagesForItems(
  projectPath: string,
  items: ReviewItem[],
): Promise<WrittenReviewPage[]> {
  if (items.length === 0) return []
  const pp = normalizePath(projectPath)

  const allPages: WrittenReviewPage[] = []
  for (const item of items) {
    try {
      const drafts = createReviewPageDrafts(item, deriveCreateAction(item))
      for (const draft of drafts) {
        const { date, fileName } = makeQueryFileName(draft.title)
        const filePath = `${pp}/wiki/${draft.dir}/${fileName}`
        const frontmatter = `---\ntype: ${draft.pageType}\ntitle: "${draft.title.replace(/"/g, '\\"')}"\ncreated: ${date}\ntags: []\nrelated: []\n---\n\n`
        const body = `# ${draft.title}\n\n${item.description}\n`
        const pageContent = frontmatter + body
        await writeFile(filePath, pageContent)
        allPages.push({ id: item.id, dir: draft.dir, fileName, filePath, pageContent, pageType: draft.pageType, title: draft.title, date })
      }
    } catch (err) {
      // A failing item (e.g. unreadable description) shouldn't abort the batch.
      console.error("Failed to create page from review:", err)
    }
  }

  if (allPages.length === 0) return []

  // Update index (one section entry per dir, deduped by dir+title).
  const indexPath = `${pp}/wiki/index.md`
  let indexContent = ""
  try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }
  const indexEntries = new Map<string, Set<string>>() // dir → set of "[[dir/name|title]]"
  for (const p of allPages) {
    const sectionHeader = `## ${p.dir.charAt(0).toUpperCase() + p.dir.slice(1)}`
    const linkTarget = p.fileName.replace(/\.md$/, "")
    const entry = `- [[${p.dir}/${linkTarget}|${p.title}]]`
    const set = indexEntries.get(sectionHeader) ?? new Set<string>()
    set.add(entry)
    indexEntries.set(sectionHeader, set)
  }
  for (const [sectionHeader, entries] of indexEntries) {
    if (indexContent.includes(sectionHeader)) {
      indexContent = indexContent.replace(
        new RegExp(`(${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n)`),
        (match) => `${match}${[...entries].join("\n")}\n`,
      )
    } else {
      indexContent = indexContent.trimEnd() + `\n\n${sectionHeader}\n${[...entries].join("\n")}\n`
    }
  }
  await writeFile(indexPath, indexContent)

  // Append a single log line summarizing the batch.
  const logPath = `${pp}/wiki/log.md`
  let logContent = ""
  try { logContent = await readFile(logPath) } catch { logContent = "# Wiki Log\n" }
  const logDate = allPages[0].date
  const createdNames = allPages.map((p) => `\`${p.fileName}\``).join(", ")
  await writeFile(
    logPath,
    logContent.trimEnd() + `\n- ${logDate}: Created ${allPages.length} page${allPages.length === 1 ? "" : "s"} from review: ${createdNames}\n`,
  )

  return allPages
}

// ── action classification (mirrors review-view's single-item heuristics) ─────

function actionLooksLikeResearch(action: string): boolean {
  if (action.startsWith("__")) return false
  const lower = action.toLowerCase()
  return (
    lower.includes("research") ||
    lower.includes("investigate") ||
    lower.includes("explore") ||
    lower.includes("look into")
  )
}

function actionIsDismissal(action: string): boolean {
  const lower = action.toLowerCase()
  return (
    lower === "skip" ||
    lower === "dismiss" ||
    lower === "ignore" ||
    lower === "approve" ||
    lower === "keep existing" ||
    lower === "no"
  )
}

function actionLooksLikeOpen(action: string): boolean {
  const lower = action.trim().toLowerCase()
  return lower === "open" || lower === "view" || lower === "open page" || lower === "view page"
}

const CREATE_PREFIX_RE = /^(create|save|add|missing\s+page)\b/i

function actionIsCreate(action: string): boolean {
  if (action.startsWith("__create_page__")) return true
  if (action.startsWith("__")) return false
  if (action.startsWith("delete:") || action.startsWith("save:") || action.startsWith("open:")) return false
  if (actionLooksLikeResearch(action) || actionLooksLikeOpen(action) || actionIsDismissal(action)) {
    return false
  }
  // Anything remaining that isn't a clear open/delete/research/dismissal is a
  // create/accept instruction, matching the single-item "create" fall-through.
  if (CREATE_PREFIX_RE.test(action)) return true
  return true
}
