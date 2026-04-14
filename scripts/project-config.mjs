import { basename } from "node:path";

export const TEMPLATE_PROJECT_NAME = "hono-github-cloudflare-template";
export const PLACEHOLDER_D1_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

export function sanitizeProjectName(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function resolveProjectName(packageName, cwd = process.cwd()) {
  const explicitName = process.env.PROJECT_NAME;
  if (explicitName) {
    return sanitizeProjectName(explicitName);
  }

  const githubRepository = process.env.GITHUB_REPOSITORY?.split("/").pop();
  if (githubRepository) {
    return sanitizeProjectName(githubRepository);
  }

  if (packageName && packageName !== TEMPLATE_PROJECT_NAME) {
    return sanitizeProjectName(packageName);
  }

  return sanitizeProjectName(basename(cwd));
}

export function getProjectDetails(packageName, cwd = process.cwd()) {
  const projectName = resolveProjectName(packageName, cwd);

  return {
    projectName,
    workerName: projectName,
    d1DatabaseName: `${projectName}-prod`,
    d1DatabaseId: process.env.CLOUDFLARE_D1_DATABASE_ID || PLACEHOLDER_D1_DATABASE_ID,
  };
}