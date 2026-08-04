import { describe, expect, it } from "vitest"
import type { ReviewItem } from "@/stores/review-store"
import { createReviewPageDrafts } from "./review-create-page"

function review(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    id: "review-1",
    type: "missing-page",
    title: "Missing page",
    description: "",
    options: [],
    resolved: false,
    createdAt: 0,
    ...overrides,
  }
}

describe("createReviewPageDrafts", () => {
  it("creates one entity page per missing entity named in Chinese review text", () => {
    const drafts = createReviewPageDrafts(
      review({
        title: "核心测试项实体页缺失：CallMethod、StartFunc、Print",
        description: "缺少 CallMethod、StartFunc、Print 等实体页面。",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "CallMethod", pageType: "entity", dir: "entities" },
      { title: "StartFunc", pageType: "entity", dir: "entities" },
      { title: "Print", pageType: "entity", dir: "entities" },
    ])
  })

  it("keeps non-missing review creation as a single query page", () => {
    const drafts = createReviewPageDrafts(
      review({
        type: "suggestion",
        title: "Create: Policy version gap",
        description: "Review the policy changes.",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "Policy version gap", pageType: "query", dir: "queries" },
    ])
  })

  it("does not emit a spurious colon-prefixed duplicate for 'Missing page: X'", () => {
    // Regression: the englishMissing fallback previously captured the colon,
    // producing both "Alpha" and a junk ": Alpha" page for "Missing page: Alpha".
    const drafts = createReviewPageDrafts(
      review({ title: "Missing page: Alpha", description: "" }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "Alpha", pageType: "concept", dir: "concepts" },
    ])
    expect(drafts.some((d) => d.title.includes(":"))).toBe(false)
  })
})

