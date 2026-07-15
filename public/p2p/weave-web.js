// 브라우저 피어 코어 — 브라우저 자체가 시민 클라이언트가 된다.
//
//  - 지갑: 키는 이 브라우저의 WebCrypto에서 생성되어 이 기기를 떠나지 않는다.
//  - 노드: Node 피어와 동일한 저장·검증 규칙 (부분 복제, 서명 검증, 분기 증명).
//  - 메시: WebRTC 데이터 채널로 브라우저끼리 직접 연결. 신호 서버는 연결
//    성립까지만 쓰이는 전화번호부이고, 이후 데이터는 P2P로만 흐른다.
//  - 집계: /src/weave/queue.js·insight.js 를 그대로 import — 서버 피어와
//    한 글자도 다르지 않은 코드로 배심 추첨·지위·안목을 계산한다.
import { sha256 } from '/src/weave/hash.js';

const subtle = crypto.subtle;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const pem = (spkiB64) =>
  `-----BEGIN PUBLIC KEY-----\n${spkiB64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
const spkiFromPem = (p) => unb64(p.replace(/-----[^-]+-----|\s/g, ''));

// 서명 대상 직렬화 — Node의 entry.js 와 동일한 규칙
export function canonical(e) {
  return JSON.stringify({
    author: e.author,
    seq: e.seq,
    prevHash: e.prevHash,
    topicId: e.topicId,
    type: e.type,
    data: e.data,
    ts: e.ts,
  });
}
export const entryHash = (e) => sha256(canonical(e));
export const isFork = (a, b) => a.author === b.author && a.seq === b.seq && a.hash !== b.hash;

// ── 지갑: 개인키는 이 브라우저에만 존재한다 ─────────────────
export class BrowserWallet {
  static async create(name) {
    const w = new BrowserWallet();
    w.name = name;
    const saved = localStorage.getItem('agora-wallet');
    if (saved) {
      const { jwkPriv, jwkPub, savedName, seq, lastHash } = JSON.parse(saved);
      w.name = savedName || name;
      w.privateKey = await subtle.importKey('jwk', jwkPriv, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      w.publicCryptoKey = await subtle.importKey('jwk', jwkPub, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      w.seq = seq;
      w.lastHash = lastHash;
    } else {
      const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      w.privateKey = pair.privateKey;
      w.publicCryptoKey = pair.publicKey;
      w.seq = 0;
      w.lastHash = '0'.repeat(64);
    }
    w.publicKey = pem(b64(await subtle.exportKey('spki', w.publicCryptoKey)));
    w.citizenId = 'c_' + sha256(w.publicKey).slice(0, 12); // 신원 = 공개키에서 유도
    await w.persist();
    return w;
  }

  async persist() {
    localStorage.setItem(
      'agora-wallet',
      JSON.stringify({
        jwkPriv: await subtle.exportKey('jwk', this.privateKey),
        jwkPub: await subtle.exportKey('jwk', this.publicCryptoKey),
        savedName: this.name,
        seq: this.seq,
        lastHash: this.lastHash,
      })
    );
  }

  // 행위 1건 = 내 로그에 서명된 항목 1개 (Node 지갑과 동일한 구조)
  async act(topicId, type, data) {
    this.seq += 1;
    const entry = { author: this.citizenId, seq: this.seq, prevHash: this.lastHash, topicId, type, data, ts: Date.now() };
    entry.hash = entryHash(entry);
    const sig = await subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.privateKey,
      new TextEncoder().encode(canonical(entry))
    );
    entry.sig = b64(sig); // raw(r||s) 형식 — 브라우저 피어망 공통 규격
    this.lastHash = entry.hash;
    await this.persist();
    return entry;
  }
}

// 항목 검증 (비동기) — 서명이 내용 전체를 덮는다
const keyCache = new Map();
export async function verifyEntry(entry, publicKeyPem) {
  try {
    if (entry.hash !== entryHash(entry)) return false;
    let key = keyCache.get(publicKeyPem);
    if (!key) {
      key = await subtle.importKey('spki', spkiFromPem(publicKeyPem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      keyCache.set(publicKeyPem, key);
    }
    return await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      unb64(entry.sig),
      new TextEncoder().encode(canonical(entry))
    );
  } catch {
    return false;
  }
}

// ── 브라우저 노드: WeaveNode와 동일한 저장·검증 규칙 (검증만 비동기) ──
export class BrowserNode {
  constructor({ id, interests = [] }) {
    this.id = id;
    this.interests = new Set(interests);
    this.registry = new Map(); // citizenId -> publicKey PEM
    this.entries = new Map(); // author -> Map(seq -> entry)
    this.byHash = new Map();
    this.forkProofs = new Map();
    this.maxDataBytes = 8192;
    this._saveTimer = null;
  }

  // 영속화: 데이터베이스는 시민의 기기다. 내가 복제한 역사와 등록부를
  // 이 브라우저에 저장한다 — 모든 피어가 꺼졌다 켜져도 각자가 역사를
  // 지니고 돌아오므로 네트워크의 기억이 유실되지 않는다.
  restore() {
    try {
      const reg = JSON.parse(localStorage.getItem('agora-registry') ?? '[]');
      for (const [cid, pub] of reg) this.registry.set(cid, pub);
      const interests = JSON.parse(localStorage.getItem('agora-interests') ?? '[]');
      for (const t of interests) this.interests.add(t);
      const saved = JSON.parse(localStorage.getItem('agora-entries') ?? '[]');
      for (const e of saved) {
        // 저장 당시 검증된 항목의 복원 — 구조만 재확인하고 그대로 적재
        if (!e?.hash || this.byHash.has(e.hash)) continue;
        let log = this.entries.get(e.author);
        if (!log) this.entries.set(e.author, (log = new Map()));
        log.set(e.seq, e);
        this.byHash.set(e.hash, e);
      }
    } catch {
      // 손상된 저장소는 무시 — 네트워크가 다시 채워 준다
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        localStorage.setItem('agora-entries', JSON.stringify([...this.byHash.values()]));
        localStorage.setItem('agora-registry', JSON.stringify([...this.registry.entries()]));
        localStorage.setItem('agora-interests', JSON.stringify([...this.interests]));
      } catch {
        // 저장소 초과(~5MB) 시 항목 저장을 포기 — 역사는 이웃이 보관한다
      }
    }, 400);
  }

  async ingest(entry) {
    const publicKey = this.registry.get(entry.author);
    if (!publicKey) return { accepted: false, reason: '등록되지 않은 시민' };
    if (!this.interests.has(entry.topicId)) return { accepted: false, reason: '관심 밖 주제' };
    if (JSON.stringify(entry.data ?? null).length > this.maxDataBytes) return { accepted: false, reason: '데이터 과대' };
    if (this.byHash.has(entry.hash)) return { accepted: false, reason: '중복' };
    if (!(await verifyEntry(entry, publicKey))) return { accepted: false, reason: '서명 불일치' };
    let log = this.entries.get(entry.author);
    if (!log) this.entries.set(entry.author, (log = new Map()));
    const existing = log.get(entry.seq);
    if (existing && isFork(existing, entry)) {
      this.forkProofs.set(entry.author, { a: existing, b: entry });
      return { accepted: false, reason: '로그 분기 감지' };
    }
    log.set(entry.seq, entry);
    this.byHash.set(entry.hash, entry);
    this._scheduleSave();
    return { accepted: true };
  }

  entriesForTopic(topicId) {
    const out = [];
    for (const log of this.entries.values()) for (const e of log.values()) if (e.topicId === topicId) out.push(e);
    return out;
  }
}

// ── WebRTC 메시: 브라우저끼리 직접 연결되는 가십 네트워크 ────
export class BrowserMesh {
  constructor({ node, wallet, onChange = () => {}, gossipMs = 800 }) {
    this.node = node;
    this.wallet = wallet;
    this.onChange = onChange;
    this.gossipMs = gossipMs;
    this.channels = new Map(); // peerId -> { dc, hello } — WebRTC 직접 연결(선호)
    this.pcs = new Map(); // peerId -> RTCPeerConnection
    this.roomPeers = new Set(); // 신호 서버가 알려준 같은 방의 피어 id들
    this.relayPeers = new Map(); // peerId -> { hello } — 서버 경유 중계로만 닿는 피어
    this.relayGreeted = new Set(); // 중계 HELLO를 이미 보낸 피어
    this.names = new Map([[wallet.citizenId, wallet.name]]);
    this.myId = null;
  }

  // 피어에게 전달: WebRTC 채널이 열려 있으면 직접(서버가 못 봄), 없으면 서버 중계
  _deliver(peerId, msg) {
    const ch = this.channels.get(peerId);
    if (ch?.dc.readyState === 'open') {
      ch.dc.send(JSON.stringify(msg));
      return true;
    }
    if (this.roomPeers.has(peerId) && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ type: 'relay', to: peerId, payload: msg }));
      return true;
    }
    return false;
  }

  // 이 피어에 대해 내가 아는 HELLO (직접 우선, 없으면 중계)
  _peerHello(peerId) {
    return this.channels.get(peerId)?.hello ?? this.relayPeers.get(peerId)?.hello ?? null;
  }

  // 직접이든 중계든, 나와 대화 가능한 모든 피어 id
  _reachablePeers() {
    const ids = new Set();
    for (const [pid, ch] of this.channels) if (ch.dc.readyState === 'open') ids.add(pid);
    for (const pid of this.roomPeers) ids.add(pid);
    return ids;
  }

  _noteRoomPeer(peerId) {
    if (!peerId || peerId === this.myId) return;
    this.roomPeers.add(peerId);
    // 중계 인사: 이 피어와 아직 인사하지 않았으면 HELLO를 서버 경유로 보낸다.
    // WebRTC가 나중에 뚫리면 그쪽이 우선되고 중계는 자연히 쓰이지 않는다.
    if (!this.relayGreeted.has(peerId)) {
      this.relayGreeted.add(peerId);
      this._deliver(peerId, this._helloMsg());
    }
  }

  connect(signalUrl) {
    this.signalUrl = signalUrl;
    this.wsState = '연결 중';
    this._dialSignal();
    this.timer = setInterval(() => this._gossip(), this.gossipMs);
    // 하트비트: 프록시의 유휴 타임아웃으로 신호 회선이 끊기는 것을 막는다
    this.heartbeat = setInterval(() => {
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'ping' }));
    }, 20_000);
    // 자가 회복 루프: 절전·네트워크 전환으로 WebRTC가 죽어도 스스로 아문다.
    // 주기적으로 방의 피어 목록을 물어, 연결이 없는 피어에게 다시 건다.
    this.repair = setInterval(() => {
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'who' }));
    }, 8000);
  }

  _dialSignal() {
    const ws = new WebSocket(this.signalUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.wsState = '연결됨';
      this.onChange();
    };
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'welcome') {
        this.myId = msg.id;
        for (const peerId of msg.peers) {
          this._noteRoomPeer(peerId); // 중계 경로 즉시 확보
          this._offer(peerId); // WebRTC 직접 연결 시도 (되면 중계보다 우선)
        }
      } else if (msg.type === 'peer-joined') {
        this._noteRoomPeer(msg.id); // 상대가 WebRTC offer를 걸어옴 — 중계 경로만 미리 준비
      } else if (msg.type === 'peer-left') {
        this.roomPeers.delete(msg.id);
        this.relayPeers.delete(msg.id);
        this.relayGreeted.delete(msg.id);
        this.onChange();
      } else if (msg.type === 'signal') {
        await this._onSignal(msg.from, msg.payload);
      } else if (msg.type === 'relay') {
        await this._onMessage(msg.from, msg.payload, true);
      } else if (msg.type === 'peers') {
        const mine = Number(this.myId?.slice(1) ?? 0);
        for (const peerId of msg.peers) {
          this._noteRoomPeer(peerId);
          if (this.pcs.has(peerId) || this.channels.has(peerId)) continue;
          if (mine > Number(peerId.slice(1))) this._offer(peerId); // glare 방지
        }
      }
    };
    // 신호 회선이 끊겨도 이미 성립된 WebRTC 연결은 계속 산다.
    // 새 참여자를 만나기 위해 자동으로 재접속한다.
    ws.onclose = () => {
      if (this.stopped) return;
      this.wsState = '재연결 중';
      this.onChange();
      setTimeout(() => this._dialSignal(), 3000);
    };
    ws.onerror = () => ws.close();
  }

  _pc(peerId) {
    let pc = this.pcs.get(peerId);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pcs.set(peerId, pc);
    pc.onicecandidate = (e) => {
      if (e.candidate) this._signal(peerId, { candidate: e.candidate });
    };
    pc.ondatachannel = (e) => this._setupChannel(peerId, e.channel);
    pc.onconnectionstatechange = () => {
      this.onChange(); // 협상 상태를 UI에 반영 (new/connecting/connected/failed)
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this.pcs.delete(peerId);
        this.channels.delete(peerId);
        this.onChange();
      }
    };
    return pc;
  }

  async _offer(peerId) {
    const pc = this._pc(peerId);
    this._setupChannel(peerId, pc.createDataChannel('weave'));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._signal(peerId, { sdp: pc.localDescription });
    // 협상 타임아웃: 오래 걸리면 정리하고 회복 루프가 새로 시도하게 한다
    setTimeout(() => {
      if (!this.channels.has(peerId) && this.pcs.get(peerId) === pc) {
        pc.close();
        this.pcs.delete(peerId);
        this.onChange();
      }
    }, 15_000);
  }

  async _onSignal(from, payload) {
    const pc = this._pc(from);
    if (payload.sdp) {
      await pc.setRemoteDescription(payload.sdp);
      // 원격 설명 전에 도착해 대기 중이던 후보들을 반영
      for (const c of pc._pending ?? []) {
        try { await pc.addIceCandidate(c); } catch { /* 만료된 후보 */ }
      }
      pc._pending = [];
      if (payload.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._signal(from, { sdp: pc.localDescription });
      }
    } else if (payload.candidate) {
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(payload.candidate); } catch { /* 만료된 후보 */ }
      } else {
        (pc._pending ??= []).push(payload.candidate); // 버리지 않고 버퍼링
      }
    }
  }

  _signal(to, payload) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'signal', to, payload }));
  }

  _setupChannel(peerId, dc) {
    dc.onopen = () => {
      this.channels.set(peerId, { dc, hello: null });
      this._sendTo(peerId, this._helloMsg());
      this.onChange();
    };
    dc.onclose = () => {
      this.channels.delete(peerId);
      this.onChange();
    };
    dc.onmessage = (e) => this._onMessage(peerId, JSON.parse(e.data));
  }

  _helloMsg() {
    return {
      type: 'HELLO',
      id: this.wallet.name,
      interests: [...this.node.interests],
      identity: { citizenId: this.wallet.citizenId, publicKey: this.wallet.publicKey, name: this.wallet.name },
    };
  }

  _sendTo(peerId, msg) {
    const ch = this.channels.get(peerId);
    if (ch?.dc.readyState === 'open') ch.dc.send(JSON.stringify(msg));
  }

  // 직접(WebRTC)·중계(서버) 어느 경로로 와도 동일하게 처리한다.
  async _onMessage(peerId, msg, viaRelay = false) {
    switch (msg.type) {
      case 'HELLO': {
        if (viaRelay) {
          if (!this.relayPeers.has(peerId)) this.relayPeers.set(peerId, { hello: null });
          this.relayPeers.get(peerId).hello = msg;
          // 아직 이 피어에게 인사 안 했으면 답인사 (idempotent — 무한 반복 없음)
          if (!this.relayGreeted.has(peerId)) {
            this.relayGreeted.add(peerId);
            this._deliver(peerId, this._helloMsg());
          }
        } else {
          const ch = this.channels.get(peerId);
          if (!ch) return;
          ch.hello = msg;
        }
        if (msg.identity) this._register(msg.identity);
        this._deliver(peerId, { type: 'REGISTRY', identities: this._identities() });
        this.onChange();
        break;
      }
      case 'REGISTRY':
        for (const identity of msg.identities ?? []) this._register(identity);
        break;
      case 'HAVE': {
        if (!this.node.interests.has(msg.topicId)) break;
        const theirs = new Set();
        for (const [author, tokens] of Object.entries(msg.have ?? {})) {
          for (const t of tokens) theirs.add(`${author}:${t}`);
        }
        const missing = this.node
          .entriesForTopic(msg.topicId)
          .filter((e) => !theirs.has(`${e.author}:${e.seq}:${e.hash.slice(0, 16)}`));
        if (missing.length) this._deliver(peerId, { type: 'ENTRIES', entries: missing });
        break;
      }
      case 'ENTRIES': {
        let changed = false;
        for (const entry of msg.entries ?? []) {
          const r = await this.node.ingest(entry);
          if (r.accepted || r.forkProof) changed = true;
        }
        if (changed) this.onChange();
        break;
      }
      case 'FORKS':
        for (const proof of msg.proofs ?? []) {
          if (proof?.a && !this.node.forkProofs.has(proof.a.author)) {
            await this.node.ingest(proof.a);
            await this.node.ingest(proof.b);
          }
        }
        break;
    }
  }

  _register(identity) {
    // 데모: 개방 등록 — 실제 시스템에서는 자격증명(DID/영지식) 검증 지점
    if (identity?.citizenId && identity?.publicKey && !this.node.registry.has(identity.citizenId)) {
      this.node.registry.set(identity.citizenId, identity.publicKey);
      this.node._scheduleSave();
    }
    if (identity?.name) this.names.set(identity.citizenId, identity.name);
  }

  _identities() {
    return [...this.node.registry.entries()].map(([citizenId, publicKey]) => ({
      citizenId,
      publicKey,
      name: this.names.get(citizenId) ?? null,
    }));
  }

  _gossip() {
    // 직접·중계 가릴 것 없이 닿는 모든 피어와 반보정 가십을 한다
    for (const peerId of this._reachablePeers()) {
      const hello = this._peerHello(peerId);
      if (!hello) {
        // 아직 인사 전이면 인사부터 (중계 경로 확보)
        if (!this.relayGreeted.has(peerId)) {
          this.relayGreeted.add(peerId);
          this._deliver(peerId, this._helloMsg());
        }
        continue;
      }
      this._deliver(peerId, { type: 'REGISTRY', identities: this._identities() });
      const shared = [...this.node.interests].filter((t) => hello.interests.includes(t));
      for (const topicId of shared) {
        const have = {};
        for (const e of this.node.entriesForTopic(topicId)) {
          (have[e.author] ??= []).push(`${e.seq}:${e.hash.slice(0, 16)}`);
        }
        this._deliver(peerId, { type: 'HAVE', topicId, have });
      }
      if (this.node.forkProofs.size) {
        this._deliver(peerId, { type: 'FORKS', proofs: [...this.node.forkProofs.values()] });
      }
    }
  }

  // 구독 확대: 갱신된 관심사를 재공지 → 반보정 가십이 과거를 백필
  follow(topicId) {
    if (this.node.interests.has(topicId)) return;
    this.node.interests.add(topicId);
    this.node._scheduleSave();
    for (const peerId of this._reachablePeers()) this._deliver(peerId, this._helloMsg());
  }

  // 내 행위: 로컬 서명·저장 후 관심 있는 이웃에게 즉시 전파 (직접·중계 모두)
  async act(topicId, type, data) {
    const entry = await this.wallet.act(topicId, type, data);
    const r = await this.node.ingest(entry);
    if (!r.accepted) throw new Error(`거부됨: ${r.reason}`);
    for (const peerId of this._reachablePeers()) {
      if (this._peerHello(peerId)?.interests.includes(topicId)) {
        this._deliver(peerId, { type: 'ENTRIES', entries: [entry] });
      }
    }
    this.onChange();
    return entry;
  }
}
