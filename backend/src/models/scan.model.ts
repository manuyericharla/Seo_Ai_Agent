export interface CrawlPageResult {
  url: string;
  title: string;
  metaDescription: string;
  canonical: string;
  h1Count: number;
  h2Count: number;
  wordCount: number;
  headings: string[];
  links: string[];
  imagesWithoutAlt: number;
  brokenLinks: string[];
  /** Footer / social-style links with #, empty, javascript:, or missing href (broken “click”). */
  invalidNavLinks: { href: string; reason: string; context: string }[];
  images?: {
    src: string;
    alt: string;
    suggestedAlt?: string;
  }[];
  loadTimeMs: number;
  contentSnippet?: string;
}

export type IssueType =
  | 'missing_title'
  | 'missing_meta_description'
  | 'multiple_h1'
  | 'broken_links'
  | 'invalid_or_nonfunctional_link'
  | 'images_without_alt'
  | 'slow_page';

export interface SeoIssue {
  type: IssueType | string;
  pageUrl: string;
  message: string;
  details?: string;
}

/** AI audit issue row (from model JSON). */
export interface AiIssueItem {
  type: string;
  severity: 'high' | 'medium' | 'low';
  description: string;
  fix: string;
}

/** Full per-page SEO report (one OpenAI response per page). */
export interface SeoPageReport {
  url: string;
  seoScore: number;
  scoreBreakdown?: {
    content: number;
    technical: number;
    backlinks: number;
    onPage: number;
    ux: number;
    weightedTotal: number;
  };
  keywordInsights?: {
    targetKeyword: string;
    keywordPlacementScore: number;
    rankingProbability: number;
    opportunityScore?: number;
    trendBoost?: number;
  };
  backlinkInsights?: {
    internalReferringPages: number;
    uniqueExternalDomainsLinked: number;
    externalLinksCount: number;
    internalAuthorityScore: number;
    backlinkQualityScore: number;
  };
  performanceMetrics?: {
    source: 'pagespeed' | 'crawl_estimate';
    lcpMs?: number;
    fcpMs?: number;
    cls?: number;
    inpMs?: number;
    ttfbMs?: number;
    lighthousePerformanceScore?: number;
    lighthouseSeoScore?: number;
    lighthouseAccessibilityScore?: number;
    lighthouseBestPracticesScore?: number;
  };
  issues: AiIssueItem[];
  suggestedTitle: string;
  suggestedMetaDescription: string;
  contentImprovements: string[];
  internalLinkSuggestions: string[];
  pasteReadyFixes?: {
    issueType: string;
    issueSummary: string;
    improvedContent: string;
  }[];
  improvedContent?: {
    h1?: string;
    title?: string;
    metaDescription?: string;
    bodyCopy?: string;
  };
}

/** @deprecated use SeoPageReport */
export interface AiPageAnalysis {
  seoScore: number;
  suggestedMetaTags: { name?: string; property?: string; content: string }[];
  contentImprovements: string[];
  summary: string;
}

export interface ScanRecord {
  id: number;
  domainId: number;
  startedAt: string;
  completedAt: string | null;
  pagesCount: number;
  seoScoreAvg: number | null;
  status: string;
  emailSent: number;
  emailSentAt: string | null;
  emailError: string | null;
  githubIssuesCreated: number;
  schedulerRun: number;
}

export interface DomainRecord {
  id: number;
  domain: string;
  createdAt: string;
}

export interface IssueRecord {
  id: number;
  scanId: number;
  pageUrl: string;
  issueType: string;
  message: string;
  aiSuggestion: string | null;
  status: string;
  githubIssueUrl: string | null;
  seoScore?: number | null;
  codeSnippet?: string | null;
  codeDiff?: string | null;
  githubPrUrl?: string | null;
  githubPrBranch?: string | null;
}
