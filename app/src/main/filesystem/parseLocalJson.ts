export const parseLocalJson = (source: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    const location =
      cause instanceof SyntaxError
        ? / at position \d+ \(line (\d+) column (\d+)\)$/u.exec(cause.message)
        : null;
    throw new SyntaxError(
      location === null
        ? "Invalid JSON"
        : `Invalid JSON at line ${location[1]} column ${location[2]}`,
    );
  }
};
