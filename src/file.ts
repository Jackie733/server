export interface FileReadResult {
  bytesRead: number;
  buffer: Buffer;
}

export interface FileReadOptions {
  buffer?: Buffer;
  offset?: number | null;
  length?: number | null;
  position?: number | null;
}
