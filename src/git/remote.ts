/**
 * Parse a git remote URL, for **any** forge.
 *
 * A sibling plugin's `refs.ts` is deliberately `/github\.com[/:]/` because it
 * is a GitHub plugin. This one cannot be: the whole point is that everything
 * except the pull-request transition works on GitLab, Bitbucket, Gitea, Azure
 * DevOps and self-hosted anything.
 *
 * Used for display and for the Linear attachment URL — **not** for pull-request
 * transitions, which go through bb's own `environments.pullRequest` and are
 * therefore `gh`-gated whatever this returns.
 *
 * The cases that actually appear and that a naive `owner/repo` split gets
 * wrong:
 *
 *   - **GitLab subgroups.** `gitlab.com/group/subgroup/project` is three
 *     segments and the project is the last one, not the second.
 *   - **Azure DevOps.** `dev.azure.com/org/project/_git/repo`.
 *   - **Non-default ports.** `ssh://git@host:2222/owner/repo.git`.
 *   - **Userinfo.** `https://user:token@host/owner/repo` — the token is
 *     stripped before the value is stored, logged or rendered, because a
 *     remote URL with a credential in it is a credential in a log line.
 */

export interface ParsedRemote {
  readonly host: string;
  /** Everything before the repository name, `/`-joined. Empty for a
   *  single-segment path. */
  readonly owner: string;
  readonly repo: string;
  /** A browsable URL, with any userinfo removed. */
  readonly webUrl: string;
}

export function parseRemote(raw: string | null | undefined): ParsedRemote | null {
  if (typeof raw !== "string") return null;
  const input = raw.trim();
  if (input === "") return null;

  // Local paths and `file://` are repositories with no forge. Not an error —
  // a project with no remote is supported, and the automation simply goes
  // quiet.
  if (input.startsWith("/") || input.startsWith(".") || input.startsWith("file://")) return null;

  const scp = /^(?:([^@/]+)@)?([^:/]+):(?!\/\/)(.+)$/.exec(input);
  const parts = scp !== null ? { host: scp[2]!, path: scp[3]! } : fromUrl(input);
  if (parts === null) return null;

  const segments = parts.path
    .replace(/\.git$/i, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length === 0) return null;

  // Azure DevOps puts a literal `_git` between the project and the repository.
  const gitIndex = segments.indexOf("_git");
  const cleaned = gitIndex === -1 ? segments : [...segments.slice(0, gitIndex), ...segments.slice(gitIndex + 1)];
  if (cleaned.length === 0) return null;

  const repo = cleaned[cleaned.length - 1]!;
  const owner = cleaned.slice(0, -1).join("/");

  return {
    host: parts.host,
    owner,
    repo,
    webUrl: `https://${parts.host}/${cleaned.join("/")}`,
  };
}

function fromUrl(input: string): { host: string; path: string } | null {
  try {
    // `git://` and `ssh://` are not special-cased: `URL` parses both, and the
    // port is dropped from `hostname` for free.
    const url = new URL(input);
    if (url.hostname === "") return null;
    return { host: url.hostname, path: url.pathname };
  } catch {
    return null;
  }
}

/**
 * The last-resort branch → identifier match.
 *
 * Linear's own `issueVcsBranchSearch` is the primary resolver and it already
 * understands the workspace's `gitBranchFormat`, its magic-word suffixes and
 * any custom convention — **do not write this regex as the first attempt.**
 * This exists only for when Linear returns null, and its result is recorded as
 * a `regex` resolution so the UI can be less confident about it.
 */
export function identifierFromBranch(branchName: string): string | null {
  const match = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,7})-(\d{1,6})(?:$|[^0-9])/.exec(
    branchName.toUpperCase(),
  );
  if (match === null) return null;
  return `${match[1]}-${match[2]}`;
}
