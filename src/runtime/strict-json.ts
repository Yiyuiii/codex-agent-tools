function invalidStrictJson(): never {
  throw new Error("Strict JSON bytes are invalid.");
}

function assertNoDuplicateJsonObjectKeys(text: string): void {
  let index = 0;
  const whitespace = (): void => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };
  const jsonString = (): string => {
    if (text[index] !== '"') invalidStrictJson();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index)) as string;
      }
      index += character === "\\" ? 2 : 1;
    }
    return invalidStrictJson();
  };
  const value = (): void => {
    whitespace();
    if (text[index] === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = jsonString();
        if (keys.has(key)) invalidStrictJson();
        keys.add(key);
        whitespace();
        if (text[index] !== ":") invalidStrictJson();
        index += 1;
        value();
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") invalidStrictJson();
        index += 1;
      }
    }
    if (text[index] === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (true) {
        value();
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") invalidStrictJson();
        index += 1;
      }
    }
    if (text[index] === '"') {
      jsonString();
      return;
    }
    const token = text
      .slice(index)
      .match(
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u,
      )?.[0];
    if (token === undefined) invalidStrictJson();
    index += token.length;
  };
  value();
  whitespace();
  if (index !== text.length) invalidStrictJson();
}

export function parseStrictJsonBytes(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) invalidStrictJson();
    assertNoDuplicateJsonObjectKeys(text);
    return JSON.parse(text) as unknown;
  } catch {
    return invalidStrictJson();
  }
}
