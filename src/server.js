// 실시간 민주주의 서버
// 의존성 없는 Node.js HTTP 서버: JSON API + SSE 실시간 스트림 + 정적 파일 제공
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Democracy } from './democracy.js';
import { seed } from './seed.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const democracy = new Democracy();
seed(democracy);

// ── SSE 실시간 스트림 ────────────────────────────────────────
const sseClients = new Set();
function broadcast(event = 'update') {
  const payload = `event: ${event}\ndata: ${Date.now()}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// ── 시뮬레이션: 가상의 시민 활동으로 실시간 변동을 보여준다 ──
let simTimer = null;
const SIM_INTERVAL_MS = 1800;
function simulationStep() {
  try {
    const state = democracy.getState();
    const citizens = state.citizens;
    const allOpinions = state.issues.flatMap((i) => i.opinions);
    if (!citizens.length) return;
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const roll = Math.random();
    if (roll < 0.45 && allOpinions.length) {
      // 지지 또는 철회 — 여론은 실시간으로 움직인다
      const c = pick(citizens);
      const o = pick(allOpinions);
      democracy.setSupport(c.id, o.id, !o.supporters.includes(c.id));
    } else if (roll < 0.6 && allOpinions.length) {
      const c = pick(citizens);
      const o = pick(allOpinions);
      democracy.addEvidence(c.id, o.id, `시뮬레이션 근거: ${o.title}에 대한 추가 자료 제출 (${new Date().toLocaleTimeString('ko-KR')})`);
    } else if (roll < 0.72 && allOpinions.length) {
      const c = pick(citizens);
      const o = pick(allOpinions);
      democracy.addChallenge(c.id, o.id, `시뮬레이션 반론: ${o.title}의 비용 추계에 의문 제기`);
    } else if (roll < 0.85) {
      const c = pick(citizens);
      const domain = pick(state.domains);
      const others = citizens.filter((x) => x.id !== c.id);
      if (others.length) {
        // 위임하거나 (30% 확률로) 즉시 회수한다
        democracy.delegate(c.id, domain, Math.random() < 0.3 ? null : pick(others).id);
      }
    } else {
      const c = pick(citizens);
      const issue = pick(state.issues);
      democracy.propose(
        c.id,
        issue.id,
        `${issue.domain} 대안 ${Math.floor(Math.random() * 900 + 100)}`,
        `${issue.title}에 대한 새로운 접근을 제안합니다.`
      );
    }
    broadcast();
  } catch {
    // 시뮬레이션 오류는 무시 (데모 안정성)
  }
}

// ── 요청 처리 ────────────────────────────────────────────────
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    // 실시간 이벤트 스트림
    if (route === 'GET /api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('event: hello\ndata: connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (route === 'GET /api/state') return json(res, 200, democracy.getState());
    if (route === 'GET /api/chain') return json(res, 200, { blocks: democracy.chain.toJSON(), ...democracy.chain.verify() });

    if (route === 'POST /api/citizens') {
      const { name } = await readBody(req);
      const c = democracy.registerCitizen(name);
      broadcast();
      return json(res, 201, { id: c.id, name: c.name });
    }
    if (route === 'POST /api/opinions') {
      const { citizenId, issueId, title, body } = await readBody(req);
      const o = democracy.propose(citizenId, issueId, title, body);
      broadcast();
      return json(res, 201, { id: o.id });
    }
    if (route === 'POST /api/support') {
      const { citizenId, opinionId, on } = await readBody(req);
      democracy.setSupport(citizenId, opinionId, Boolean(on));
      broadcast();
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/delegate') {
      const { citizenId, domain, delegateId } = await readBody(req);
      democracy.delegate(citizenId, domain, delegateId || null);
      broadcast();
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/evidence') {
      const { citizenId, opinionId, text, url: evUrl } = await readBody(req);
      democracy.addEvidence(citizenId, opinionId, text, evUrl);
      broadcast();
      return json(res, 201, { ok: true });
    }
    if (route === 'POST /api/challenge') {
      const { citizenId, opinionId, text } = await readBody(req);
      democracy.addChallenge(citizenId, opinionId, text);
      broadcast();
      return json(res, 201, { ok: true });
    }
    if (route === 'POST /api/simulation') {
      const { on } = await readBody(req);
      if (on && !simTimer) simTimer = setInterval(simulationStep, SIM_INTERVAL_MS);
      if (!on && simTimer) {
        clearInterval(simTimer);
        simTimer = null;
      }
      broadcast();
      return json(res, 200, { running: Boolean(simTimer) });
    }
    if (route === 'GET /api/simulation') return json(res, 200, { running: Boolean(simTimer) });

    // 정적 파일
    if (req.method === 'GET') {
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = normalize(join(PUBLIC_DIR, pathname));
      if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: '접근 금지' });
      try {
        const content = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
        return res.end(content);
      } catch {
        return json(res, 404, { error: '찾을 수 없음' });
      }
    }

    return json(res, 404, { error: '알 수 없는 경로' });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`아고라 라이브 — 실시간 민주주의 시스템`);
  console.log(`http://localhost:${PORT} 에서 실행 중`);
});
