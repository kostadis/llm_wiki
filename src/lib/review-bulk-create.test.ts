import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReviewItem } from "@/stores/review-store"

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))
vi.mock("@/lib/wiki-filename", () => ({
  makeQueryFileName: vi.fn((title: string) => ({
    slug: title.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    fileName: `${title.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-2026-01-01-000000.md`,
    date: "2026-01-01",
    time: "000000",
  })),
}))

import { readFile, writeFile } from "@/commands/fs"
import {
  createPageEligible,
  researchEligible,
  deriveCreateAction,
  writeReviewPagesForItems,
} from "./review-bulk-create"

const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)

function review(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    id: "review-1",
    type: "missing-page",
    title: "Missing page: Foo",
    description: "",
    options: [],
    resolved: false,
    createdAt: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // index.md / log.md don't exist yet → fall back to fresh banners.
  mockReadFile.mockRejectedValue(new Error("ENOENT"))
})

describe("createPageEligible / researchEligible", () => {
  it("treats missing-page and suggestion types as create-eligible", () => {
    expect(createPageEligible(review({ type: "missing-page" }))).toBe(true)
    expect(createPageEligible(review({ type: "suggestion" }))).toBe(true)
  })

  it("treats an explicit create option as eligible even for other types", () => {
    expect(createPageEligible(review({
      type: "confirm",
      options: [{ label: "Create Page", action: "Create Page" }],
    }))).toBe(true)
  })

  it("is not eligible when the only options are dismissal / open / delete", () => {
    expect(createPageEligible(review({
      type: "confirm",
      options: [
        { label: "Skip", action: "Skip" },
        { label: "Open", action: "open:foo.md" },
        { label: "Delete", action: "delete:/x.md" },
      ],
    }))).toBe(false)
  })

  it("research eligibility is suggestion / missing-page", () => {
    expect(researchEligible(review({ type: "suggestion" }))).toBe(true)
    expect(researchEligible(review({ type: "missing-page" }))).toBe(true)
    expect(researchEligible(review({ type: "contradiction" }))).toBe(false)
  })
})

describe("deriveCreateAction", () => {
  it("prefers an explicit create option", () => {
    const item = review({
      options: [
        { label: "Skip", action: "Skip" },
        { label: "Create Page", action: "Create Page" },
      ],
    })
    expect(deriveCreateAction(item)).toBe("Create Page")
  })

  it("falls back to the __create_page__ sentinel", () => {
    expect(deriveCreateAction(review({ options: [] }))).toBe("__create_page__:Create Page")
  })
})

describe("writeReviewPagesForItems", () => {
  it("writes a page per draft, updates index and appends a single log line", async () => {
    const items = [
      review({ id: "a", type: "suggestion", title: "Create concept: Alpha", description: "Alpha concept body" }),
      review({ id: "b", type: "suggestion", title: "Create: Policy note", description: "Policy body" }),
    ]

    const pages = await writeReviewPagesForItems("/proj", items)

    // Alpha → concept; Policy note → query.
    expect(pages.map((p) => p.id)).toEqual(["a", "b"])
    const concept = pages.find((p) => p.id === "a")!
    const query = pages.find((p) => p.id === "b")!
    expect(concept.filePath).toContain("/wiki/concepts/")
    expect(query.filePath).toContain("/wiki/queries/")

    // Body embeds the item description.
    expect(concept.pageContent).toContain("Alpha concept body")

    // index.md written once with both section entries; log written once.
    const writtenIndex = mockWriteFile.mock.calls.find(([p]) => p.includes("/index.md"))
    const writtenLog = mockWriteFile.mock.calls.find(([p]) => p.includes("/log.md"))
    expect(writtenIndex).toBeDefined()
    expect(writtenLog).toBeDefined()
    expect(String(writtenIndex![1])).toContain("## Concepts")
    expect(String(writtenLog![1])).toContain("Created 2 pages from review")
  })

  it("returns [] when passed no items", async () => {
    expect(await writeReviewPagesForItems("/proj", [])).toEqual([])
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})
