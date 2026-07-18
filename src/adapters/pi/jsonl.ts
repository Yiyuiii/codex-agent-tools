export interface LfJsonlDecoderOptions {
  maxRecordBytes?: number;
  maxBufferedBytes?: number;
}

export interface LfJsonlFinishResult {
  incomplete?: string;
}

export class LfJsonlDecoder {
  readonly #maxRecordBytes: number;
  readonly #maxBufferedBytes: number;
  #buffer = Buffer.alloc(0);

  public constructor(options: LfJsonlDecoderOptions = {}) {
    this.#maxRecordBytes = options.maxRecordBytes ?? 1_048_576;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? this.#maxRecordBytes;
  }

  public push(chunk: Uint8Array): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    if (this.#buffer.length > this.#maxBufferedBytes && !this.#buffer.includes(0x0a)) {
      throw new Error(
        `Pi RPC buffered record exceeds ${this.#maxBufferedBytes} bytes`,
      );
    }

    const records: unknown[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      let record = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (record.at(-1) === 0x0d) record = record.subarray(0, -1);
      if (record.length > this.#maxRecordBytes) {
        throw new Error(`Pi RPC record exceeds ${this.#maxRecordBytes} bytes`);
      }
      try {
        records.push(JSON.parse(record.toString("utf8")) as unknown);
      } catch (error) {
        throw new Error(
          `Invalid Pi RPC JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (this.#buffer.length > this.#maxBufferedBytes) {
      throw new Error(
        `Pi RPC buffered record exceeds ${this.#maxBufferedBytes} bytes`,
      );
    }
    return records;
  }

  public finish(): LfJsonlFinishResult {
    if (this.#buffer.length === 0) return {};
    let tail = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    if (tail.at(-1) === 0x0d) tail = tail.subarray(0, -1);
    return { incomplete: tail.toString("utf8") };
  }
}
