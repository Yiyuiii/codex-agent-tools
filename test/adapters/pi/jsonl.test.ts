import { describe, expect, it } from "vitest";

import { LfJsonlDecoder } from "../../../src/adapters/pi/jsonl.js";

describe("LfJsonlDecoder", () => {
  it("splits only on LF, accepts CRLF, and retains an incomplete tail", () => {
    const decoder = new LfJsonlDecoder();
    expect(decoder.push(Buffer.from('{"text":"a b"}\r'))).toEqual([]);
    expect(decoder.push(Buffer.from('\n{"n":1'))).toEqual([
      { text: "a b" },
    ]);
    expect(decoder.finish()).toEqual({ incomplete: '{"n":1' });
  });

  it("decodes several fragmented records without treating U+2029 as a delimiter", () => {
    const decoder = new LfJsonlDecoder();
    expect(decoder.push(Buffer.from('{"a":'))).toEqual([]);
    expect(
      decoder.push(Buffer.from('1}\n{"text":"x y"}\n')),
    ).toEqual([{ a: 1 }, { text: "x y" }]);
    expect(decoder.finish()).toEqual({});
  });

  it("rejects invalid JSON and records beyond its byte limit", () => {
    expect(() => new LfJsonlDecoder().push(Buffer.from("not-json\n"))).toThrow(
      /Invalid Pi RPC JSON/u,
    );
    const decoder = new LfJsonlDecoder({ maxRecordBytes: 8 });
    expect(() => decoder.push(Buffer.from('{"long":1}\n'))).toThrow(
      /exceeds 8 bytes/u,
    );
  });
});
