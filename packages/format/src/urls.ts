export function httpUrl(value: string, base?: string) {
  const url = new URL(value, base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP(S) URL without credentials.");
  return url.href;
}

/** A map's immutable content reference is an identity, never an HTTP fetch target. */
export function mapReference(
  value: string,
  base?: string,
  expectedRoot?: string,
) {
  if (typeof value !== "string") throw new Error("Invalid map reference");
  if (value.startsWith("htree:")) {
    const match = /^htree:\/\/([a-f0-9]{64})$/.exec(value);
    if (!match) throw new Error("Invalid Hashtree map reference");
    if (expectedRoot !== undefined && match[1] !== expectedRoot)
      throw new Error("Map reference and Hashtree root disagree");
    return value;
  }
  return httpUrl(value, base);
}
