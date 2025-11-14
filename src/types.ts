import net from "node:net";

export type HTTPReq = {
  method: string;
  uri: Buffer;
  version: string;
  headers: Buffer[];
};

export type HTTPRes = {
  code: number;
  headers: Buffer[];
  body: BodyReader;
};

export type BodyReader = {
  // the 'Content-Length', -1 if unknown.
  length: number;
  // read data. returns an empty buffer after EOF
  read: () => Promise<Buffer>;
  // optional cleanups
  close?: () => Promise<void>;
};

export type TCPConn = {
  socket: net.Socket;
  err: null | Error;
  ended: boolean;
  reader: null | {
    resolve: (value: Buffer) => void;
    reject: (reason: Error) => void;
  };
};

export type DynBuf = {
  data: Buffer;
  length: number;
};

export type BufferGenerator = AsyncGenerator<Buffer, void, void>;
