import { IssueRow } from '../services/api.service';

function hasHtmlTag(value: string): boolean {
  return /<\s*[a-zA-Z!/][^>]*>/.test(value);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMetaContent(raw: string, key: string): string {
  const decoded = decodeEntities(raw);
  const patterns = [
    new RegExp(`${key}"\\s+content="([^"]+)"`, 'i'),
    new RegExp(`${key}'\\s+content='([^']+)'`, 'i'),
    new RegExp(`${key}"\\s+content=([^\\s][^>]+)`, 'i'),
  ];
  for (const p of patterns) {
    const m = decoded.match(p);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return '';
}

function cleanNaturalText(value: string): string {
  const decoded = decodeEntities(value);
  const cut = decoded
    .split(/Suggested meta tags:|Recommended actions:|Model SEO score/i)[0]
    .replace(/^Overview:\s*/i, '');
  return oneLine(cut);
}

function looksLikeAnalysisText(value: string): boolean {
  return /currently lacks|recommended actions|model seo score|search visibility|effectiveness/i.test(value);
}

export function formatSeoSnippet(issue: IssueRow): string {
  const raw = String(issue.code_snippet || issue.ai_suggestion || '').trim();
  const type = String(issue.issue_type || '').toLowerCase();
  if (!raw) return '';
  const decodedRaw = decodeEntities(raw);
  if (hasHtmlTag(decodedRaw)) return decodedRaw;

  const normalized = cleanNaturalText(raw);

  if (type === 'missing_meta_description') {
    const extracted = extractMetaContent(raw, 'name="description"') || normalized;
    if (!extracted || looksLikeAnalysisText(extracted) || extracted.length > 220) return '';
    return `<meta name="description" content="${extracted.replace(/"/g, '&quot;')}">`;
  }
  if (type === 'missing_title' || type === 'duplicate_title') {
    const extracted = extractMetaContent(raw, 'name="title"') || normalized;
    if (!extracted || looksLikeAnalysisText(extracted) || extracted.length > 90) return '';
    return `<title>${extracted}</title>`;
  }
  if (type === 'missing_h1' || type === 'multiple_h1') {
    if (!normalized || looksLikeAnalysisText(normalized) || normalized.length > 90) return '';
    return `<h1>${normalized}</h1>`;
  }
  if (type === 'missing_canonical') {
    return `<link rel="canonical" href="${normalized}">`;
  }
  if (type === 'low_word_count') {
    return `<p>${normalized}</p>`;
  }
  if (type === 'images_without_alt') {
    const alt = normalized || 'Descriptive image text';
    return `<img src="/path-to-image.jpg" alt="${alt}">`;
  }
  if (type === 'broken_links' || type === 'invalid_or_nonfunctional_link') {
    return `<a href="/valid-destination">Relevant anchor text</a>`;
  }
  if (type === 'slow_page') {
    return `<!-- Performance fix example -->\n<link rel="preload" href="/critical.css" as="style">`;
  }
  return `<!-- SEO fix snippet -->\n<p>${normalized}</p>`;
}
