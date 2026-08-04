import { useState, useCallback, useEffect, useMemo, useRef } from "react"
import {
  Link2Off,
  Unlink,
  ArrowUpRight,
  AlertTriangle,
  Info,
  RefreshCw,
  CheckCircle2,
  BrainCircuit,
  Wrench,
  Trash2,
  Link,
  Link2,
  ChevronRight,
  ChevronDown,
  FilePlus,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore, type LintItem } from "@/stores/lint-store"
import {
  runStructuralLint,
  runSemanticLint,
  runLinkSuggestions,
  resolveBrokenLinksByEmbedding,
  resolveOrphansByEmbedding,
  resolveNoOutlinksByEmbedding,
  buildBrokenLinkStub,
  loadWikiPageTypes,
} from "@/lib/lint"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import {
  appendWikilink,
  ensureBrokenLinkStub,
  rewriteWikilinkTarget,
} from "@/lib/lint-fixes"
import { useTranslation } from "react-i18next"

export function groupLintResultsForDisplay(results: readonly LintItem[]): {
  suggestions: LintItem[]
  warnings: LintItem[]
  infos: LintItem[]
} {
  const suggestions: LintItem[] = []
  const warnings: LintItem[] = []
  const infos: LintItem[] = []

  results.forEach((result) => {
    if (result.type === "suggested-link") {
      suggestions.push(result)
    } else if (result.severity === "warning") {
      warnings.push(result)
    } else {
      infos.push(result)
    }
  })

  // Surface actionable broken links (those with a repoint target) first.
  const repointable = (i: LintItem) => i.type === "broken-link" && !!i.suggestedTarget
  warnings.sort((a, b) => Number(repointable(b)) - Number(repointable(a)))

  return { suggestions, warnings, infos }
}

export function shouldShowLintResults(hasRun: boolean, itemCount: number): boolean {
  return hasRun || itemCount > 0
}

export function LintView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const openFileInPreview = useWikiStore((s) => s.openFileInPreview)

  // Dynamic type config based on i18n
  const typeConfig = useMemo(() => ({
    orphan: { icon: Unlink, label: t("lint.typeLabels.orphan") },
    "broken-link": { icon: Link2Off, label: t("lint.typeLabels.broken-link") },
    "no-outlinks": { icon: ArrowUpRight, label: t("lint.typeLabels.no-outlinks") },
    semantic: { icon: BrainCircuit, label: t("lint.typeLabels.semantic") },
    "suggested-link": { icon: Link2, label: t("lint.typeLabels.suggested-link") },
  }), [t])

  const items = useLintStore((s) => s.items)
  const addLintItems = useLintStore((s) => s.addItems)
  const removeLintItems = useLintStore((s) => s.removeItems)
  const clearLintItems = useLintStore((s) => s.clearItems)

  const [running, setRunning] = useState(false)
  const [lintProgress, setLintProgress] = useState<{ completed: number; total: number } | null>(null)
  const [hasRun, setHasRun] = useState(false)
  const [runSemantic, setRunSemantic] = useState(false)
  const [semanticMode, setSemanticMode] = useState<"batch" | "cluster">("batch")
  const [suggestLinks, setSuggestLinks] = useState(false)
  const [suggestMode, setSuggestMode] = useState<"fast" | "confirm">("fast")
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [batchFixing, setBatchFixing] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [selectedLintIds, setSelectedLintIds] = useState<Set<string>>(() => new Set())
  const [addingAll, setAddingAll] = useState(false)
  const [repointingAll, setRepointingAll] = useState(false)
  const [creatingStubs, setCreatingStubs] = useState(false)
  const [linkingAllNoOutlinks, setLinkingAllNoOutlinks] = useState(false)
  const [connectingAll, setConnectingAll] = useState(false)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  // Stub-page type for broken-link "Create page" fixes. "auto" infers from the
  // source page's folder; otherwise the chosen type is written verbatim.
  const [stubType, setStubType] = useState<string>("auto")
  const [wikiTypes, setWikiTypes] = useState<string[]>([])
  const lintAbortRef = useRef<AbortController | null>(null)

  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  // turbovecdb-service URL is shared with the dedup embedding scan (kept in
  // localStorage while that path is experimental — see maintenance-section).
  const serviceUrl = useMemo(
    () => localStorage.getItem("dedup.turbovecServiceUrl") || "http://127.0.0.1:8077",
    [],
  )
  const clusterAvailable = !!embeddingConfig?.enabled && !!embeddingConfig?.endpoint
  const llmReady = hasUsableLlm(llmConfig)

  useEffect(() => () => lintAbortRef.current?.abort(), [])

  // Discover the wiki's actual page types to populate the stub-type selector,
  // once there are stubs to create. Always offer entity/concept as fallbacks.
  const stubbableCount = useMemo(
    () =>
      new Set(
        items
          .filter((i) => i.type === "broken-link" && i.brokenTarget && !i.suggestedTarget)
          .map((i) => i.brokenTarget!.toLowerCase()),
      ).size,
    [items],
  )
  useEffect(() => {
    if (!project || stubbableCount === 0) return
    let cancelled = false
    loadWikiPageTypes(normalizePath(project.path)).then((ts) => {
      if (!cancelled) setWikiTypes(ts)
    })
    return () => { cancelled = true }
  }, [project, stubbableCount])
  const stubTypeOptions = useMemo(
    () => [...new Set(["entity", "concept", ...wikiTypes])].sort(),
    [wikiTypes],
  )

  const handleRunLint = useCallback(async () => {
    if (!project || running) return
    const pp = normalizePath(project.path)
    setRunning(true)
    setFixError(null)
    setLintProgress(null)
    setSelectedLintIds(new Set())
    clearLintItems()
    const controller = new AbortController()
    lintAbortRef.current = controller
    try {
      const structural = await runStructuralLint(pp, {
        signal: controller.signal,
        onProgress: (completed, total) => setLintProgress({ completed, total }),
      })
      let all = structural

      // Embedding fallback: fill "did you mean?" targets for broken links the
      // lexical pass couldn't match; attach related pages to orphans (backlink
      // source) and no-outlinks (forward-link target). Gated on the same
      // embedding opt-in as link suggestions; no-ops when no unresolved items.
      if (clusterAvailable) {
        all = await resolveBrokenLinksByEmbedding(pp, all, embeddingConfig, controller.signal)
        all = await resolveOrphansByEmbedding(pp, all, embeddingConfig, controller.signal)
        all = await resolveNoOutlinksByEmbedding(pp, all, embeddingConfig, controller.signal)
      }

      if (runSemantic && hasUsableLlm(llmConfig)) {
        const semantic = await runSemanticLint(pp, llmConfig, {
          mode: semanticMode,
          embeddingConfig,
          serviceUrl,
          signal: controller.signal,
        })
        all = [...all, ...semantic]
      }

      if (suggestLinks && clusterAvailable) {
        const links = await runLinkSuggestions(pp, embeddingConfig, serviceUrl, {
          mode: suggestMode,
          llmConfig: hasUsableLlm(llmConfig) ? llmConfig : undefined,
          signal: controller.signal,
        })
        all = [...all, ...links]
      }

      addLintItems(all)
      setHasRun(true)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        console.error("Lint failed:", err)
      }
    } finally {
      lintAbortRef.current = null
      setRunning(false)
      setLintProgress(null)
    }
  }, [project, llmConfig, running, runSemantic, semanticMode, suggestLinks, suggestMode, clusterAvailable, embeddingConfig, serviceUrl, addLintItems, clearLintItems])

  async function handleOpenPage(page: string) {
    if (!project) return
    const pp = normalizePath(project.path)
    const candidates = [
      `${pp}/wiki/${page}`,
      `${pp}/wiki/${page}.md`,
    ]
    for (const path of candidates) {
      try {
        const content = await readFile(path)
        openFileInPreview(path, content)
        return
      } catch {
        // try next
      }
    }
    openFileInPreview(candidates[0], `Unable to load: ${page}`)
  }

  const addLintItemToReview = useCallback((item: LintItem) => {
    switch (item.type) {
      case "broken-link": {
        const pp = project ? normalizePath(project.path) : ""
        useReviewStore.getState().addItem({
          type: "confirm",
          title: t("lint.fixBrokenLink", { page: item.page }),
          description: item.detail,
          affectedPages: [item.page],
          options: [
            { label: t("lint.openEdit"), action: `open:${item.page}` },
            ...(pp ? [{ label: t("lint.deletePage"), action: `delete:${pp}/wiki/${item.page}` }] : []),
            { label: t("lint.skip"), action: "Skip" },
          ],
        })
        break
      }
      case "orphan":
      case "no-outlinks": {
        useReviewStore.getState().addItem({
          type: "suggestion",
          title: t("lint.addCrossRefs", { page: item.page }),
          description: item.type === "no-outlinks" ? t("lint.addCrossRefsDescription") : item.detail,
          affectedPages: [item.page],
          options: [
            { label: t("lint.openEdit"), action: `open:${item.page}` },
            { label: t("lint.skip"), action: "Skip" },
          ],
        })
        break
      }
      default: {
        useReviewStore.getState().addItem({
          type: "confirm",
          title: item.detail.slice(0, 80),
          description: item.detail,
          affectedPages: item.affectedPages ?? [item.page],
          options: [
            { label: t("lint.openEdit"), action: `open:${item.page}` },
            { label: t("lint.skip"), action: "Skip" },
          ],
        })
      }
    }
  }, [project, t])

  async function handleFix(item: LintItem, refreshTree = true) {
    if (!project) return
    const pp = normalizePath(project.path)
    setFixingId(item.id)
    setFixError(null)

    try {
      switch (item.type) {
        case "orphan": {
          if (item.suggestedSource) {
            const sourcePath = `${pp}/wiki/${item.suggestedSource}`
            const content = await readFile(sourcePath)
            await writeFile(sourcePath, appendWikilink(content, item.page))
          } else {
            addLintItemToReview(item)
          }
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "broken-link": {
          const pagePath = `${pp}/wiki/${item.page}`
          if (item.brokenTarget && item.suggestedTarget) {
            const content = await readFile(pagePath)
            await writeFile(pagePath, rewriteWikilinkTarget(content, item.brokenTarget, item.suggestedTarget))
          } else if (item.brokenTarget) {
            const content = await readFile(pagePath)
            const stub = await ensureBrokenLinkStub(pp, item.brokenTarget)
            await writeFile(pagePath, rewriteWikilinkTarget(content, item.brokenTarget, stub.relativePath))
          } else {
            addLintItemToReview(item)
          }
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "no-outlinks": {
          if (item.suggestedTarget) {
            const pagePath = `${pp}/wiki/${item.page}`
            const content = await readFile(pagePath)
            await writeFile(pagePath, appendWikilink(content, item.suggestedTarget))
          } else {
            addLintItemToReview(item)
          }
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "suggested-link": {
          // Add the suggested cross-link directly: append [[target]] to the
          // source page's ## Related section.
          const target = item.affectedPages?.[0]
          if (target) {
            const sourcePath = `${pp}/wiki/${item.page}`
            const linkText = target.replace(/\.md$/, "").replace(/^.*\//, "")
            const content = await readFile(sourcePath)
            await writeFile(sourcePath, appendWikilink(content, linkText))
          }
          useLintStore.getState().removeItem(item.id)
          break
        }

        default: {
          // Semantic issues → send to Review for manual resolution
          addLintItemToReview(item)
          useLintStore.getState().removeItem(item.id)
          break
        }
      }

      if (refreshTree) {
        await refreshProjectFileTree(pp, {
          projectId: project.id,
          clearDisplayTreeFirst: true,
          bumpDataVersion: true,
        })
      }
    } catch (err) {
      console.error("Fix failed:", err)
      setFixError(err instanceof Error ? err.message : String(err))
    } finally {
      setFixingId(null)
    }
  }

  async function handleDeleteOrphan(item: LintItem) {
    if (!project) return
    const pp = normalizePath(project.path)
    const pagePath = `${pp}/wiki/${item.page}`
    const confirmed = window.confirm(t("lint.deleteOrphanConfirm", { page: item.page }))
    if (!confirmed) return

    try {
      // Full cascade: file + embedding chunks + every reference to
      // the page across the wiki (body wikilinks, index.md listing,
      // `related:` frontmatter arrays). Even though "orphan" by lint
      // means no incoming wikilinks were detected, `related:` slugs
      // and index.md entries can still point at it — the orphan
      // detector only walks body refs.
      const { cascadeDeleteWikiPagesWithRefs } = await import(
        "@/lib/wiki-page-delete"
      )
      await cascadeDeleteWikiPagesWithRefs(pp, [pagePath])
      useLintStore.getState().removeItem(item.id)
      await refreshProjectFileTree(pp, {
        projectId: project.id,
        bumpDataVersion: true,
      })
    } catch (err) {
      console.error("Delete failed:", err)
    }
  }

  const { suggestions, warnings, infos } = useMemo(
    () => groupLintResultsForDisplay(items),
    [items],
  )
  const showResults = shouldShowLintResults(hasRun, items.length)
  const selectedLintItems = useMemo(
    () => items.filter((item) => selectedLintIds.has(item.id)),
    [items, selectedLintIds],
  )
  const allLintSelected = items.length > 0 && selectedLintItems.length === items.length
  const isFixing = fixingId !== null || batchFixing

  const setLintSelected = useCallback((id: string, selected: boolean) => {
    setSelectedLintIds((prev) => {
      const next = new Set(prev)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const toggleAllLint = useCallback(() => {
    setSelectedLintIds((prev) => {
      const next = new Set(prev)
      if (allLintSelected) {
        for (const item of items) next.delete(item.id)
      } else {
        for (const item of items) next.add(item.id)
      }
      return next
    })
  }, [allLintSelected, items])

  const handleBatchDismiss = useCallback(() => {
    const ids = selectedLintItems.map((item) => item.id)
    removeLintItems(ids)
    setSelectedLintIds(new Set())
  }, [removeLintItems, selectedLintItems])

  const handleBatchSendToReview = useCallback(() => {
    for (const item of selectedLintItems) {
      addLintItemToReview(item)
    }
    removeLintItems(selectedLintItems.map((item) => item.id))
    setSelectedLintIds(new Set())
  }, [addLintItemToReview, removeLintItems, selectedLintItems])

  const handleBatchFix = useCallback(async () => {
    if (!project || batchFixing || selectedLintItems.length === 0) return
    setBatchFixing(true)
    setFixError(null)
    const pp = normalizePath(project.path)
    let filesystemChanged = false
    try {
      const edits = new Map<string, Array<{ id: string; apply: (content: string) => string }>>()
      const queueEdit = (path: string, id: string, apply: (content: string) => string) => {
        const pending = edits.get(path) ?? []
        pending.push({ id, apply })
        edits.set(path, pending)
      }

      for (const item of selectedLintItems) {
        if (item.type === "orphan" && item.suggestedSource) {
          queueEdit(`${pp}/wiki/${item.suggestedSource}`, item.id, (content) => appendWikilink(content, item.page))
        } else if (item.type === "no-outlinks" && item.suggestedTarget) {
          queueEdit(`${pp}/wiki/${item.page}`, item.id, (content) => appendWikilink(content, item.suggestedTarget!))
        } else if (item.type === "broken-link" && item.brokenTarget) {
          const stub = item.suggestedTarget ? null : await ensureBrokenLinkStub(pp, item.brokenTarget)
          if (stub) filesystemChanged = true
          const target = item.suggestedTarget ?? stub!.relativePath
          queueEdit(`${pp}/wiki/${item.page}`, item.id, (content) =>
            rewriteWikilinkTarget(content, item.brokenTarget!, target))
        } else {
          addLintItemToReview(item)
          removeLintItems([item.id])
        }
      }

      // Multiple findings can target the same page. Apply their transforms in
      // memory and write that page once, avoiding lost updates and N full reads.
      for (const [path, pending] of edits) {
        const original = await readFile(path)
        const updated = pending.reduce((content, edit) => edit.apply(content), original)
        if (updated !== original) {
          await writeFile(path, updated)
          filesystemChanged = true
        }
        removeLintItems(pending.map((edit) => edit.id))
      }
      setSelectedLintIds(new Set())
    } catch (err) {
      console.error("Batch fix failed:", err)
      setFixError(err instanceof Error ? err.message : String(err))
    } finally {
      // Refresh even after a partial failure: earlier files or stubs may have
      // been written successfully. The expensive recursive rebuild still runs
      // at most once for the whole batch.
      if (filesystemChanged) {
        await refreshProjectFileTree(pp, {
          projectId: project.id,
          clearDisplayTreeFirst: true,
          bumpDataVersion: true,
        })
      }
      setBatchFixing(false)
    }
  }, [addLintItemToReview, batchFixing, project, removeLintItems, selectedLintItems])

  // ── Batch auto-triage (restored QoL lane) ──────────────────────────────────

  const connectableCount = useMemo(
    () => infos.filter((i) => i.type === "orphan" && i.suggestedSource).length,
    [infos],
  )
  const linkableNoOutlinksCount = useMemo(
    () => infos.filter((i) => i.type === "no-outlinks" && !!i.affectedPages?.[0]).length,
    [infos],
  )
  const repointableCount = useMemo(
    () => warnings.filter((i) => i.type === "broken-link" && i.suggestedTarget).length,
    [warnings],
  )

  async function batchRefresh(pp: string) {
    if (!project) return
    await refreshProjectFileTree(pp, { projectId: project.id, clearDisplayTreeFirst: true, bumpDataVersion: true })
  }

  // Apply every suggested link at once: group by source page so each page is
  // read/written a single time, even when it has many suggested targets.
  async function handleAddAllLinks() {
    if (!project || addingAll) return
    const pp = normalizePath(project.path)
    const suggestionsList = items.filter((i) => i.type === "suggested-link")
    if (suggestionsList.length === 0) return
    setAddingAll(true)
    try {
      const byPage = new Map<string, LintItem[]>()
      for (const it of suggestionsList) {
        const list = byPage.get(it.page)
        if (list) list.push(it)
        else byPage.set(it.page, [it])
      }
      let changed = false
      for (const [page, list] of byPage) {
        const sourcePath = `${pp}/wiki/${page}`
        try {
          let content = await readFile(sourcePath)
          for (const it of list) {
            const target = it.affectedPages?.[0]
            if (!target) continue
            content = appendWikilink(content, target.replace(/\.md$/, "").replace(/^.*\//, ""))
          }
          await writeFile(sourcePath, content)
          changed = true
          list.forEach((it) => useLintStore.getState().removeItem(it.id))
        } catch (err) {
          console.error(`Add-all links failed for ${page}:`, err)
        }
      }
      if (changed) await batchRefresh(pp)
    } finally {
      setAddingAll(false)
    }
  }

  // Repoint every broken link with a "did you mean?" target at once.
  async function handleRepointAll() {
    if (!project || repointingAll) return
    const pp = normalizePath(project.path)
    const repointable = items.filter(
      (i) => i.type === "broken-link" && i.brokenTarget && i.suggestedTarget,
    )
    if (repointable.length === 0) return
    setRepointingAll(true)
    try {
      const byPage = new Map<string, LintItem[]>()
      for (const it of repointable) {
        const list = byPage.get(it.page)
        if (list) list.push(it)
        else byPage.set(it.page, [it])
      }
      let changed = false
      for (const [page, list] of byPage) {
        const sourcePath = `${pp}/wiki/${page}`
        try {
          let content = await readFile(sourcePath)
          for (const it of list) {
            if (!it.brokenTarget || !it.suggestedTarget) continue
            content = rewriteWikilinkTarget(content, it.brokenTarget, it.suggestedTarget)
          }
          await writeFile(sourcePath, content)
          changed = true
          list.forEach((it) => useLintStore.getState().removeItem(it.id))
        } catch (err) {
          console.error(`Repoint-all failed for ${page}:`, err)
        }
      }
      if (changed) await batchRefresh(pp)
    } finally {
      setRepointingAll(false)
    }
  }

  // Create a stub page for every broken link with no repoint target. Deduped by
  // target text so a shared [[target]] stub is created once.
  async function handleCreateAllStubs() {
    if (!project || creatingStubs) return
    const pp = normalizePath(project.path)
    const stubbable = items.filter(
      (i) => i.type === "broken-link" && i.brokenTarget && !i.suggestedTarget,
    )
    if (stubbable.length === 0) return
    setCreatingStubs(true)
    const byTarget = new Map<string, LintItem[]>()
    for (const it of stubbable) {
      const key = it.brokenTarget!.toLowerCase()
      const list = byTarget.get(key)
      if (list) list.push(it)
      else byTarget.set(key, [it])
    }
    const today = new Date().toISOString().slice(0, 10)
    try {
      let changed = false
      for (const list of byTarget.values()) {
        const first = list[0]
        const stub = buildBrokenLinkStub(
          first.brokenTarget!,
          first.page,
          today,
          stubType === "auto" ? undefined : stubType,
        )
        if (!stub) continue
        const stubPath = `${pp}/wiki/${stub.path}`
        try {
          let exists = false
          try { await readFile(stubPath); exists = true } catch { exists = false }
          if (!exists) { await writeFile(stubPath, stub.content); changed = true }
          list.forEach((it) => useLintStore.getState().removeItem(it.id))
        } catch (err) {
          console.error(`Create-stub failed for ${stub.path}:`, err)
        }
      }
      if (changed) await batchRefresh(pp)
    } finally {
      setCreatingStubs(false)
    }
  }

  // Add a forward link to every no-outlinks page that has an embedding-suggested
  // target.
  async function handleAddAllNoOutlinks() {
    if (!project || linkingAllNoOutlinks) return
    const pp = normalizePath(project.path)
    const linkable = items.filter((i) => i.type === "no-outlinks" && i.affectedPages?.[0])
    if (linkable.length === 0) return
    setLinkingAllNoOutlinks(true)
    try {
      let changed = false
      for (const it of linkable) {
        const target = it.affectedPages![0]
        const sourcePath = `${pp}/wiki/${it.page}`
        const linkText = target.replace(/\.md$/, "").replace(/^.*\//, "")
        try {
          const content = await readFile(sourcePath)
          const updated = appendWikilink(content, linkText)
          if (updated !== content) { await writeFile(sourcePath, updated); changed = true }
          useLintStore.getState().removeItem(it.id)
        } catch (err) {
          console.error(`Add-all no-outlinks failed for ${it.page}:`, err)
        }
      }
      if (changed) await batchRefresh(pp)
    } finally {
      setLinkingAllNoOutlinks(false)
    }
  }

  // Connect every orphan that has an embedding-suggested source page at once.
  async function handleConnectAllOrphans() {
    if (!project || connectingAll) return
    const pp = normalizePath(project.path)
    const connectable = items.filter((i) => i.type === "orphan" && i.suggestedSource)
    if (connectable.length === 0) return
    setConnectingAll(true)
    const bySource = new Map<string, LintItem[]>()
    for (const it of connectable) {
      const list = bySource.get(it.suggestedSource!)
      if (list) list.push(it)
      else bySource.set(it.suggestedSource!, [it])
    }
    try {
      let changed = false
      for (const [source, list] of bySource) {
        const sourcePath = `${pp}/wiki/${source}`
        try {
          let content = await readFile(sourcePath)
          for (const it of list) {
            content = appendWikilink(content, it.page.replace(/\.md$/, "").replace(/^.*\//, ""))
          }
          await writeFile(sourcePath, content)
          changed = true
          list.forEach((it) => useLintStore.getState().removeItem(it.id))
        } catch (err) {
          console.error(`Connect-all orphans failed for ${source}:`, err)
        }
      }
      if (changed) await batchRefresh(pp)
    } finally {
      setConnectingAll(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t("lint.title")}</h2>
          {showResults && items.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {items.length === 1 ? t("lint.issues", { count: items.length }) : t("lint.issues_plural", { count: items.length })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={runSemantic}
              onChange={(e) => setRunSemantic(e.target.checked)}
            />
            {t("lint.semantic")}
          </label>
          {runSemantic && (
            <select
              value={semanticMode}
              onChange={(e) => setSemanticMode(e.target.value as "batch" | "cluster")}
              title={
                clusterAvailable
                  ? "How to split a large wiki across LLM calls"
                  : "Cluster mode needs an embedding endpoint (Settings → Embeddings)"
              }
              className="h-6 rounded border bg-background px-1.5 text-xs text-muted-foreground"
            >
              <option value="batch">Batched</option>
              <option value="cluster" disabled={!clusterAvailable}>
                Clustered (embeddings)
              </option>
            </select>
          )}
          <label
            className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
            title={clusterAvailable ? "Suggest links between related but disconnected pages" : "Needs an embedding endpoint (Settings → Embeddings)"}
          >
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={suggestLinks}
              disabled={!clusterAvailable}
              onChange={(e) => setSuggestLinks(e.target.checked)}
            />
            {t("lint.suggestLinks")}
          </label>
          {suggestLinks && clusterAvailable && (
            <select
              value={suggestMode}
              onChange={(e) => setSuggestMode(e.target.value as "fast" | "confirm")}
              title="Fast = embeddings only. Confirmed = an LLM keeps only useful links."
              className="h-6 rounded border bg-background px-1.5 text-xs text-muted-foreground"
            >
              <option value="fast">Fast (embeddings)</option>
              <option value="confirm" disabled={!llmReady}>
                Confirmed (LLM)
              </option>
            </select>
          )}
          <Button
            size="sm"
            variant={running ? "outline" : "default"}
            onClick={running ? () => lintAbortRef.current?.abort() : handleRunLint}
            disabled={!project}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
            {running
              ? lintProgress && lintProgress.total > 0
                ? t("lint.cancelProgress", { completed: lintProgress.completed, total: lintProgress.total })
                : t("lint.cancel")
              : t("lint.runLint")}
          </Button>
        </div>
      </div>

      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-2 text-xs">
          <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={allLintSelected}
              onChange={toggleAllLint}
            />
            {t("lint.selectAll")}
          </label>
          <span className="text-muted-foreground">
            {t("lint.selectedCount", { count: selectedLintItems.length })}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={selectedLintItems.length === 0 || isFixing}
            onClick={handleBatchFix}
          >
            {batchFixing ? t("lint.fixing") : t("lint.fixSelected")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={selectedLintItems.length === 0 || isFixing}
            onClick={handleBatchSendToReview}
          >
            {t("lint.sendSelectedToReview")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            disabled={selectedLintItems.length === 0 || isFixing}
            onClick={handleBatchDismiss}
          >
            {t("lint.ignoreSelected")}
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {fixError && (
          <div className="mx-3 mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t("lint.fixFailed", { error: fixError })}
          </div>
        )}
        {!showResults ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
            <p>{t("lint.runLintHint")}</p>
            <p className="text-xs">{t("lint.runLintDescription")}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
            <p className="text-emerald-600 dark:text-emerald-400 font-medium">{t("lint.allClear")}</p>
            <p className="text-xs">{t("lint.noIssues")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {suggestions.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 px-1 py-1 text-xs font-semibold text-primary">
                  <button
                    type="button"
                    onClick={() => setSuggestionsOpen((v) => !v)}
                    className="flex items-center gap-1.5 hover:opacity-80"
                  >
                    {suggestionsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    <Link2 className="h-3.5 w-3.5" />
                    {t("lint.suggestedLinks", { count: suggestions.length })}
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto h-6 text-xs gap-1"
                    disabled={addingAll}
                    onClick={handleAddAllLinks}
                  >
                    <Link2 className="h-3 w-3" />
                    {addingAll ? t("lint.adding") : t("lint.addAllLinks")}
                  </Button>
                </div>
                {suggestionsOpen &&
                  suggestions.map((item) => (
                    <LintCard
                      key={item.id}
                      item={item}
                      fixing={fixingId === item.id}
                      selected={selectedLintIds.has(item.id)}
                      onSelectedChange={setLintSelected}
                      onOpenPage={handleOpenPage}
                      onFix={handleFix}
                      typeConfig={typeConfig}
                      t={t}
                    />
                  ))}
              </div>
            )}
            {warnings.length > 0 && (
              <div className="flex items-center gap-2 px-1 py-1 text-xs font-semibold text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("lint.sectionCount", { label: t("lint.warnings"), count: warnings.length })}
                {(repointableCount > 0 || stubbableCount > 0) && (
                  <div className="ml-auto flex items-center gap-1.5">
                    {stubbableCount > 0 && (
                      <select
                        value={stubType}
                        onChange={(e) => setStubType(e.target.value)}
                        title="Type for stub pages created from broken links"
                        className="h-6 rounded border bg-background px-1.5 text-xs font-normal text-muted-foreground"
                      >
                        <option value="auto">Type: auto</option>
                        {stubTypeOptions.map((ty) => (
                          <option key={ty} value={ty}>
                            Type: {ty}
                          </option>
                        ))}
                      </select>
                    )}
                    {repointableCount > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs gap-1"
                        disabled={repointingAll}
                        onClick={handleRepointAll}
                      >
                        <Link2 className="h-3 w-3" />
                        {repointingAll ? t("lint.repointing") : t("lint.repointAll", { count: repointableCount })}
                      </Button>
                    )}
                    {stubbableCount > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs gap-1"
                        disabled={creatingStubs}
                        onClick={handleCreateAllStubs}
                      >
                        <FilePlus className="h-3 w-3" />
                        {creatingStubs ? t("lint.creating") : t("lint.createStubs", { count: stubbableCount })}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
            {warnings.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
                selected={selectedLintIds.has(item.id)}
                onSelectedChange={setLintSelected}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={item.type === "orphan" ? handleDeleteOrphan : undefined}
                typeConfig={typeConfig}
                t={t}
              />
            ))}
            {infos.length > 0 && (
              <div className="flex items-center gap-2 px-1 py-1 text-xs font-semibold text-blue-500">
                <Info className="h-3.5 w-3.5" />
                {t("lint.sectionCount", { label: t("lint.info"), count: infos.length })}
                {(connectableCount > 0 || linkableNoOutlinksCount > 0) && (
                  <div className="ml-auto flex items-center gap-1.5">
                    {connectableCount > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs gap-1"
                        disabled={connectingAll}
                        onClick={handleConnectAllOrphans}
                      >
                        <Link2 className="h-3 w-3" />
                        {connectingAll ? t("lint.connecting") : t("lint.connectAll", { count: connectableCount })}
                      </Button>
                    )}
                    {linkableNoOutlinksCount > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs gap-1"
                        disabled={linkingAllNoOutlinks}
                        onClick={handleAddAllNoOutlinks}
                      >
                        <Link2 className="h-3 w-3" />
                        {linkingAllNoOutlinks ? t("lint.adding") : t("lint.linkNoOutlinksAll", { count: linkableNoOutlinksCount })}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
            {infos.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
                selected={selectedLintIds.has(item.id)}
                onSelectedChange={setLintSelected}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={item.type === "orphan" ? handleDeleteOrphan : undefined}
                typeConfig={typeConfig}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function LintCard({
  item,
  fixing,
  selected,
  onSelectedChange,
  onOpenPage,
  onFix,
  onDelete,
  typeConfig,
  t,
}: {
  item: LintItem
  fixing: boolean
  selected: boolean
  onSelectedChange: (id: string, selected: boolean) => void
  onOpenPage: (page: string) => void
  onFix: (item: LintItem) => void
  onDelete?: (item: LintItem) => void
  typeConfig: Record<string, { icon: typeof AlertTriangle; label: string }>
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const config = typeConfig[item.type] ?? typeConfig.semantic
  const Icon = config.icon

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="mb-1.5 flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5"
          checked={selected}
          onChange={(event) => onSelectedChange(item.id, event.target.checked)}
          aria-label={t("lint.selectItem", { page: item.page })}
        />
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            item.severity === "warning" ? "text-amber-500" : "text-blue-500"
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{item.page}</div>
          <div className="text-[11px] text-muted-foreground">{config.label}</div>
        </div>
      </div>

      <p className="mb-2 text-xs text-muted-foreground">{item.detail}</p>

      {(item.suggestedTarget || item.suggestedSource) && (
        <div className="mb-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">
          <div className="flex items-start gap-1.5">
            <Link className="mt-0.5 h-3 w-3 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">
                {item.suggestedSource
                  ? t("lint.suggestedSource", { page: item.suggestedSource })
                  : t("lint.suggestedTarget", { page: item.suggestedTarget })}
              </div>
            </div>
          </div>
        </div>
      )}

      {item.affectedPages && item.affectedPages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {item.affectedPages.map((page) => (
            <button
              key={page}
              type="button"
              onClick={() => onOpenPage(page)}
              className="inline-flex items-center gap-0.5 rounded bg-accent/60 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent transition-colors"
            >
              {page}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-2">
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          onClick={() => onOpenPage(item.page)}
        >
          {t("lint.open")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          disabled={fixing}
          onClick={() => onFix(item)}
        >
          {item.type === "suggested-link"
            || (item.type === "broken-link" && item.suggestedTarget)
            || (item.type === "orphan" && item.suggestedSource)
            || (item.type === "no-outlinks" && !!item.affectedPages?.[0])
            ? <Link2 className="h-3 w-3" />
            : item.type === "broken-link" && item.brokenTarget
              ? <FilePlus className="h-3 w-3" />
              : <Wrench className="h-3 w-3" />}
          {item.type === "suggested-link"
            ? (fixing ? t("lint.adding") : t("lint.addLink"))
            : item.type === "broken-link" && item.suggestedTarget
              ? (fixing ? t("lint.repointing") : t("lint.repointTarget", { target: item.suggestedTarget }))
              : item.type === "broken-link" && item.brokenTarget
                ? (fixing ? t("lint.creating") : t("lint.createPage"))
                : item.type === "orphan" && item.suggestedSource
                  ? (fixing ? t("lint.linking") : t("lint.addBacklink"))
                  : item.type === "no-outlinks" && item.affectedPages?.[0]
                    ? (fixing ? t("lint.adding") : t("lint.addLinkTarget"))
                    : (fixing ? t("lint.fixing") : t("lint.fix"))}
        </Button>
        {onDelete && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs gap-1 text-destructive hover:text-destructive"
            onClick={() => onDelete(item)}
          >
            <Trash2 className="h-3 w-3" />
            {t("lint.delete")}
          </Button>
        )}
      </div>
    </div>
  )
}
