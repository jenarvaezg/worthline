export function contributionDrawerUrl(href: string, occurrenceId: string | null): string {
  const url = new URL(href, "http://worthline.local");
  if (occurrenceId) {
    url.searchParams.set("reconcile", occurrenceId);
    url.hash = "contributionDrawer";
  } else {
    url.searchParams.delete("reconcile");
    url.hash = "";
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
