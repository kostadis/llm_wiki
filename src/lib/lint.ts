import { readFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import { useActivityStore } from "@/stores/activity-store"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import { normalizeReviewTitle } from "@/lib/review-utils"
import { computeContextBudget } from "@/lib/context-budget"
import { fetchEmbedding } from "@/lib/embedding"
import { clusterPairs, servicePost, SERVICE_COLLECTION } from "@/lib/dedup-embed"
import type { LlmConfig } from "@/stores/wiki-store"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import {
  computeStructuralLint,
  type StructuralLintFinding,
  type StructuralLintPage,
} from "@/lib/lint-structural-core"

export interface LintResult {
  type: "orphan" | "broken-link" | "no-outlinks" | "semantic" | "suggested-link"
  severity: "warning" | "info"
  page: string
  detail: string
  affectedPages?: string[]
  brokenTarget?: string
  suggestedTarget?: string
  suggestedSource?: string
}

const SUGGESTION_TOKEN_WINDOW = 4000

// ── helpers ───────────────────────────────────────────────────────────────────

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function relativeToSlug(relativePath: string): string {
  // relativePath relative to wiki/ dir, e.g. "entities/foo-bar" or "queries/my-page-2024-01-01"
  return relativePath.replace(/\.md$/, "")
}

/**
 * Normalize a name for missing-page existence comparison. NFKC folds full-width
 * and compatibility forms so CJK / full-width variants compare equal.
 */
function normalizeForExistence(s: string): string {
  return normalizeReviewTitle(s).normalize("NFKC").trim().toLowerCase()
}

/**
 * Decide whether an LLM `missing-page` finding actually refers to a page that
 * already exists. The LLM does not reliably cross-reference the file list, so it
 * flags entities whose page is already present. Only exact normalized names are
 * accepted here. Substring matching is unsafe because short, valid page titles
 * can also be ordinary words inside an unrelated missing-page finding.
 */
function missingPageAlreadyExists(
  llmTitle: string,
  existingPageNames: Set<string>,
): boolean {
  const norm = normalizeForExistence(llmTitle)
  if (!norm) return false
  return existingPageNames.has(norm)
}

function extractTitle(content: string, fallbackPath: string): string {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (frontmatter) {
    const title = frontmatter[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (title?.[1]?.trim()) return title[1].trim()
  }
  const heading = content.match(/^#\s+(.+)$/m)
  if (heading?.[1]?.trim()) return heading[1].trim()
  return getFileName(fallbackPath)
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
}

function tokenizeForSuggestion(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.normalize("NFKC").toLowerCase()
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0]
    if (token.length >= 2) tokens.add(token)
    if (/[\u3400-\u9fff]/u.test(token)) {
      for (const char of Array.from(token)) tokens.add(char)
    }
  }
  return tokens
}

// ── Structural lint ───────────────────────────────────────────────────────────

export interface StructuralLintOptions {
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
}

function runStructuralWorker(
  pages: StructuralLintPage[],
  options: StructuralLintOptions,
): Promise<StructuralLintFinding[]> {
  if (typeof Worker === "undefined") {
    return Promise.resolve(computeStructuralLint(pages, options.onProgress))
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./lint-structural.worker.ts", import.meta.url), { type: "module" })
    const abort = () => {
      worker.terminate()
      reject(new DOMException("Structural lint cancelled", "AbortError"))
    }
    if (options.signal?.aborted) {
      abort()
      return
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    worker.onerror = (event) => {
      options.signal?.removeEventListener("abort", abort)
      worker.terminate()
      reject(new Error(event.message || "Structural lint worker failed"))
    }
    worker.onmessage = (event: MessageEvent<{
      type: "progress" | "done"
      completed?: number
      total?: number
      findings?: StructuralLintFinding[]
    }>) => {
      if (event.data.type === "progress") {
        options.onProgress?.(event.data.completed ?? 0, event.data.total ?? pages.length)
        return
      }
      options.signal?.removeEventListener("abort", abort)
      worker.terminate()
      resolve(event.data.findings ?? [])
    }
    worker.postMessage({ pages })
  })
}

export async function runStructuralLint(
  projectPath: string,
  options: StructuralLintOptions = {},
): Promise<LintResult[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const wikiFiles = flattenMdFiles(tree)
  // Exclude index.md and log.md from orphan checks
  const contentFiles = wikiFiles.filter(
    (f) => f.name !== "index.md" && f.name !== "log.md"
  )

  const pages: StructuralLintPage[] = []

  for (let index = 0; index < contentFiles.length; index += 1) {
    if (options.signal?.aborted) throw new DOMException("Structural lint cancelled", "AbortError")
    const f = contentFiles[index]
    try {
      const content = await readFile(f.path)
      const shortName = getRelativePath(f.path, wikiRoot)
      const slug = relativeToSlug(shortName)
      const title = extractTitle(content, shortName)
      const outlinks = extractWikilinks(content)
      const slugName = getFileName(slug)
      const tokens = Array.from(tokenizeForSuggestion(`${title}\n${slugName}\n${content.slice(0, SUGGESTION_TOKEN_WINDOW)}`))
      pages.push({ shortName, slug, title, outlinks, tokens })
    } catch {
      // skip unreadable files
    }
    options.onProgress?.(index + 1, contentFiles.length * 2)
  }
  return runStructuralWorker(pages, {
    ...options,
    onProgress: (completed, total) => options.onProgress?.(contentFiles.length + completed, contentFiles.length + total),
  })
}

// ── Semantic lint ─────────────────────────────────────────────────────────────

const LINT_BLOCK_REGEX =
  /---LINT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINT---/g

export type SemanticLintMode = "batch" | "cluster"

export interface SemanticLintOptions {
  /** Defaults to "batch". "cluster" additionally needs `embeddingConfig` +
   *  `serviceUrl`; if either is missing or the embedding/cluster step fails,
   *  the run falls back to "batch" rather than returning nothing. */
  mode?: SemanticLintMode
  embeddingConfig?: EmbeddingConfig
  /** turbovecdb-service base URL for "cluster" mode, e.g. http://127.0.0.1:8077 */
  serviceUrl?: string
  signal?: AbortSignal
}

interface SemanticLintPage {
  /** Wiki-relative path, e.g. "entities/foo.md". */
  shortPath: string
  /** First slice of the page, used both for the prompt and for embedding. */
  preview: string
}

const SEMANTIC_MAX_OUTPUT_TOKENS = 4096

function buildSemanticPrompt(pages: SemanticLintPage[]): string {
  const rendered = pages.map((p) => `### ${p.shortPath}\n${p.preview}`)
  const summarySample = rendered.join("\n").slice(0, 2000)
  return [
    "You are a wiki quality analyst. Review the following wiki page summaries and identify issues.",
    "",
    buildLanguageDirective(summarySample),
    "",
    "For each issue, output exactly this format:",
    "",
    "---LINT: type | severity | Short title---",
    "Description of the issue.",
    "PAGES: page1.md, page2.md",
    "---END LINT---",
    "",
    "Types:",
    "- contradiction: two or more pages make conflicting claims",
    "- stale: information that appears outdated or superseded",
    "- missing-page: an important concept is heavily referenced but has no dedicated page",
    "- suggestion: a question or source worth adding to the wiki",
    "For missing-page findings, Short title must be only the exact missing concept or entity name, without explanatory prefixes or suffixes.",
    "",
    "Severities:",
    "- warning: should be addressed",
    "- info: nice to have",
    "",
    "Only report genuine issues. Do not invent problems. Output ONLY the ---LINT--- blocks, no other text.",
    "",
    "## Wiki Pages",
    "",
    rendered.join("\n\n"),
  ].join("\n")
}

function packByChars(pages: SemanticLintPage[], budget: number): SemanticLintPage[][] {
  const batches: SemanticLintPage[][] = []
  let cur: SemanticLintPage[] = []
  let curChars = 0
  for (const p of pages) {
    const cost = p.shortPath.length + p.preview.length + 8
    if (cur.length && curChars + cost > budget) {
      batches.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(p)
    curChars += cost
  }
  if (cur.length) batches.push(cur)
  return batches
}

/** Cluster mode: embed each page, group related ones via turbovecdb, and return
 *  batches where each genuine cluster (≥2 related pages) is its own batch — so
 *  the LLM sees contradicting/overlapping pages together. Singletons are swept
 *  via `packByChars` so every page is still linted. */
async function clusterIntoBatches(
  pages: SemanticLintPage[],
  embeddingConfig: EmbeddingConfig,
  serviceUrl: string,
  dbPath: string,
  charBudget: number,
  signal: AbortSignal | undefined,
  onProgress: (m: string) => void,
): Promise<SemanticLintPage[][]> {
  const byPath = new Map(pages.map((p) => [p.shortPath, p]))

  onProgress(`Embedding ${pages.length} pages…`)
  const items = await embedForService(
    pages.map((p) => ({ id: p.shortPath, text: `${p.shortPath}\n${p.preview}` })),
    embeddingConfig,
    signal,
  )
  if (items.length < 2) return packByChars(pages, charBudget)

  onProgress("Indexing embeddings…")
  await servicePost(serviceUrl, "/v1/clear", { db_path: dbPath, collection: SERVICE_COLLECTION }, signal)
  await servicePost(serviceUrl, "/v1/upsert", { db_path: dbPath, collection: SERVICE_COLLECTION, items }, signal)

  onProgress("Grouping related pages…")
  const { pairs } = await servicePost<{ pairs: { a: string; b: string }[] }>(
    serviceUrl,
    "/v1/candidate_pairs",
    { db_path: dbPath, collection: SERVICE_COLLECTION, threshold: 0.2, k: 8 },
    signal,
  )

  const batches: SemanticLintPage[][] = []
  const clustered = new Set<string>()
  for (const cluster of clusterPairs(pairs)) {
    const cp = cluster
      .map((id) => byPath.get(id))
      .filter((p): p is SemanticLintPage => !!p)
    cluster.forEach((id) => clustered.add(id))
    for (const b of packByChars(cp, charBudget)) batches.push(b)
  }
  const singles = pages.filter((p) => !clustered.has(p.shortPath))
  for (const b of packByChars(singles, charBudget)) batches.push(b)
  return batches
}

/** Run one bounded LLM call over a single batch of pages. */
async function lintSemanticBatch(
  pages: SemanticLintPage[],
  llmConfig: LlmConfig,
  existingPageNames: Set<string>,
  maxOutputTokens: number,
  signal: AbortSignal | undefined,
): Promise<LintResult[]> {
  if (pages.length === 0) return []
  const prompt = buildSemanticPrompt(pages)
  let raw = ""
  let streamError: Error | null = null
  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: (err) => { streamError = err },
    },
    signal,
    { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: maxOutputTokens },
  )
  if (streamError) throw streamError

  const results: LintResult[] = []
  for (const match of raw.matchAll(LINT_BLOCK_REGEX)) {
    const rawType = match[1].trim().toLowerCase()
    const severity = match[2].trim().toLowerCase()
    const title = match[3].trim()
    const body = match[4].trim()

    // Drop `missing-page` findings whose page already exists — the LLM often
    // flags entities that already have a page, especially in non-English wikis
    // where its free-form titles don't match a fixed prefix (#537).
    if (rawType === "missing-page" && missingPageAlreadyExists(title, existingPageNames)) {
      continue
    }

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    const detail = body.replace(/^PAGES:.*$/m, "").trim()

    results.push({
      type: "semantic",
      severity: (severity === "warning" ? "warning" : "info") as LintResult["severity"],
      page: title,
      detail: `[${rawType}] ${detail}`,
      affectedPages,
    })
  }
  return results
}

export async function runSemanticLint(
  projectPath: string,
  llmConfig: LlmConfig,
  options: SemanticLintOptions = {},
): Promise<LintResult[]> {
  const { mode = "batch", embeddingConfig, serviceUrl, signal } = options
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: "Semantic wiki lint",
    status: "running",
    detail: "Reading wiki pages...",
    filesWritten: [],
  })

  const wikiRoot = `${pp}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    activity.updateItem(activityId, { status: "error", detail: "Failed to read wiki directory." })
    return []
  }

  const wikiFiles = flattenMdFiles(tree).filter(
    (f) => f.name !== "log.md"
  )

  // Build a compact preview of each page and collect the set of existing page
  // names (basename + frontmatter title) used to filter out `missing-page`
  // findings for pages that already exist (#537).
  const pages: SemanticLintPage[] = []
  const existingPageNames = new Set<string>()
  for (const f of wikiFiles) {
    if (signal?.aborted) throw new DOMException("Semantic lint cancelled", "AbortError")
    const basename = f.name.replace(/\.md$/i, "")
    if (basename) existingPageNames.add(normalizeForExistence(basename))
    try {
      const content = await readFile(f.path)
      const preview = content.slice(0, PAGE_PREVIEW_CHARS) + (content.length > PAGE_PREVIEW_CHARS ? "..." : "")
      const shortPath = getRelativePath(f.path, wikiRoot)
      const title = extractTitle(content, shortPath)
      if (title) existingPageNames.add(normalizeForExistence(title))
      pages.push({ shortPath, preview })
    } catch {
      // skip
    }
  }

  if (pages.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "No wiki pages to lint." })
    return []
  }

  // Cap input (char budget from the model's context window) and output
  // (max_tokens). Both caps keep any single request inside context.
  const { maxCtx, responseReserve } = computeContextBudget(llmConfig.maxContextSize)
  const inputCharBudget = Math.max(8_000, maxCtx - responseReserve - INSTRUCTION_RESERVE_CHARS)
  const maxOutputTokens = Math.min(
    SEMANTIC_MAX_OUTPUT_TOKENS,
    Math.max(1024, Math.floor(responseReserve / CHARS_PER_TOKEN)),
  )

  let batches: SemanticLintPage[][]
  if (mode === "cluster" && embeddingConfig?.enabled && embeddingConfig.endpoint && serviceUrl) {
    try {
      batches = await clusterIntoBatches(
        pages,
        embeddingConfig,
        serviceUrl,
        `${pp}/.llm-wiki/turbovecdb-lint`,
        inputCharBudget,
        signal,
        (m) => activity.updateItem(activityId, { detail: m }),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      activity.updateItem(activityId, { detail: `Cluster mode failed (${msg}); using batches…` })
      batches = packByChars(pages, inputCharBudget)
    }
  } else {
    batches = packByChars(pages, inputCharBudget)
  }

  activity.updateItem(activityId, {
    detail: `Running LLM semantic analysis (${batches.length} batch${batches.length === 1 ? "" : "es"})…`,
  })

  // Run batches with bounded concurrency; a failing batch is recorded but
  // doesn't abort the others.
  const all: LintResult[] = []
  let batchCursor = 0
  let completed = 0
  let failures = 0
  async function batchWorker() {
    while (batchCursor < batches.length) {
      if (signal?.aborted) return
      const i = batchCursor++
      try {
        all.push(...(await lintSemanticBatch(batches[i], llmConfig, existingPageNames, maxOutputTokens, signal)))
      } catch {
        failures++
      }
      completed++
      activity.updateItem(activityId, { detail: `Analyzed ${completed}/${batches.length} batches…` })
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, batchWorker))

  if (failures > 0 && all.length === 0) {
    activity.updateItem(activityId, { status: "error", detail: `All ${failures} batch(es) failed.` })
    return []
  }
  activity.updateItem(activityId, {
    status: "done",
    detail: failures > 0
      ? `Found ${all.length} semantic issue(s); ${failures} batch(es) failed.`
      : `Found ${all.length} semantic issue(s).`,
  })

  return all
}

// ── Shared link helpers (restored QoL lane) ──────────────────────────────────
// These were merged/lost when kostadis-dev was rebased over upstream v0.6.7's
// purely-lexical "link repair" linter. They bring back the embedding/LLM
// auto-triage lane: link suggestions, semantic fallbacks for broken links /
// no-outlinks / orphans, and stub-page creation with real type inference.

/** Append `- [[linkText]]` to content. Idempotent; inserts under an existing
 *  `## Related` / `## See also` heading, else appends a fresh `## Related`
 *  section. `linkText` is the target's basename. */
export function addRelatedLink(content: string, linkText: string): string {
  const already = extractWikilinks(content).some(
    (l) => l.toLowerCase() === linkText.toLowerCase(),
  )
  if (already) return content

  const entry = `- [[${linkText}]]`
  const lines = content.split("\n")
  const headingIdx = lines.findIndex((l) => /^#{1,6}\s+(related|see also)\b/i.test(l.trim()))
  if (headingIdx >= 0) {
    let insertAt = headingIdx + 1
    if (lines[insertAt]?.trim() === "") insertAt++
    lines.splice(insertAt, 0, entry)
    return lines.join("\n")
  }
  return `${content.trimEnd()}\n\n## Related\n\n${entry}\n`
}

// ── Broken-link "did you mean?" matching ──────────────────────────────────────

/** Minimum normalized-edit-distance ratio to suggest a lexical repoint. */
const LEXICAL_MATCH_THRESHOLD = 0.8

export interface SlugCandidate {
  /** Basename written into the wikilink, e.g. "foo-bar". */
  basename: string
  /** Wiki-relative path of the page, e.g. "entities/foo-bar.md". */
  shortPath: string
}

/** Collapse case/spacing/punctuation so "Foo Bar", "foo-bar", "foobar" compare equal. */
function normalizeSlugKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

/** Best lexical "did you mean" for a broken wikilink; null if nothing clears
 *  `LEXICAL_MATCH_THRESHOLD` (suggest nothing rather than a wrong repoint). */
export function bestLexicalSlug(
  brokenText: string,
  candidates: readonly SlugCandidate[],
): SlugCandidate | null {
  const q = normalizeSlugKey(brokenText)
  if (q.length < 3) return null
  let best: SlugCandidate | null = null
  let bestScore = 0
  for (const c of candidates) {
    const key = normalizeSlugKey(c.basename)
    if (!key) continue
    const score = key === q ? 1 : 1 - levenshtein(q, key) / Math.max(q.length, key.length)
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return bestScore >= LEXICAL_MATCH_THRESHOLD ? best : null
}

/** "phandalin-town" / "phandalin town" → "Phandalin Town". */
function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}

export interface StubPageSpec {
  /** Wiki-relative path to write, e.g. "entities/phandalin.md". */
  path: string
  content: string
}

/** Build a minimal stub page for a broken wikilink so the link resolves. The
 *  basename is the (sanitized) broken-link text; `type` inferred from the source
 *  directory. Returns null if the broken text can't yield a usable filename. */
export function buildBrokenLinkStub(
  brokenTarget: string,
  sourceShortPath: string,
  today: string,
  typeOverride?: string,
): StubPageSpec | null {
  const safeName = brokenTarget.trim().replace(/[/\\:*?"<>|]/g, "-").trim()
  if (!safeName) return null
  const dir = sourceShortPath.includes("/")
    ? sourceShortPath.replace(/\/[^/]*$/, "")
    : ""
  const type = typeOverride?.trim()
    ? typeOverride.trim()
    : dir.endsWith("concepts")
      ? "concept"
      : "entity"
  const sourceSlug = sourceShortPath.replace(/\.md$/, "").split("/").pop() ?? sourceShortPath
  const title = titleCase(safeName)
  const path = dir ? `${dir}/${safeName}.md` : `${safeName}.md`
  const content = [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    `created: ${today}`,
    `updated: ${today}`,
    "tags: [stub]",
    "---",
    "",
    `# ${title}`,
    "",
    `> Stub created from a broken link in [[${sourceSlug}]]. Add content here.`,
    "",
  ].join("\n")
  return { path, content }
}

/** Distinct frontmatter `type:` values across the wiki, for the stub-type
 *  selector — so it reflects the wiki's real taxonomy (e.g. "location"), not a
 *  fixed enum. Sorted; empty on read failure. */
export async function loadWikiPageTypes(projectPath: string): Promise<string[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }
  const files = flattenMdFiles(tree).filter(
    (f) => f.name !== "log.md" && f.name !== "index.md",
  )
  const types = new Set<string>()
  for (const f of files) {
    try {
      const content = await readFile(f.path)
      const fm = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fm) continue
      const tm = fm[1].match(/^type:\s*["']?([A-Za-z0-9_-]+)/m)
      if (tm) types.add(tm[1].toLowerCase())
    } catch {
      // skip unreadable files
    }
  }
  return [...types].sort()
}

/** Build a slug → absolute path map (case-insensitive) for wikilink resolution. */
function buildSlugMap(
  wikiFiles: FileNode[],
  wikiRoot: string,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const f of wikiFiles) {
    const rel = getRelativePath(f.path, wikiRoot).replace(/\.md$/, "")
    map.set(rel.toLowerCase(), f.path)
    map.set(f.name.replace(/\.md$/, "").toLowerCase(), f.path)
  }
  return map
}

/** Embed a list of `{id, text}` entries with bounded concurrency, dropping any
 *  that fail to embed. Shared by link-suggestion and embedding resolve lanes. */
async function embedForService(
  entries: { id: string; text: string }[],
  cfg: EmbeddingConfig,
  signal: AbortSignal | undefined,
): Promise<{ id: string; vector: number[]; type: string; title: string }[]> {
  const items: { id: string; vector: number[]; type: string; title: string }[] = []
  let cursor = 0
  async function worker() {
    while (cursor < entries.length) {
      if (signal?.aborted) return
      const e = entries[cursor++]
      const vector = await fetchEmbedding(e.text, cfg)
      if (vector) items.push({ id: e.id, vector, type: "page", title: e.id })
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, entries.length) }, worker))
  return items
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ── Link suggestions ──────────────────────────────────────────────────────────
// The inverse of broken-link/no-outlinks: surface "page A is closely related to
// existing page B and links neither direction — consider connecting them". Pure
// embedding similarity; an optional LLM pass keeps only genuinely useful links.

const PAGE_PREVIEW_CHARS = 500
const LINK_SUGGEST_THRESHOLD = 0.12
const LINK_SUGGEST_K = 6
const LINK_CONFIRM_MAX_OUTPUT_TOKENS = 2048
const LINK_CONFIRM_PAIRS_PER_BATCH = 40
const INSTRUCTION_RESERVE_CHARS = 4_000
const CHARS_PER_TOKEN = 4
const EMBED_CONCURRENCY = 8
const BATCH_CONCURRENCY = 3

export type LinkSuggestMode = "fast" | "confirm"

export interface LinkSuggestOptions {
  /** "fast" (default) = embedding-only. "confirm" = embedding + an LLM pass that
   *  drops weak pairs and picks the link direction; requires `llmConfig`. */
  mode?: LinkSuggestMode
  llmConfig?: LlmConfig
  signal?: AbortSignal
}

interface LinkPage {
  shortPath: string
  slug: string
  title: string
  preview: string
  linkedSlugs: Set<string>
}

async function loadPagesForLinks(projectPath: string): Promise<LinkPage[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }
  const wikiFiles = flattenMdFiles(tree).filter(
    (f) => f.name !== "log.md" && f.name !== "index.md",
  )
  const slugMap = buildSlugMap(wikiFiles, wikiRoot)
  const resolveToSlug = (link: string): string => {
    const path = slugMap.get(link.toLowerCase())
    return path
      ? relativeToSlug(getRelativePath(path, wikiRoot)).toLowerCase()
      : link.toLowerCase()
  }

  const pages: LinkPage[] = []
  for (const f of wikiFiles) {
    try {
      const content = await readFile(f.path)
      const shortPath = getRelativePath(f.path, wikiRoot)
      const slug = relativeToSlug(shortPath).toLowerCase()
      const linkedSlugs = new Set(extractWikilinks(content).map(resolveToSlug))
      const preview = content.slice(0, PAGE_PREVIEW_CHARS) + (content.length > PAGE_PREVIEW_CHARS ? "..." : "")
      pages.push({ shortPath, slug, title: shortPath, preview, linkedSlugs })
    } catch {
      // skip unreadable files
    }
  }
  return pages
}

interface LinkCandidate {
  from: LinkPage
  to: LinkPage
}

const LINK_BLOCK_REGEX =
  /---LINK:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINK---/g

function buildLinkConfirmPrompt(batch: LinkCandidate[]): string {
  const blocks = batch.map((c, i) => {
    return [
      `## Pair ${i + 1}`,
      `SOURCE: ${c.from.shortPath}`,
      c.from.preview,
      `TARGET: ${c.to.shortPath}`,
      c.to.preview,
    ].join("\n")
  })
  const sample = blocks.join("\n").slice(0, 2000)
  return [
    "You help curate a wiki's cross-references. Each pair below is two topically-similar pages where SOURCE does not currently link to TARGET.",
    "",
    buildLanguageDirective(sample),
    "",
    "For each pair, decide whether a reader of SOURCE would genuinely benefit from a [[link]] to TARGET. Be strict — only keep pairs where the link is clearly useful, not merely same-category.",
    "",
    "For each pair you KEEP, output exactly this block (omit pairs you reject):",
    "",
    "---LINK: source/path.md | target/path.md | confidence---",
    "One short sentence on why the link helps.",
    "---END LINK---",
    "",
    "confidence is high | medium | low. Use the exact SOURCE and TARGET paths from the pair. Output ONLY ---LINK--- blocks, nothing else. If no pair warrants a link, output nothing.",
    "",
    "## Candidate pairs",
    "",
    blocks.join("\n\n"),
  ].join("\n")
}

async function confirmLinkCandidates(
  candidates: LinkCandidate[],
  llmConfig: LlmConfig,
  signal: AbortSignal | undefined,
  onProgress: (m: string) => void,
): Promise<LintResult[]> {
  const { responseReserve, maxCtx } = computeContextBudget(llmConfig.maxContextSize)
  const charBudget = Math.max(8_000, maxCtx - responseReserve - INSTRUCTION_RESERVE_CHARS)
  const maxOutputTokens = Math.min(
    LINK_CONFIRM_MAX_OUTPUT_TOKENS,
    Math.max(512, Math.floor(responseReserve / CHARS_PER_TOKEN)),
  )

  const batches: LinkCandidate[][] = []
  let cur: LinkCandidate[] = []
  let curChars = 0
  for (const c of candidates) {
    const cost = c.from.preview.length + c.to.preview.length + c.from.shortPath.length + c.to.shortPath.length + 32
    if (cur.length && (cur.length >= LINK_CONFIRM_PAIRS_PER_BATCH || curChars + cost > charBudget)) {
      batches.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(c)
    curChars += cost
  }
  if (cur.length) batches.push(cur)

  const byPair = new Map(candidates.map((c) => [`${c.from.shortPath}::${c.to.shortPath}`, c]))

  const out: LintResult[] = []
  let cursor = 0
  let completed = 0
  async function worker() {
    while (cursor < batches.length) {
      if (signal?.aborted) return
      const i = cursor++
      const prompt = buildLinkConfirmPrompt(batches[i])
      let raw = ""
      let streamError: Error | null = null
      await streamChat(
        llmConfig,
        [{ role: "user", content: prompt }],
        {
          onToken: (t) => { raw += t },
          onDone: () => {},
          onError: (err) => { streamError = err },
        },
        signal,
        { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: maxOutputTokens },
      )
      completed++
      onProgress(`Confirming links (${completed}/${batches.length} batches)…`)
      if (streamError) continue
      for (const m of raw.matchAll(LINK_BLOCK_REGEX)) {
        const source = m[1].trim()
        const target = m[2].trim()
        const confidence = m[3].trim().toLowerCase()
        const reason = m[4].trim()
        const match = byPair.get(`${source}::${target}`)
        if (!match) continue
        out.push({
          type: "suggested-link",
          severity: "info",
          page: source,
          affectedPages: [target],
          detail: `Suggested link → ${match.to.title}${reason ? `: ${reason}` : "."}${confidence === "low" ? " (low confidence)" : ""}`,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, worker))
  return out
}

/** Suggest cross-links between closely related (by embedding) but disconnected
 *  pages. "fast" emits pairs directly; "confirm" runs an LLM pass to keep only
 *  genuinely useful links. Safe by the pipeline rule: every suggestion is
 *  reviewed before it edits a file. */
export async function runLinkSuggestions(
  projectPath: string,
  embeddingConfig: EmbeddingConfig,
  serviceUrl: string,
  options: LinkSuggestOptions = {},
): Promise<LintResult[]> {
  const { mode = "fast", llmConfig, signal } = options
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: "Link suggestions",
    status: "running",
    detail: "Reading wiki pages...",
    filesWritten: [],
  })

  if (!embeddingConfig?.enabled || !embeddingConfig.endpoint || !serviceUrl) {
    activity.updateItem(activityId, { status: "error", detail: "Link suggestions need an embedding endpoint." })
    return []
  }

  const pages = await loadPagesForLinks(pp)
  if (pages.length < 2) {
    activity.updateItem(activityId, { status: "done", detail: "Not enough pages to suggest links." })
    return []
  }
  const byId = new Map(pages.map((p) => [p.shortPath, p]))

  let pairs: { a: string; b: string }[]
  try {
    activity.updateItem(activityId, { detail: `Embedding ${pages.length} pages…` })
    const items = await embedForService(
      pages.map((p) => ({ id: p.shortPath, text: `${p.shortPath}\n${p.preview}` })),
      embeddingConfig,
      signal,
    )
    if (items.length < 2) {
      activity.updateItem(activityId, { status: "done", detail: "Not enough pages embedded to suggest links." })
      return []
    }
    const dbPath = `${pp}/.llm-wiki/turbovecdb-links`
    activity.updateItem(activityId, { detail: "Indexing embeddings…" })
    await servicePost(serviceUrl, "/v1/clear", { db_path: dbPath, collection: SERVICE_COLLECTION }, signal)
    await servicePost(serviceUrl, "/v1/upsert", { db_path: dbPath, collection: SERVICE_COLLECTION, items }, signal)
    activity.updateItem(activityId, { detail: "Finding related pages…" })
    const res = await servicePost<{ pairs: { a: string; b: string }[] }>(
      serviceUrl,
      "/v1/candidate_pairs",
      { db_path: dbPath, collection: SERVICE_COLLECTION, threshold: LINK_SUGGEST_THRESHOLD, k: LINK_SUGGEST_K },
      signal,
    )
    pairs = res.pairs
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    activity.updateItem(activityId, { status: "error", detail: `Embedding/index step failed: ${msg}` })
    return []
  }

  const candidates: LinkCandidate[] = []
  const seen = new Set<string>()
  for (const { a, b } of pairs) {
    const pa = byId.get(a)
    const pb = byId.get(b)
    if (!pa || !pb) continue
    if (pa.linkedSlugs.has(pb.slug) || pb.linkedSlugs.has(pa.slug)) continue
    const key = [pa.shortPath, pb.shortPath].sort().join("::")
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ from: pa, to: pb })
  }

  if (candidates.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "No missing links found." })
    return []
  }

  let results: LintResult[]
  if (mode === "confirm" && llmConfig) {
    activity.updateItem(activityId, { detail: `Confirming ${candidates.length} candidate link(s)…` })
    results = await confirmLinkCandidates(candidates, llmConfig, signal, (m) =>
      activity.updateItem(activityId, { detail: m }),
    )
  } else {
    results = candidates.map((c) => ({
      type: "suggested-link",
      severity: "info",
      page: c.from.shortPath,
      affectedPages: [c.to.shortPath],
      detail: `Closely related to ${c.to.title} but neither page links the other — consider adding a [[link]].`,
    }))
  }

  activity.updateItem(activityId, {
    status: "done",
    detail: `Suggested ${results.length} link(s).`,
  })
  return results
}

// ── Semantic embedding fallbacks (mutate + return `results`) ──────────────────

const BROKEN_LINK_EMBED_MIN_SIM = 0.6
const NO_OUTLINKS_EMBED_MIN_SIM = 0.5
const ORPHAN_EMBED_MIN_SIM = 0.5

async function embedPagesForResolve(
  projectPath: string,
  embeddingConfig: EmbeddingConfig,
  signal: AbortSignal | undefined,
  onProgress?: (m: string) => void,
): Promise<{ id: string; vector: number[] }[]> {
  const pages = await loadPagesForLinks(normalizePath(projectPath))
  if (pages.length === 0) return []
  onProgress?.(`Embedding ${pages.length} pages…`)
  const vecs = await embedForService(
    pages.map((p) => ({ id: p.shortPath, text: `${p.shortPath}\n${p.preview}` })),
    embeddingConfig,
    signal,
  )
  return vecs
}

function basenameOf(id: string): string {
  return id.replace(/\.md$/, "").split("/").pop() ?? id
}

function nearestPage(
  target: number[],
  vecs: { id: string; vector: number[] }[],
  excludeId: string | null,
  minSim: number,
): { id: string; sim: number } | null {
  let best: { id: string; sim: number } | null = null
  for (const v of vecs) {
    if (excludeId !== null && v.id === excludeId) continue
    const sim = cosineSim(target, v.vector)
    if (!best || sim > best.sim) best = { id: v.id, sim }
  }
  return best && best.sim >= minSim ? best : null
}

/** Embedding fallback for broken links the lexical pass couldn't match
 *  (synonyms, abbreviations). Only touches broken-link items with a
 *  `brokenTarget` and no `suggestedTarget`, and only when embeddings are
 *  configured. */
export async function resolveBrokenLinksByEmbedding(
  projectPath: string,
  results: LintResult[],
  embeddingConfig: EmbeddingConfig,
  signal?: AbortSignal,
  onProgress?: (m: string) => void,
): Promise<LintResult[]> {
  const unresolved = results.filter(
    (r) => r.type === "broken-link" && r.brokenTarget && !r.suggestedTarget,
  )
  if (unresolved.length === 0 || !embeddingConfig?.enabled || !embeddingConfig.endpoint) {
    return results
  }

  const vecs = await embedPagesForResolve(projectPath, embeddingConfig, signal, onProgress)
  if (vecs.length === 0) return results

  const cache = new Map<string, string | null>()
  for (const r of unresolved) {
    if (signal?.aborted) break
    const text = r.brokenTarget!
    let matchedPath = cache.get(text)
    if (matchedPath === undefined) {
      const qv = await fetchEmbedding(text, embeddingConfig)
      if (!qv) {
        matchedPath = null
      } else {
        const best = nearestPage(qv, vecs, null, BROKEN_LINK_EMBED_MIN_SIM)
        matchedPath = best ? best.id : null
      }
      cache.set(text, matchedPath)
    }
    if (matchedPath) {
      r.suggestedTarget = basenameOf(matchedPath)
      r.affectedPages = [matchedPath]
      r.detail = `Broken link: [[${text}]] — did you mean [[${basenameOf(matchedPath)}]]? (semantic match)`
    }
  }
  return results
}

/** For each page with no outbound wikilinks, attach the closest related page as
 *  `affectedPages[0]` so the fix can add `[[target]]` with one click. Only for
 *  no-outlinks items without an existing suggestion, gated on embeddings. */
export async function resolveNoOutlinksByEmbedding(
  projectPath: string,
  results: LintResult[],
  embeddingConfig: EmbeddingConfig,
  signal?: AbortSignal,
  onProgress?: (m: string) => void,
): Promise<LintResult[]> {
  const noOutlinks = results.filter((r) => r.type === "no-outlinks" && !r.affectedPages?.length)
  if (noOutlinks.length === 0 || !embeddingConfig?.enabled || !embeddingConfig.endpoint) {
    return results
  }

  const vecs = await embedPagesForResolve(projectPath, embeddingConfig, signal, onProgress)
  if (vecs.length < 2) return results

  for (const o of noOutlinks) {
    if (signal?.aborted) break
    const self = vecs.find((v) => v.id === o.page)
    if (!self) continue
    const best = nearestPage(self.vector, vecs, o.page, NO_OUTLINKS_EMBED_MIN_SIM)
    if (best) {
      o.affectedPages = [best.id]
      o.detail = `No outbound links — [[${basenameOf(best.id)}]] is closely related; consider adding a link.`
    }
  }
  return results
}

/** For each orphan, attach the closest existing page as `suggestedSource` so
 *  the fix adds `[[orphan]]` there — a real body wikilink the orphan detector
 *  counts. Only for orphans without a `suggestedSource`, gated on embeddings. */
export async function resolveOrphansByEmbedding(
  projectPath: string,
  results: LintResult[],
  embeddingConfig: EmbeddingConfig,
  signal?: AbortSignal,
  onProgress?: (m: string) => void,
): Promise<LintResult[]> {
  const orphans = results.filter((r) => r.type === "orphan" && !r.suggestedSource)
  if (orphans.length === 0 || !embeddingConfig?.enabled || !embeddingConfig.endpoint) {
    return results
  }

  const vecs = await embedPagesForResolve(projectPath, embeddingConfig, signal, onProgress)
  if (vecs.length < 2) return results

  for (const o of orphans) {
    if (signal?.aborted) break
    const self = vecs.find((v) => v.id === o.page)
    if (!self) continue
    const best = nearestPage(self.vector, vecs, o.page, ORPHAN_EMBED_MIN_SIM)
    if (best) {
      o.suggestedSource = best.id
      o.detail = `No page links here yet — [[${basenameOf(best.id)}]] is closely related; add a backlink from it.`
    }
  }
  return results
}
