export interface TextMatchSegment {
  readonly match: boolean;
  readonly text: string;
}

const escapeRegExp = (value: string): string =>
  value.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&");

export const splitTextMatches = (
  value: string,
  query: string,
): readonly TextMatchSegment[] => {
  if (query === "") {
    return [{ match: false, text: value }];
  }

  const segments: TextMatchSegment[] = [];
  let offset = 0;
  for (const match of value.matchAll(new RegExp(escapeRegExp(query), "giu"))) {
    if (match.index > offset) {
      segments.push({ match: false, text: value.slice(offset, match.index) });
    }
    segments.push({ match: true, text: match[0] });
    offset = match.index + match[0].length;
  }
  if (offset < value.length) {
    segments.push({ match: false, text: value.slice(offset) });
  }
  return segments;
};
