export class PrivacyConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrivacyConfigurationError";
    this.code = "privacy_configuration_error";
  }
}

function normalizedSegment(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en-US");
}

export function parseExcludedSegments(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const segments = [...new Set(values.map(normalizedSegment).filter(Boolean))];
  if (
    segments.some(
      (segment) =>
        segment.includes("/") ||
        segment.includes("\\") ||
        segment === "." ||
        segment === "..",
    )
  ) {
    throw new PrivacyConfigurationError("Excluded segments must be single path segments");
  }
  if (!segments.length) {
    throw new PrivacyConfigurationError("At least one excluded segment is required");
  }
  return Object.freeze(segments);
}

export function containsExcludedSegment(relativePath, segments) {
  const excluded = parseExcludedSegments(segments);
  return String(relativePath ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .some((segment) => excluded.includes(normalizedSegment(segment)));
}
