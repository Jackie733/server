import { readerFromMemory } from "./index.ts";
import type { HTTPRes } from "./types.ts";

export class HTTPError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "HTTPError";
    this.code = code;
  }
}

export function respError(code: number, message: string): HTTPRes {
  return {
    code,
    headers: [Buffer.from("Content-Type: text/plain")],
    body: readerFromMemory(Buffer.from(`${code} ${message}\n`)),
  };
}
