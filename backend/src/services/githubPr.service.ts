import { getSetting } from './db.service';
import { getGithubToken } from './secrets.service';
import { logger } from '../utils/logger';

type GithubSettings = {
  token: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  contentRootFolder: string;
  fileExtension: string;
};

type GithubContentResponse = {
  sha: string;
  content?: string;
  encoding?: string;
};

type CreatePrInput = {
  pageUrl: string;
  issue: string;
  codeSnippet: string;
};

export type CreatePrResult = {
  ok: boolean;
  branch?: string;
  pullRequestUrl?: string;
  filePath?: string;
  error?: string;
};

type CompositeSeoInput = {
  title?: string;
  metaDescription?: string;
  h1?: string;
  bodyCopy?: string;
};

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

export function normalizeSnippetForIssue(issueType: string, rawSnippet: string): string {
  const raw = String(rawSnippet || '').trim();
  if (!raw) return '';
  const decodedRaw = decodeEntities(raw);
  if (hasHtmlTag(decodedRaw)) return decodedRaw;
  const type = oneLine(issueType).toLowerCase();
  const normalized = cleanNaturalText(raw);

  if (type === 'missing_meta_description') {
    const extracted = extractMetaContent(raw, 'name="description"') || normalized;
    return `<meta name="description" content="${extracted.replace(/"/g, '&quot;')}">`;
  }
  if (type === 'missing_title' || type === 'duplicate_title') {
    const extracted = extractMetaContent(raw, 'name="title"') || normalized;
    return `<title>${extracted}</title>`;
  }
  if (type === 'missing_h1' || type === 'multiple_h1') return `<h1>${normalized}</h1>`;
  if (type === 'missing_canonical') return `<link rel="canonical" href="${normalized}">`;
  if (type === 'low_word_count') return `<p>${normalized}</p>`;
  if (type === 'images_without_alt') return `<img src="/path-to-image.jpg" alt="${normalized || 'Descriptive image text'}">`;
  if (type === 'broken_links' || type === 'invalid_or_nonfunctional_link') {
    return `<a href="/valid-destination">Relevant anchor text</a>`;
  }
  if (type === 'slow_page') return `<!-- Performance fix example -->\n<link rel="preload" href="/critical.css" as="style">`;
  return `<!-- SEO fix snippet -->\n<p>${normalized}</p>`;
}

export function buildCompositeSeoSnippet(input: CompositeSeoInput): string {
  const lines: string[] = [];
  if (input.title?.trim()) lines.push(`<title>${input.title.trim()}</title>`);
  if (input.metaDescription?.trim()) {
    lines.push(`<meta name="description" content="${input.metaDescription.trim().replace(/"/g, '&quot;')}">`);
  }
  if (input.h1?.trim()) lines.push(`<h1>${input.h1.trim()}</h1>`);
  if (input.bodyCopy?.trim()) lines.push(`<p>${input.bodyCopy.trim()}</p>`);
  return lines.join('\n');
}

function extractTag(snippet: string, pattern: RegExp): string | null {
  const match = snippet.match(pattern);
  return match?.[0] ?? null;
}

function applyCompositeSeoFix(existingContent: string, snippet: string): string {
  let content = existingContent || '';
  const titleTag = extractTag(snippet, /<title>[\s\S]*?<\/title>/i);
  const metaTag = extractTag(snippet, /<meta[^>]+name=["']description["'][^>]*>/i);
  const h1Tag = extractTag(snippet, /<h1>[\s\S]*?<\/h1>/i);
  const pTag = extractTag(snippet, /<p>[\s\S]*?<\/p>/i);

  if (titleTag) {
    if (/<title>[\s\S]*?<\/title>/i.test(content)) content = content.replace(/<title>[\s\S]*?<\/title>/i, titleTag);
    else if (/<\/head>/i.test(content)) content = content.replace(/<\/head>/i, `  ${titleTag}\n</head>`);
    else content += `\n${titleTag}\n`;
  }

  if (metaTag) {
    if (/<meta[^>]+name=["']description["'][^>]*>/i.test(content)) {
      content = content.replace(/<meta[^>]+name=["']description["'][^>]*>/i, metaTag);
    } else if (/<\/head>/i.test(content)) {
      content = content.replace(/<\/head>/i, `  ${metaTag}\n</head>`);
    } else {
      content += `\n${metaTag}\n`;
    }
  }

  if (h1Tag) {
    if (/<h1>[\s\S]*?<\/h1>/i.test(content)) content = content.replace(/<h1>[\s\S]*?<\/h1>/i, h1Tag);
    else if (/<body[^>]*>/i.test(content)) content = content.replace(/<body[^>]*>/i, (m) => `${m}\n  ${h1Tag}`);
    else content += `\n${h1Tag}\n`;
  }

  if (pTag) {
    if (/<main[^>]*>/i.test(content)) content = content.replace(/<main[^>]*>/i, (m) => `${m}\n  ${pTag}`);
    else if (/<body[^>]*>/i.test(content)) content = content.replace(/<body[^>]*>/i, (m) => `${m}\n  ${pTag}`);
    else content += `\n${pTag}\n`;
  }

  return content;
}

function normalizeFileExtension(ext: string): string {
  const clean = ext.trim();
  if (!clean) return '.html';
  return clean.startsWith('.') ? clean : `.${clean}`;
}

function getGithubSettings(): GithubSettings {
  const token = getGithubToken() || '';
  const owner = getSetting('GITHUB_REPO_OWNER') || '';
  const repo = getSetting('GITHUB_REPO_NAME') || '';
  const defaultBranch = getSetting('GITHUB_DEFAULT_BRANCH') || 'main';
  const contentRootFolder = (getSetting('GITHUB_CONTENT_ROOT_FOLDER') || '').replace(/^\/+|\/+$/g, '');
  const fileExtension = normalizeFileExtension(getSetting('GITHUB_FILE_EXTENSION') || '.html');
  return { token, owner, repo, defaultBranch, contentRootFolder, fileExtension };
}

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function ghFetch<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...baseHeaders(token),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

function slugifyPathForBranch(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    const slug = u.pathname.replace(/(^\/+|\/+$)/g, '').replace(/[^a-zA-Z0-9/_-]+/g, '-').replace(/\//g, '-');
    return slug || 'home';
  } catch {
    return 'page';
  }
}

function resolveFilePath(pageUrl: string, rootFolder: string, ext: string): string {
  let pathPart = 'index';
  try {
    const url = new URL(pageUrl);
    const cleanPath = url.pathname.replace(/\/+$/, '');
    pathPart = cleanPath && cleanPath !== '/' ? cleanPath.replace(/^\/+/, '') : 'index';
  } catch {
    pathPart = 'index';
  }
  const withExt = pathPart.endsWith(ext) ? pathPart : `${pathPart}${ext}`;
  return rootFolder ? `${rootFolder}/${withExt}` : withExt;
}

function decodeGithubContent(content?: string, encoding?: string): string {
  if (!content) return '';
  if (encoding !== 'base64') return content;
  return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
}

function buildMetaDescriptionTag(snippet: string): string {
  if (/<meta[^>]+name=["']description["']/i.test(snippet)) return snippet.trim();
  return `<meta name="description" content="${snippet.trim().replace(/"/g, '&quot;')}">`;
}

function applySeoFixToContent(existingContent: string, issueType: string, snippet: string): string {
  const content = existingContent || '';
  const safeSnippet = snippet.trim();
  if (!safeSnippet) return content;
  if (issueType === 'page_seo_content_update') {
    return applyCompositeSeoFix(content, safeSnippet);
  }

  if (issueType === 'missing_meta_description') {
    const metaTag = buildMetaDescriptionTag(safeSnippet);
    if (/<meta[^>]+name=["']description["'][^>]*>/i.test(content)) {
      return content.replace(/<meta[^>]+name=["']description["'][^>]*>/i, metaTag);
    }
    if (/<\/head>/i.test(content)) {
      return content.replace(/<\/head>/i, `  ${metaTag}\n</head>`);
    }
    return `${content}\n${metaTag}\n`;
  }

  if (issueType === 'missing_title' || issueType === 'duplicate_title') {
    if (/<title>[\s\S]*?<\/title>/i.test(content)) {
      return content.replace(/<title>[\s\S]*?<\/title>/i, `<title>${safeSnippet}</title>`);
    }
    if (/<\/head>/i.test(content)) {
      return content.replace(/<\/head>/i, `  <title>${safeSnippet}</title>\n</head>`);
    }
    return `${content}\n<title>${safeSnippet}</title>\n`;
  }

  if ((issueType === 'missing_h1' || issueType === 'multiple_h1') && /<body[^>]*>/i.test(content)) {
    return content.replace(/<body[^>]*>/i, (m) => `${m}\n  ${safeSnippet}`);
  }

  return `${content}\n${safeSnippet}\n`;
}

export function buildDiffPreview(beforeContent: string, afterContent: string): string {
  const beforeLines = beforeContent.split('\n').slice(0, 80);
  const afterLines = afterContent.split('\n').slice(0, 80);
  return ['--- before', '+++ after', '', ...beforeLines.map((l) => `- ${l}`), ...afterLines.map((l) => `+ ${l}`)].join(
    '\n'
  );
}

export async function createGithubPullRequestForSeoFix(input: CreatePrInput): Promise<CreatePrResult> {
  const settings = getGithubSettings();
  if (!settings.token || !settings.owner || !settings.repo) {
    return { ok: false, error: 'GitHub token/owner/repository settings are required.' };
  }

  const branch = `seo-fix-${slugifyPathForBranch(input.pageUrl)}-${Date.now()}`;
  const filePath = resolveFilePath(input.pageUrl, settings.contentRootFolder, settings.fileExtension);
  const repoBase = `https://api.github.com/repos/${settings.owner}/${settings.repo}`;

  try {
    const baseRef = await ghFetch<{ object: { sha: string } }>(
      `${repoBase}/git/ref/heads/${encodeURIComponent(settings.defaultBranch)}`,
      settings.token
    );

    await ghFetch<{ ref: string }>(`${repoBase}/git/refs`, settings.token, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: baseRef.object.sha,
      }),
    });

    const currentFile = await ghFetch<GithubContentResponse>(
      `${repoBase}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
      settings.token
    ).catch(() => ({ sha: '', content: '', encoding: 'base64' }));

    const before = decodeGithubContent(currentFile.content, currentFile.encoding);
    const normalizedSnippet =
      input.issue === 'page_seo_content_update'
        ? input.codeSnippet.trim()
        : normalizeSnippetForIssue(input.issue, input.codeSnippet);
    const after = applySeoFixToContent(before, input.issue, normalizedSnippet);
    const encodedAfter = Buffer.from(after, 'utf8').toString('base64');

    await ghFetch<{ content: { sha: string } }>(`${repoBase}/contents/${encodeURIComponent(filePath)}`, settings.token, {
      method: 'PUT',
      body: JSON.stringify({
        message: `SEO Fix: ${input.issue} for ${input.pageUrl}`,
        content: encodedAfter,
        branch,
        sha: currentFile.sha || undefined,
      }),
    });

    const pr = await ghFetch<{ html_url: string }>(`${repoBase}/pulls`, settings.token, {
      method: 'POST',
      body: JSON.stringify({
        title: `SEO Fix: ${input.issue} for ${input.pageUrl}`,
        head: branch,
        base: settings.defaultBranch,
        body: [
          'Automated AI SEO fix generated by SEO Agent.',
          '',
          `- Page: ${input.pageUrl}`,
          `- Issue: ${input.issue}`,
          '',
          'Suggested code:',
          '```html',
          normalizedSnippet,
          '```',
        ].join('\n'),
      }),
    });

    return {
      ok: true,
      branch,
      pullRequestUrl: pr.html_url,
      filePath,
    };
  } catch (e) {
    logger.error('createGithubPullRequestForSeoFix failed', {
      pageUrl: input.pageUrl,
      issue: input.issue,
      error: String(e),
    });
    return { ok: false, error: String(e) };
  }
}
