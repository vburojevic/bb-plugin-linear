/**
 * Accounts: the bridge from key slots to live, identified Linear workspaces.
 *
 * One transport per slot, created lazily and kept for the plugin's lifetime.
 * The transport never captures the key — its session reads the slot's setting
 * fresh on every request — so a key replaced while bb is running takes effect
 * on the next request with no reload and no rebuild. What *is* cached is the
 * discovered identity, keyed by the credential's fingerprint: swap the key in
 * a slot and the stale identity invalidates itself on the next read.
 */

import { z } from "zod";
import {
  credentialFingerprint,
  patFromSetting,
  type LinearCredential,
} from "./linear/credential.js";
import { unwrapMutation } from "./linear/client.js";
import { ISSUE_CREATE, TEAMS_SLIM, VIEWER } from "./linear/documents.js";
import { describeError, mutationFailed, refused } from "./linear/errors.js";
import {
  createTransport,
  type LinearTransport,
  type LogLevel,
} from "./linear/transport.js";
import { KEY_SLOTS, rawKeyForSlot, type KeySlot, type LinearSettings } from "./settings.js";

/* ── Wire shapes, validated rather than trusted ──────────────────────────── */
/*
 * The transport returns `unknown`; these schemas are where the plugin decides
 * what it actually relies on. `.passthrough()` is deliberately absent — a
 * field the schema does not name is a field the plugin must not depend on.
 */

const viewerSchema = z.object({
  viewer: z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string(),
    email: z.string(),
    avatarUrl: z.string().nullish(),
    organization: z.object({
      id: z.string(),
      name: z.string(),
      urlKey: z.string(),
      gitBranchFormat: z.string().nullish(),
    }),
  }),
});

const teamsSchema = z.object({
  teams: z.object({
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullish(),
    }),
    nodes: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })),
  }),
});

const issueCreateSchema = z.object({
  issueCreate: z.object({
    success: z.boolean(),
    issue: z
      .object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        url: z.string(),
        branchName: z.string(),
        team: z.object({ id: z.string(), key: z.string() }).nullish(),
      })
      .nullish(),
  }),
});

export interface AccountIdentity {
  readonly userId: string;
  readonly userName: string;
  readonly displayName: string;
  readonly email: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly orgUrlKey: string;
  readonly gitBranchFormat: string | null;
}

export interface AccountTeam {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

export interface CreatedIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly branchName: string;
}

export interface AccountsSessionHost {
  getSettings(): Promise<LinearSettings>;
  log(level: LogLevel, message: string): void;
  /** Aborts for the plugin's lifetime (reload/disable/shutdown). */
  signal?: AbortSignal;
  now?(): number;
}

export interface Accounts {
  /** Slots that currently hold a non-empty key, in display order. */
  configuredSlots(): Promise<KeySlot[]>;
  /** The slot's transport (lazy; stable per slot for budget/breaker state). */
  transport(slot: KeySlot): LinearTransport;
  /**
   * Who this slot's key is, from cache unless `force` or the key changed.
   * Throws a LinearError when the key is missing, revoked, or unreachable.
   */
  identity(slot: KeySlot, options?: { force?: boolean }): Promise<AccountIdentity>;
  /** All teams visible to this slot, across pages. */
  teams(slot: KeySlot): Promise<AccountTeam[]>;
  createIssue(
    slot: KeySlot,
    input: { teamId: string; title: string; description?: string },
  ): Promise<CreatedIssue>;
}

export function createAccounts(host: AccountsSessionHost): Accounts {
  const transports = new Map<KeySlot, LinearTransport>();
  const identities = new Map<KeySlot, { fingerprint: string; identity: AccountIdentity }>();

  async function credentialForSlot(slot: KeySlot): Promise<LinearCredential | null> {
    const settings = await host.getSettings();
    return patFromSetting(rawKeyForSlot(settings, slot));
  }

  function transport(slot: KeySlot): LinearTransport {
    let existing = transports.get(slot);
    if (existing === undefined) {
      existing = createTransport({
        getCredential: () => credentialForSlot(slot),
        log: (level, message) => host.log(level, `[slot ${slot}] ${message}`),
        signal: host.signal,
        now: host.now,
      });
      transports.set(slot, existing);
    }
    return existing;
  }

  return {
    async configuredSlots() {
      const settings = await host.getSettings();
      return KEY_SLOTS.filter(
        (slot) => patFromSetting(rawKeyForSlot(settings, slot)) !== null,
      );
    },

    transport,

    async identity(slot, options = {}) {
      const credential = await credentialForSlot(slot);
      if (credential === null) {
        throw refused(`No Linear API key is set in slot ${slot}.`);
      }
      const fingerprint = credentialFingerprint(credential);
      const cached = identities.get(slot);
      if (!options.force && cached !== undefined && cached.fingerprint === fingerprint) {
        return cached.identity;
      }

      const data = await transport(slot).execute<unknown>(VIEWER);
      const parsed = viewerSchema.safeParse(data);
      if (!parsed.success) {
        throw mutationFailed(
          `Linear answered Viewer in a shape this plugin does not recognise: ${describeError(parsed.error)}`,
        );
      }
      const viewer = parsed.data.viewer;
      const identity: AccountIdentity = {
        userId: viewer.id,
        userName: viewer.name,
        displayName: viewer.displayName,
        email: viewer.email,
        orgId: viewer.organization.id,
        orgName: viewer.organization.name,
        orgUrlKey: viewer.organization.urlKey,
        gitBranchFormat: viewer.organization.gitBranchFormat ?? null,
      };
      identities.set(slot, { fingerprint, identity });
      return identity;
    },

    async teams(slot) {
      const all: AccountTeam[] = [];
      let after: string | null = null;
      // Bounded: 50 pages of 100 teams is far past any real workspace, and a
      // bound means a cursor bug cannot become an infinite paid loop.
      for (let page = 0; page < 50; page += 1) {
        const data = await transport(slot).execute<unknown>(TEAMS_SLIM, {
          variables: { first: 100, after },
        });
        const parsed = teamsSchema.safeParse(data);
        if (!parsed.success) {
          throw mutationFailed(
            `Linear answered TeamsSlim in a shape this plugin does not recognise: ${describeError(parsed.error)}`,
          );
        }
        all.push(...parsed.data.teams.nodes);
        if (!parsed.data.teams.pageInfo.hasNextPage) break;
        after = parsed.data.teams.pageInfo.endCursor ?? null;
        if (after === null) break;
      }
      return all;
    },

    async createIssue(slot, input) {
      const data = await transport(slot).execute<unknown>(ISSUE_CREATE, {
        variables: {
          input: {
            teamId: input.teamId,
            title: input.title,
            ...(input.description === undefined
              ? {}
              : { description: input.description }),
          },
        },
      });
      const parsed = issueCreateSchema.safeParse(data);
      if (!parsed.success) {
        throw mutationFailed(
          `Linear answered IssueCreate in a shape this plugin does not recognise: ${describeError(parsed.error)}`,
        );
      }
      const issue = unwrapMutation<NonNullable<typeof parsed.data.issueCreate.issue>>(
        parsed.data.issueCreate,
        "issue",
        "create the issue",
      );
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        branchName: issue.branchName,
      };
    },
  };
}
