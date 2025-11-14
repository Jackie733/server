import net from "node:net";
import fs from "node:fs/promises";
import { HTTPError, respError } from "./HTTPError.ts";
import type {
  HTTPReq,
  HTTPRes,
  BodyReader,
  TCPConn,
  DynBuf,
  BufferGenerator,
} from "./types.ts";

/* UTILITIES */

async function* countSheep(): BufferGenerator {
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    yield Buffer.from(`${i}\n`);
  }
}

function bufPush(buf: DynBuf, data: Buffer) {
  const newLen = buf.length + data.length;
  if (buf.data.length < newLen) {
    let cap = Math.max(buf.data.length, 32);
    while (cap < newLen) {
      cap *= 2;
    }
    const grown = Buffer.alloc(cap);
    buf.data.copy(grown, 0, 0);
    buf.data = grown;
  }
  data.copy(buf.data, buf.length, 0);
  buf.length = newLen;
}

function bufPop(buf: DynBuf, len: number) {
  buf.data.copyWithin(0, len, buf.length);
  buf.length -= len;
}

function soInit(socket: net.Socket): TCPConn {
  const conn: TCPConn = {
    socket: socket,
    err: null,
    ended: false,
    reader: null,
  };
  socket.on("data", (data: Buffer) => {
    console.assert(conn.reader);
    conn.socket.pause();
    conn.reader!.resolve(data);
    conn.reader = null;
  });
  socket.on("end", () => {
    conn.ended = true;
    if (conn.reader) {
      conn.reader.resolve(Buffer.from(""));
      conn.reader = null;
    }
  });
  socket.on("error", (err: Error) => {
    conn.err = err;
    if (conn.reader) {
      conn.reader.reject(err);
      conn.reader = null;
    }
  });
  return conn;
}

function soRead(conn: TCPConn): Promise<Buffer> {
  console.assert(!conn.reader);
  return new Promise((resolve, reject) => {
    conn.reader = { resolve, reject };
    conn.socket.resume();
  });
}

function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
  console.assert(data.length > 0);
  return new Promise((resolve, reject) => {
    if (conn.err) {
      reject(conn.err);
      return;
    }
    conn.socket.write(data, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function bufExpectMore(
  conn: TCPConn,
  buf: DynBuf,
  context: string,
): Promise<void> {
  const data = await soRead(conn);
  bufPush(buf, data);
  if (data.length === 0) {
    throw new Error(`Unexpected EOF while reading ${context}.`);
  }
}

// the maximum length of an HTTP hader
const kMaxHeaderLen = 1024 * 8;

// parse & remove a header from the beginning of the buffer if possible
function cutMessage(buf: DynBuf): null | HTTPReq {
  const idx = buf.data.subarray(0, buf.length).indexOf("\r\n\r\n");
  if (idx < 0) {
    if (buf.length >= kMaxHeaderLen) {
      throw new HTTPError(413, "header is too large");
    }
    return null;
  }
  // parse and remove the header
  const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
  bufPop(buf, idx + 4);
  return msg;
}

// parse an HTTP request header
function parseHTTPReq(data: Buffer): HTTPReq {
  // split the data into lines
  const lines: Buffer[] = splitLines(data);
  if (lines.length === 0) {
    throw new HTTPError(400, "empty request.");
  }
  const firstLine = lines[0];
  if (!firstLine) {
    throw new HTTPError(400, "missing request line.");
  }
  // the first line is `METHOD URI VERSION`
  const [method, uri, version] = parseRequestLine(firstLine);
  // the following lines are header fields in the format of `Name: value`
  const headers: Buffer[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line && line.length > 0) {
      const h = Buffer.from(line);
      if (!validateHeader(h)) {
        throw new HTTPError(400, "bad field.");
      }
      headers.push(h);
    }
  }
  // the header ends by an empty line
  console.assert(lines[lines.length - 1]?.length === 0);
  return { method, uri, version, headers };
}

function splitLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < data.length - 1; i++) {
    // \r\n
    if (data[i] === 0x0d && data[i + 1] === 0x0a) {
      lines.push(data.subarray(start, i));
      start = i + 2;
      i++; // skip \n
    }
  }
  if (start < data.length) {
    lines.push(data.subarray(start));
  }
  return lines;
}

function parseRequestLine(line: Buffer): [string, Buffer, string] {
  const parts = line.toString().split(" ");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new HTTPError(400, "Invalid request line.");
  }
  return [parts[0], Buffer.from(parts[1]), parts[2]];
}

function validateHeader(header: Buffer): boolean {
  return header.indexOf(":") > 0;
}

function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
  let bodyLen = -1;
  const contentLen = fieldGet(req.headers, "Content-Length");
  if (contentLen) {
    bodyLen = parseInt(contentLen.toString());
    if (isNaN(bodyLen)) {
      throw new HTTPError(400, "Invalid Content-Length.");
    }
  }
  const bodyAllowed = !(req.method === "GET" || req.method === "HEAD");
  const chunked =
    fieldGet(req.headers, "Transfer-Encoding")?.equals(
      Buffer.from("chunked"),
    ) || false;
  if (!bodyAllowed && (bodyLen > 0 || chunked)) {
    throw new HTTPError(400, "Body not allowed for this method.");
  }
  if (!bodyAllowed) {
    bodyLen = 0;
  }
  if (bodyLen >= 0) {
    // 'Content-Length' is present
    return readerFromConnLength(conn, buf, bodyLen);
  } else if (chunked) {
    // chunked encoding
    return readerFromGenerator(readChunks(conn, buf));
  } else {
    // TODO: read the rest of the connection
    throw new HTTPError(400, "Missing Content-Length or Transfer-Encoding.");
  }
}

function fieldGet(headers: Buffer[], key: string): null | Buffer {
  const lowerKey = key.toLocaleLowerCase();
  for (const h of headers) {
    const idx = h.indexOf(":");
    if (idx > 0) {
      const name = h.subarray(0, idx).toString().toLocaleLowerCase();
      if (name === lowerKey) {
        const value = h
          .toString()
          .substring(key.length + 1)
          .trim();
        return Buffer.from(value);
      }
    }
  }
  return null;
}

// decode the chunked encoding and yield the data on the fly
async function* readChunks(conn: TCPConn, buf: DynBuf): BufferGenerator {
  for (let last = false; !last; ) {
    // read the chunk size line
    const idx = buf.data.subarray(0, buf.length).indexOf("\r\n");
    if (idx < 0) {
      // need more data, omitted ...
      continue;
    }
    // parse the chunk-size and remove the line
    const chunkSizeLine = buf.data.subarray(0, idx).toString("latin1");
    let remain = parseInt(chunkSizeLine, 16);
    if (isNaN(remain)) {
      throw new Error("Invalid chunk size");
    }
    // remove chunk size line + CRLF
    bufPop(buf, idx + 2);
    last = remain === 0;
    // read and yield the chunk data
    while (remain > 0) {
      if (buf.length === 0) {
        await bufExpectMore(conn, buf, "chunk data");
      }
      const consume = Math.min(remain, buf.length);
      const data = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      remain -= consume;
      yield data;
    }
    // the chunk data is followed by CRLF
    // omitted ...
    bufPop(buf, 2);
  }
}

function readerFromConnLength(
  conn: TCPConn,
  buf: DynBuf,
  remain: number,
): BodyReader {
  return {
    length: remain,
    read: async (): Promise<Buffer> => {
      if (remain === 0) {
        return Buffer.from("");
      }
      if (buf.length === 0) {
        // try to get some data if there is none
        const data = await soRead(conn);
        bufPush(buf, data);
        if (data.length === 0) {
          throw new Error("Unexpected EOF from HTTP body");
        }
      }
      // consume data from the buffer
      const consume = Math.min(buf.length, remain);
      remain -= consume;
      const data = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      return data;
    },
  };
}

export function readerFromMemory(data: Buffer): BodyReader {
  let done = false;
  return {
    length: data.length,
    read: async (): Promise<Buffer> => {
      if (done) {
        return Buffer.from("");
      } else {
        done = true;
        return data;
      }
    },
  };
}

function readerFromGenerator(gen: BufferGenerator): BodyReader {
  return {
    length: -1,
    read: async (): Promise<Buffer> => {
      const r = await gen.next();
      if (r.done) {
        return Buffer.from(""); // EOF
      } else {
        return r.value;
      }
    },
  };
}

function readerFromStaticFile(fp: fs.FileHandle, size: number): BodyReader {
  let got = 0; // bytes read so far
  return {
    length: size,
    read: async (): Promise<Buffer> => {
      const r: fs.FileReadResult<Buffer> = await fp.read();
      got += r.bytesRead;
      if (got > size || (got < size && r.bytesRead === 0)) {
        // unhappy case: file size changed.
        // cannot continue since we have sent the 'Content-Length'
        throw new Error("file size changed, abandon it!");
      }
      // NOTE: the automatically allocated buffer may be larger
      return r.buffer.subarray(0, r.bytesRead);
    },
    close: async () => await fp.close(),
  };
}

async function serveStaticFile(path: string): Promise<HTTPRes> {
  let fp: null | fs.FileHandle = null;
  try {
    fp = await fs.open(path, "r");
    const stat = await fp.stat();
    if (!stat.isFile()) {
      return respError(404, "Not a file");
    }
    const size = stat.size;
    const reader: BodyReader = readerFromStaticFile(fp, size);
    fp = null;
    return { code: 200, headers: [], body: reader };
  } catch (error) {
    return respError(400, "Not Found");
  } finally {
    await fp?.close();
  }
}

async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
  let resp: BodyReader;
  const uri = req.uri.toString("utf8");
  if (uri.startsWith("/files/")) {
    // server files from the current working directory
    return await serveStaticFile(uri.substr("/files/".length));
  }
  switch (uri) {
    case "/echo":
      resp = body;
      break;
    case "/sheep":
      resp = readerFromGenerator(countSheep());
    default:
      resp = readerFromMemory(Buffer.from("hello world.\n"));
      break;
  }

  return {
    code: 200,
    headers: [Buffer.from("Server: my_first_http_server")],
    body: resp,
  };
}

function getStatusText(code: number): string {
  switch (code) {
    case 200:
      return "OK";
    case 400:
      return "Bad Request";
    case 404:
      return "Not Found";
    case 413:
      return "Payload Too Large";
    case 500:
      return "Internal Server Error";
    default:
      return "Unknown";
  }
}

function encodeHTTPResp(resp: HTTPRes): Buffer {
  const statueLine = `HTTP/1.1 ${resp.code} ${getStatusText(resp.code)}\r\n`;
  let headerStr = statueLine;
  for (const header of resp.headers) {
    headerStr += header.toString() + "\r\n";
  }
  headerStr += "\r\n";
  return Buffer.from(headerStr);
}

// send an HTTP response through the socket
async function writeHTTPResp(conn: TCPConn, resp: HTTPRes): Promise<void> {
  if (resp.body.length < 0) {
    resp.headers.push(Buffer.from("Transfer-Encoding: chunked"));
  } else {
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
  }
  // write the header
  await soWrite(conn, encodeHTTPResp(resp));
  // write the body
  const crlf = Buffer.from("\r\n");
  for (let last = false; !last; ) {
    let data = await resp.body.read();
    last = data.length === 0; // ended?
    // chunked encoding
    if (resp.body.length < 0) {
      data = Buffer.concat([
        Buffer.from(data.length.toString(16)),
        crlf,
        data,
        crlf,
      ]);
    }
    if (data.length) {
      await soWrite(conn, data);
    }
  }
}

async function serverClient(conn: TCPConn): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
  while (true) {
    const msg = cutMessage(buf);
    if (!msg) {
      const data = await soRead(conn);
      bufPush(buf, data);
      // EOF?
      if (data.length === 0 && buf.length === 0) {
        return;
      }
      if (data.length === 0) {
        throw new HTTPError(400, "Unexpected EOF.");
      }
      continue;
    }

    const reqBody: BodyReader = readerFromReq(conn, buf, msg);
    const res: HTTPRes = await handleReq(msg, reqBody);
    try {
      await writeHTTPResp(conn, res);
    } finally {
      await res.body.close?.();
    }
    if (msg.version === "1.0") {
      return;
    }
    while ((await reqBody.read()).length > 0) {
      //
    }
  }
}

async function newConn(socket: net.Socket) {
  console.log("new connection", socket.remoteAddress, socket.remotePort);
  const conn: TCPConn = soInit(socket);
  try {
    await serverClient(conn);
  } catch (error) {
    console.error("exception:", error);
    if (error instanceof HTTPError) {
      const resp: HTTPRes = {
        code: error.code,
        headers: [],
        body: readerFromMemory(Buffer.from(error.message + "\n")),
      };
      try {
        await writeHTTPResp(conn, resp);
      } catch (exc) {
        // ignore
      }
    }
  } finally {
    socket.destroy();
  }
}

const server = net.createServer({
  allowHalfOpen: true,
  pauseOnConnect: true,
  noDelay: true,
});
server.on("connection", newConn);
server.on("error", (err: Error) => {
  throw err;
});

server.listen(1234, "127.0.0.1", () => {
  console.log("Echo server is listening on port 1234");
});
