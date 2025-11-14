import net from "node:net";

type TCPPonn = {
  socket: net.Socket;
  err: null | Error;
  ended: boolean;
  reader: null | {
    resolve: (value: Buffer) => void;
    reject: (reason: Error) => void;
  };
};

type DynBuf = {
  data: Buffer;
  length: number;
};

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

function cutMessage(buf: DynBuf): null | Buffer {
  const idx = buf.data.subarray(0, buf.length).indexOf("\n");
  if (idx < 0) {
    return null;
  }
  const msg = Buffer.from(buf.data.subarray(0, idx + 1));
  bufPop(buf, idx + 1);
  return msg;
}

function soInit(socket: net.Socket): TCPPonn {
  const conn: TCPPonn = {
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

function soRead(conn: TCPPonn): Promise<Buffer> {
  console.assert(!conn.reader);
  return new Promise((resolve, reject) => {
    conn.reader = { resolve, reject };
    conn.socket.resume();
  });
}

function soWrite(conn: TCPPonn, data: Buffer): Promise<void> {
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

async function serverClient(socket: net.Socket): Promise<void> {
  const conn = soInit(socket);
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
  while (true) {
    const msg: null | Buffer = cutMessage(buf);
    if (!msg) {
      const data = await soRead(conn);
      bufPush(buf, data);
      // EOF?
      if (data.length === 0) {
        return;
      }
      continue;
    }
    if (msg.equals(Buffer.from("quit\n"))) {
      await soWrite(conn, Buffer.from("Bye.\n"));
      socket.destroy();
      return;
    } else {
      const reply = Buffer.concat([Buffer.from("Echo: "), msg]);
      await soWrite(conn, reply);
    }
  }
}

async function newConn(socket: net.Socket) {
  console.log("new connection", socket.remoteAddress, socket.remotePort);
  try {
    await serverClient(socket);
  } catch (error) {
    console.error("exception:", error);
  } finally {
    socket.destroy();
  }
}

const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
server.on("connection", newConn);
server.on("error", (err: Error) => {
  throw err;
});

server.listen(1234, "127.0.0.1", () => {
  console.log("Echo server is listening on port 1234");
});
