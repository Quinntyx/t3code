export interface DiscoverEnrollmentUrl {
  readonly brokerOrigin: string;
  readonly code: string;
}

export function parseDiscoverEnrollmentUrl(value: string): DiscoverEnrollmentUrl | null {
  try {
    const url = new URL(value.trim());
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/discover" ||
      url.search !== ""
    )
      return null;
    const params = new URLSearchParams(url.hash.slice(1));
    const code = params.get("token")?.trim();
    if (!code || params.size !== 1) return null;
    return { brokerOrigin: url.origin, code };
  } catch {
    return null;
  }
}
