import { config } from '../config/config';
import { getSetting } from './db.service';

/** Runtime secrets: env first, then SQLite settings (dashboard). Never send to frontend. */
export function getOpenAiKey(): string {
  return config.openaiApiKey || getSetting('OPENAI_API_KEY') || '';
}

export function getGithubToken(): string {
  return config.githubToken || getSetting('GITHUB_TOKEN') || '';
}

export function getGithubRepo(): string {
  return config.githubRepo || getSetting('GITHUB_REPO') || '';
}

export function getGithubRepoParts(): { owner: string; repo: string } {
  const owner = getSetting('GITHUB_REPO_OWNER') || '';
  const repo = getSetting('GITHUB_REPO_NAME') || '';
  if (owner && repo) return { owner, repo };
  const legacy = getGithubRepo();
  const [legacyOwner, legacyRepo] = legacy.split('/').filter(Boolean);
  return { owner: legacyOwner || '', repo: legacyRepo || '' };
}

export function getEmailConfig(): {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
} {
  const host = config.email.host || getSetting('EMAIL_HOST') || '';
  const port = parseInt(getSetting('EMAIL_PORT') || String(config.email.port), 10) || config.email.port;
  const user = config.email.user || getSetting('EMAIL_USER') || '';
  const pass = config.email.pass || getSetting('EMAIL_PASS') || '';
  const from = config.email.from || getSetting('EMAIL_FROM') || '';
  return { host, port, user, pass, from };
}
