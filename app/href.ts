/**
 * Allow-list the scheme before a remote value becomes an `href`.
 *
 * React does not sanitize `href`, so a `javascript:` URL in a mirror row
 * would execute on click. The mirror's `url` fields are Linear-generated
 * (`https://linear.app/...`) in every honest case — this guard is for the
 * dishonest one, where a compromised API response is one click from script
 * execution. Anything but http(s) renders as no link at all.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined) return undefined;
  return /^https?:\/\//i.test(url) ? url : undefined;
}
