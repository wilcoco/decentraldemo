#!/usr/bin/env node
// 신호 중계 서버 — 브라우저 피어들의 "만남의 장소" (의존성 0)
//
// 역할은 딱 두 가지뿐이다:
//  1. 정적 파일 제공: 브라우저 피어 앱(공용 집계 코드 포함)을 내려준다.
//  2. WebRTC 신호 중계: 브라우저끼리 직접 연결(P2P)을 맺는 데 필요한
//     SDP/ICE 메시지를 상대에게 전달한다.
//
// 중요한 것은 이 서버가 "보지 못하는 것"이다: 연결이 성립되는 순간부터
// 모든 위브 데이터(제안·지지·반대·위임)는 브라우저 사이의 WebRTC 데이터
// 채널로 직접 흐른다. 이 서버는 누가 무엇을 지지하는지 알 수 없고, 죽어도
// 이미 연결된 피어들은 계속 동작한다 — 전화번호부일 뿐 전화국이 아니다.
//
//   node bin/signal.js [--port 8080]
//   브라우저 여러 개(또는 여러 기기)에서 http://<호스트>:8080 접속
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(
  process.argv.includes('--port')
    ? process.argv[process.argv.indexOf('--port') + 1]
    : process.env.PORT ?? 8080
);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// ── 정적 파일: /p2p 앱과, 브라우저가 직접 import 하는 공용 코어(/src/weave) ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = url.pathname;
  if (pathname === '/') pathname = '/public/home/index.html'; // 안내 홈페이지 (취지 설명)
  else if (pathname === '/app') pathname = '/public/p2p/index.html'; // 피어 앱 — 접속 즉시 참여
  if (pathname.startsWith('/p2p/')) pathname = '/public' + pathname;
  if (pathname.startsWith('/home/')) pathname = '/public' + pathname;
  // 허용 경로: 안내 페이지, 브라우저 앱, 공용 코어만 (그 외는 차단)
  if (
    !pathname.startsWith('/public/p2p/') &&
    !pathname.startsWith('/public/home/') &&
    !pathname.startsWith('/src/weave/')
  ) {
    res.writeHead(404);
    return res.end('없음');
  }
  const filePath = normalize(join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('금지');
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('없음');
  }
});

// ── WebSocket 신호 중계 (RFC 6455 최소 구현) ─────────────────
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WS_MSG = 256 * 1024; // 신호 메시지 크기 상한
const clients = new Map(); // id -> { socket }
let nextId = 1;

function wsSend(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  if (!socket.destroyed) socket.write(Buffer.concat([header, payload]));
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const id = `p${nextId++}`;
  clients.set(id, { socket });
  socket.on('error', () => {});
  socket.on('close', () => {
    clients.delete(id);
    for (const { socket: s } of clients.values()) wsSend(s, { type: 'peer-left', id });
  });

  // 입장: 내 id와 기존 피어 목록을 준다 — 신규 피어가 기존 피어들에게 연결을 건다
  wsSend(socket, { type: 'welcome', id, peers: [...clients.keys()].filter((x) => x !== id) });
  for (const [otherId, { socket: s }] of clients) {
    if (otherId !== id) wsSend(s, { type: 'peer-joined', id });
  }

  // 프레임 파서
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_WS_MSG) return socket.destroy(); // 폭탄 방어
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (len > MAX_WS_MSG) return socket.destroy();
      const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (buffer.length < offset + len) return; // 프레임 미완성 — 다음 청크 대기
      let payload = buffer.subarray(offset, offset + len);
      buffer = buffer.subarray(offset + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      if (opcode === 8) return socket.destroy(); // close
      if (opcode === 9) {
        // ping → pong
        if (!socket.destroyed) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode !== 1) continue; // 텍스트만 처리
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        // 유일한 기능: 지목된 상대에게 신호를 전달한다. 내용은 해석하지 않는다.
        if (msg.type === 'signal' && clients.has(msg.to)) {
          wsSend(clients.get(msg.to).socket, { type: 'signal', from: id, payload: msg.payload });
        }
      } catch {
        // 깨진 메시지 무시
      }
    }
  });
});

server.listen(PORT, () => {
  console.log('아고라 라이브 — 브라우저 P2P 신호 서버');
  console.log(`http://localhost:${PORT} 를 브라우저 여러 개에서 여세요 (각 탭/기기가 피어가 됩니다)`);
  console.log('이 서버는 연결만 중개하며, 시민들의 데이터는 보지 못합니다.');
});
