import { getGithubRepo, getGithubRepoParts, getGithubToken } from './secrets.service';
import { logger } from '../utils/logger';

interface CreateIssueResult {
  htmlUrl: string | null;
  number: number | null;
  error?: string;
}

export async function createGithubIssue(params: {
  title: string;
  body: string;
}): Promise<CreateIssueResult> {
  const token = getGithubToken();
  const repo = getGithubRepo();
  if (!token || !repo) {
    return { htmlUrl: null, number: null, error: 'GitHub token or GITHUB_REPO not configured' };
  }

  const parts = getGithubRepoParts();
  const owner = parts.owner || repo.split('/').filter(Boolean)[0];
  const name = parts.repo || repo.split('/').filter(Boolean)[1];
  if (!owner || !name) {
    return { htmlUrl: null, number: null, error: 'GITHUB_REPO must be owner/repo' };
  }

  const url = `https://api.github.com/repos/${owner}/${name}/issues`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: params.title, body: params.body }),
    });

    if (!res.ok) {
      const t = await res.text();
      logger.error('GitHub API error', { status: res.status, body: t });
      return { htmlUrl: null, number: null, error: t || res.statusText };
    }

    const data = (await res.json()) as { html_url?: string; number?: number };
    return { htmlUrl: data.html_url ?? null, number: data.number ?? null };
  } catch (e) {
    logger.error('GitHub fetch failed', { error: String(e) });
    return { htmlUrl: null, number: null, error: String(e) };
  }
}

export function formatIssueBody(parts: { pageUrl: string; issue: string; aiFix: string }): string {
  return [
    '## Page URL',
    parts.pageUrl,
    '',
    '## Detected issue',
    parts.issue,
    '',
    '## AI suggested fix',
    parts.aiFix,
  ].join('\n');
}
