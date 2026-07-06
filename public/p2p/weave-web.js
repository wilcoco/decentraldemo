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
    this.channels = new Map(); // peerId -> { dc, hello }
    this.pcs = new Map(); // peerId -> RTCPeerConnection
    this.names = new Map([[wallet.citizenId, wallet.name]]);
    this.myId = null;
  }

  connect(signalUrl) {
    this.ws = new WebSocket(signalUrl);
    this.ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'welcome') {
        this.myId = msg.id;
        // 신규 입장자가 기존 피어들에게 연결을 건다 (충돌 없는 단방향 규칙)
        for (const peerId of msg.peers) this._offer(peerId);
      } else if (msg.type === 'signal') {
        await this._onSignal(msg.from, msg.payload);
      }
      // peer-joined는 상대가 나에게 offer를 걸어오므로 대기만 한다
    };
    this.timer = setInterval(() => this._gossip(), this.gossipMs);
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
  }

  async _onSignal(from, payload) {
    const pc = this._pc(from);
    if (payload.sdp) {
      await pc.setRemoteDescription(payload.sdp);
      if (payload.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._signal(from, { sdp: pc.localDescription });
      }
    } else if (payload.candidate) {
      try {
        await pc.addIceCandidate(payload.candidate);
      } catch {
        // 원격 설명 전 도착한 후보 — 무시해도 재협상으로 회복
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

  async _onMessage(peerId, msg) {
    const ch = this.channels.get(peerId);
    if (!ch) return;
    switch (msg.type) {
      case 'HELLO':
        ch.hello = msg;
        if (msg.identity) this._register(msg.identity);
        this._sendTo(peerId, { type: 'REGISTRY', identities: this._identities() });
        this.onChange();
        break;
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
        if (missing.length) this._sendTo(peerId, { type: 'ENTRIES', entries: missing });
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
    for (const [peerId, ch] of this.channels) {
      if (!ch.hello) continue;
      this._sendTo(peerId, { type: 'REGISTRY', identities: this._identities() });
      const shared = [...this.node.interests].filter((t) => ch.hello.interests.includes(t));
      for (const topicId of shared) {
        const have = {};
        for (const e of this.node.entriesForTopic(topicId)) {
          (have[e.author] ??= []).push(`${e.seq}:${e.hash.slice(0, 16)}`);
        }
        this._sendTo(peerId, { type: 'HAVE', topicId, have });
      }
      if (this.node.forkProofs.size) {
        this._sendTo(peerId, { type: 'FORKS', proofs: [...this.node.forkProofs.values()] });
      }
    }
  }

  // 구독 확대: 갱신된 관심사를 재공지 → 반보정 가십이 과거를 백필
  follow(topicId) {
    if (this.node.interests.has(topicId)) return;
    this.node.interests.add(topicId);
    this.node._scheduleSave();
    for (const peerId of this.channels.keys()) this._sendTo(peerId, this._helloMsg());
  }

  // 내 행위: 로컬 서명·저장 후 관심 있는 이웃에게 즉시 전파
  async act(topicId, type, data) {
    const entry = await this.wallet.act(topicId, type, data);
    const r = await this.node.ingest(entry);
    if (!r.accepted) throw new Error(`거부됨: ${r.reason}`);
    for (const [peerId, ch] of this.channels) {
      if (ch.hello?.interests.includes(topicId)) this._sendTo(peerId, { type: 'ENTRIES', entries: [entry] });
    }
    this.onChange();
    return entry;
  }
}
