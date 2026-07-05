// P2P 피어 — 위브 노드를 실제 네트워크 클라이언트로 만든다.
//
// 모든 피어는 서버이자 클라이언트다(진짜 P2P). 중앙 서버가 없다:
//  - 부트스트랩: 아는 피어(시드) 몇 명에게 접속하면, PEERS 교환으로
//    네트워크의 다른 피어들을 알게 되어 그물망이 형성된다.
//  - 전파: 내 행위(줄서기 등)는 즉시 이웃에게 밀어 보내고(eager push),
//  - 수렴: 주기적 반보정(anti-entropy) 가십으로 "내가 가진 항목 목록(HAVE)"을
//    교환해 서로 빠진 항목을 채워 준다. 늦게 합류한 피어도 따라잡는다.
//  - 장애 허용: 피어가 죽어도 남은 피어끼리 계속 동작한다. 재접속하면 다시 수렴.
//
// 전송은 TCP + 개행 구분 JSON(NDJSON)이다. 위브 프로토콜 자체는 전송에
// 독립적이므로 같은 Peer 로직이 WebSocket/WebRTC(브라우저) 위에도 얹힌다.
//
// 신원: 데모에서는 HELLO 시 공개키를 자동 등록한다(개방 등록).
// 실제 시스템에서는 이 지점에 DID + 영지식 자격증명 검증이 들어간다 —
// "실존 유권자의 키인가"를 확인한 뒤에만 등록부에 올리는 것.
import net from 'node:net';
import { WeaveNode } from './node.js';
import { queueState, tips } from './queue.js';
import { sha256 } from '../blockchain.js';

// 카탈로그(목차) 주제 — 모든 피어가 기본으로 복제하는 예약 주제.
// "본문은 관심 있는 것만, 목차는 모두가": 이슈의 존재를 알리는 공표(ANNOUNCE)
// 항목만 담기므로 가볍고, 이것이 P2P 환경에서 전체 이슈 조회를 가능하게 한다.
// 공표는 일반 PROPOSE 항목이므로 줄서기(관심 표명)·안목 지수가 그대로 적용된다 —
// 중요한 이슈를 일찍 알아본 사람이 의제 설정 단계에서도 안목을 얻는다.
export const CATALOG = 't_@catalog';

export class Peer {
  constructor({ id, wallet, interests, registry, port = 0, seeds = [], gossipMs = 400, discovery = true }) {
    this.id = id;
    this.wallet = wallet; // 이 클라이언트 소유 시민의 지갑 — 개인키는 이 프로세스 밖으로 나가지 않는다
    this.node = new WeaveNode({ id, interests, registry: registry ?? new Map() });
    this.node.interests.add(CATALOG);
    if (wallet) this.node.registry.set(wallet.citizenId, wallet.publicKey);
    this.port = port;
    this.seeds = seeds;
    this.gossipMs = gossipMs;
    this.discovery = discovery; // false면 PEERS로 알게 된 피어에 자동 접속하지 않는다
    this.sockets = new Map(); // socket -> { hello }
    this.dialed = new Set(); // "host:port" 중복 접속 방지
    this.stopped = false;
    // 키워드 검색 상태
    this.seenSearches = new Set(); // 같은 질의를 두 번 처리/전파하지 않기 위한 qid 기록
    this.searchRoutes = new Map(); // qid -> 질의가 들어온 소켓 (결과를 되돌릴 역경로)
    this.pendingSearches = new Map(); // 내가 발신한 질의: qid -> { results }
  }

  async start() {
    this.server = net.createServer((socket) => this._setup(socket));
    await new Promise((resolve) => this.server.listen(this.port, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    for (const seed of this.seeds) this._dial(seed);
    this.timer = setInterval(() => this._gossip(), this.gossipMs);
    return this;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const socket of this.sockets.keys()) socket.destroy();
    this.server?.close();
  }

  get addr() {
    return { host: '127.0.0.1', port: this.port };
  }

  // ── 연결 관리 ─────────────────────────────────────────────
  _dial({ host = '127.0.0.1', port }) {
    const key = `${host}:${port}`;
    if (this.stopped || !port || port === this.port || this.dialed.has(key)) return;
    // 이미 상대가 나에게 접속해 온 경우 중복 회선을 만들지 않는다
    for (const { hello } of this.sockets.values()) {
      if (hello?.listenPort === port) return;
    }
    this.dialed.add(key);
    const socket = net.createConnection({ host, port });
    socket.on('error', () => this.dialed.delete(key));
    socket.on('connect', () => this._setup(socket));
  }

  _setup(socket) {
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!raw.trim()) continue;
        try {
          this._onMessage(socket, JSON.parse(raw));
        } catch {
          // 형식이 깨진 메시지는 무시 (적대적 입력 방어)
        }
      }
    });
    this.sockets.set(socket, { hello: null });
    this._send(socket, {
      type: 'HELLO',
      id: this.id,
      listenPort: this.port,
      interests: [...this.node.interests],
      identity: this.wallet
        ? { citizenId: this.wallet.citizenId, publicKey: this.wallet.publicKey, name: this.wallet.name }
        : null,
    });
  }

  _send(socket, msg) {
    if (!socket.destroyed) socket.write(JSON.stringify(msg) + '\n');
  }

  _peersList() {
    const peers = [];
    for (const { hello } of this.sockets.values()) {
      if (hello) peers.push({ host: '127.0.0.1', port: hello.listenPort });
    }
    return peers;
  }

  // ── 메시지 처리 ───────────────────────────────────────────
  _onMessage(socket, msg) {
    const meta = this.sockets.get(socket);
    if (!meta) return;
    switch (msg.type) {
      case 'HELLO': {
        meta.hello = msg;
        if (msg.identity) this._register(msg.identity);
        // 피어 발견: 내가 아는 피어들을 알려주고, 신원 등록부도 공유한다
        this._send(socket, { type: 'PEERS', peers: this._peersList() });
        this._send(socket, { type: 'REGISTRY', identities: this._identities() });
        break;
      }
      case 'PEERS':
        if (this.discovery) for (const p of msg.peers ?? []) this._dial(p);
        break;
      case 'REGISTRY':
        for (const identity of msg.identities ?? []) this._register(identity);
        break;
      case 'HAVE': {
        // 반보정: 상대가 가진 (작성자, 순번, 해시) 목록과 대조해 빠진 항목을 보낸다.
        // 해시까지 비교하므로 같은 순번의 상충 항목(이중 발언)도 서로에게 전달되어
        // 분기 증명이 자동으로 성립한다.
        if (!this.node.interests.has(msg.topicId)) break;
        const theirs = new Set();
        for (const [author, tokens] of Object.entries(msg.have ?? {})) {
          for (const token of tokens) theirs.add(`${author}:${token}`);
        }
        const missing = this.node
          .entriesForTopic(msg.topicId)
          .filter((e) => !theirs.has(`${e.author}:${e.seq}:${e.hash.slice(0, 16)}`));
        if (missing.length) this._send(socket, { type: 'ENTRIES', entries: missing });
        break;
      }
      case 'ENTRIES':
        for (const entry of msg.entries ?? []) this.node.ingest(entry);
        break;
      case 'SEARCH': {
        // 질의 전파(query flooding): 같은 질의는 한 번만 처리하고,
        // 내 로컬에서 찾은 결과를 질의가 온 소켓으로 되돌린 뒤 TTL을 줄여 이웃에 전달한다.
        if (this.seenSearches.has(msg.qid)) break;
        this.seenSearches.add(msg.qid);
        this.searchRoutes.set(msg.qid, socket);
        const found = this.searchLocal(msg.keyword);
        if (found.length) this._send(socket, { type: 'RESULTS', qid: msg.qid, results: found, foundBy: this.id });
        if (msg.ttl > 1) {
          for (const [s, m] of this.sockets) {
            if (s !== socket && m.hello) this._send(s, { type: 'SEARCH', qid: msg.qid, keyword: msg.keyword, ttl: msg.ttl - 1 });
          }
        }
        break;
      }
      case 'RESULTS': {
        const pending = this.pendingSearches.get(msg.qid);
        if (pending) {
          // 내가 발신한 질의의 결과: (주제, 의견) 기준으로 중복 제거하며 수집
          for (const r of msg.results ?? []) {
            const key = `${r.topicId}|${r.opinionId ?? ''}`;
            if (!pending.results.has(key)) pending.results.set(key, { ...r, foundBy: msg.foundBy });
          }
        } else {
          // 남의 질의의 결과: 질의가 들어왔던 역경로로 중계한다
          const route = this.searchRoutes.get(msg.qid);
          if (route) this._send(route, msg);
        }
        break;
      }
      case 'FORKS':
        for (const proof of msg.proofs ?? []) {
          if (proof?.a?.author && !this.node.forkProofs.has(proof.a.author)) {
            // 증명 자체를 검증한다: 두 항목이 실제로 같은 순번의 다른 서명인가
            const okA = this.node.ingest(proof.a);
            const okB = this.node.ingest(proof.b);
            void okA;
            void okB; // ingest가 분기를 감지해 forkProofs에 올린다
          }
        }
        break;
    }
  }

  _register(identity) {
    // 데모: 개방 등록. 실제로는 여기서 DID/영지식 자격증명을 검증한다.
    if (identity?.citizenId && identity?.publicKey && !this.node.registry.has(identity.citizenId)) {
      this.node.registry.set(identity.citizenId, identity.publicKey);
    }
  }

  _identities() {
    return [...this.node.registry.entries()].map(([citizenId, publicKey]) => ({ citizenId, publicKey }));
  }

  // ── 주기적 가십 (반보정 + 피어/신원 전파) ─────────────────
  _gossip() {
    for (const [socket, meta] of this.sockets) {
      if (!meta.hello) continue;
      this._send(socket, { type: 'PEERS', peers: this._peersList() });
      this._send(socket, { type: 'REGISTRY', identities: this._identities() });
      const shared = [...this.node.interests].filter((t) => meta.hello.interests.includes(t));
      for (const topicId of shared) {
        const have = {};
        for (const e of this.node.entriesForTopic(topicId)) {
          (have[e.author] ??= []).push(`${e.seq}:${e.hash.slice(0, 16)}`);
        }
        this._send(socket, { type: 'HAVE', topicId, have });
      }
      if (this.node.forkProofs.size) {
        this._send(socket, { type: 'FORKS', proofs: [...this.node.forkProofs.values()] });
      }
    }
  }

  // ── 전체 이슈 조회 (카탈로그) ─────────────────────────────
  // 새 이슈를 만들고 카탈로그에 공표한다. 공표 항목이 그 이슈의 "관심 줄" 머리가 된다.
  announceTopic({ title, description = '', domain = '' }) {
    const topicId = 't_' + sha256(`${title}|${this.wallet.citizenId}|${this.wallet.seq}`).slice(0, 12);
    this.follow(topicId); // 만든 사람은 당연히 구독
    const entry = this.act(CATALOG, 'PROPOSE', { title, body: description, topicId, domain });
    return { topicId, announceId: entry.hash };
  }

  // 네트워크에 존재하는 전체 이슈 목록: 카탈로그를 접으면 나온다.
  // interest = 관심 줄 길이(공표에 줄 선 시민 수), following = 내가 본문을 복제 중인가.
  catalog() {
    return queueState(this.node, CATALOG)
      .opinions.map((o) => {
        const announce = this.node.byHash.get(o.id);
        const topicId = announce?.data.topicId;
        return {
          topicId,
          title: o.title,
          description: o.body,
          domain: announce?.data.domain ?? '',
          announceId: o.id,
          interest: o.weight,
          standers: o.standers,
          following: topicId ? this.node.interests.has(topicId) : false,
          localEntries: topicId ? this.node.entriesForTopic(topicId).length : 0,
        };
      })
      .filter((c) => c.topicId);
  }

  // 이슈 구독: 지금부터 이 주제를 복제한다. 갱신된 관심사를 이웃에게 다시
  // 알리면(재-HELLO), 반보정 가십이 과거 항목 전체를 채워 준다.
  follow(topicId) {
    if (this.node.interests.has(topicId)) return;
    this.node.interests.add(topicId);
    for (const socket of this.sockets.keys()) {
      this._send(socket, {
        type: 'HELLO',
        id: this.id,
        listenPort: this.port,
        interests: [...this.node.interests],
        identity: this.wallet
          ? { citizenId: this.wallet.citizenId, publicKey: this.wallet.publicKey, name: this.wallet.name }
          : null,
      });
    }
  }

  // 관심 표명: 카탈로그의 공표 항목 줄에 선다 (구독과 함께)
  expressInterest(announceId) {
    const announce = this.node.byHash.get(announceId);
    if (!announce) throw new Error('알 수 없는 공표입니다');
    this.follow(announce.data.topicId);
    return this.act(CATALOG, 'JOIN', { opinionId: announceId, behind: tips(this.node, announceId) });
  }

  // ── 키워드 검색 ───────────────────────────────────────────
  // 두 층위로 동작한다:
  //  1. 이슈(목차) 검색 — 카탈로그는 전원 복제이므로 항상 로컬에서 완결된다.
  //  2. 본문(의견) 검색 — 나는 내가 복제한 주제만 뒤질 수 있으므로, 질의를
  //     이웃에게 흘려보내면(query flooding) 그 주제를 복제 중인 피어가 자기
  //     로컬을 뒤져 결과를 역경로로 돌려준다. "관심 있는 사람이 저장하고,
  //     저장한 사람이 검색해 준다" — 저장 구조와 검색 구조가 일치한다.
  // 규모 확장 시에는 DHT 역색인(키워드→주제 포인터)으로 대체한다.
  searchLocal(keyword) {
    const kw = String(keyword).toLowerCase();
    const results = [];
    const catalogItems = this.catalog();
    for (const c of catalogItems) {
      if (`${c.title} ${c.description} ${c.domain}`.toLowerCase().includes(kw)) {
        results.push({ kind: '이슈', topicId: c.topicId, title: c.title, announceId: c.announceId, interest: c.interest });
      }
    }
    for (const topicId of this.node.interests) {
      if (topicId === CATALOG) continue;
      for (const op of queueState(this.node, topicId).opinions) {
        if (`${op.title} ${op.body}`.toLowerCase().includes(kw)) {
          const cat = catalogItems.find((c) => c.topicId === topicId);
          results.push({
            kind: '의견',
            topicId,
            topicTitle: cat?.title ?? topicId,
            announceId: cat?.announceId ?? null,
            opinionId: op.id,
            title: op.title,
            weight: op.weight,
          });
        }
      }
    }
    return results;
  }

  // 네트워크 검색: 로컬 결과 + TTL 홉 안의 피어들이 찾아 준 결과를 모아 돌려준다.
  search(keyword, { ttl = 3, timeoutMs = 1500 } = {}) {
    const qid = sha256(`${this.id}|${Date.now()}|${Math.random()}`).slice(0, 16);
    this.seenSearches.add(qid);
    const results = new Map();
    for (const r of this.searchLocal(keyword)) {
      results.set(`${r.topicId}|${r.opinionId ?? ''}`, { ...r, foundBy: this.id });
    }
    this.pendingSearches.set(qid, { results });
    for (const [socket, meta] of this.sockets) {
      if (meta.hello) this._send(socket, { type: 'SEARCH', qid, keyword, ttl });
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        this.pendingSearches.delete(qid);
        resolve([...results.values()].sort((a, b) => (b.interest ?? b.weight ?? 0) - (a.interest ?? a.weight ?? 0)));
      }, timeoutMs);
    });
  }

  // ── 시민 행위: 로컬 서명 후 즉시 전파 ─────────────────────
  act(topicId, type, data) {
    if (!this.wallet) throw new Error('지갑 없는 관찰자 피어입니다');
    const entry = this.wallet.act(topicId, type, data);
    const result = this.node.ingest(entry);
    if (!result.accepted) throw new Error(`거부됨: ${result.reason}`);
    for (const [socket, meta] of this.sockets) {
      if (meta.hello?.interests.includes(topicId)) this._send(socket, { type: 'ENTRIES', entries: [entry] });
    }
    return entry;
  }
}
