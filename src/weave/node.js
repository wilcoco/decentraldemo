// 위브 노드: 관심 있는 주제만 복제·저장하고, 같은 주제에 관심 있는
// 다른 노드들과 가십(gossip)으로 동기화하며, 상호참조 체크포인트로
// 서로의 기록을 엮어(entangle) 누락·조작을 탐지한다.
//
// 보안 모델 (블록체인의 "경쟁적 합의"를 대체하는 세 기둥):
//  1. 서명  → 위조를 막는다. 남의 명의로 항목을 만들 수 없다.
//  2. 상호참조 → 누락(검열)을 막는다. 여러 노드가 서로의 주제 상태 요약을
//     자기 로그에 박아 넣으므로, 어떤 노드가 불리한 항목을 몰래 빼면
//     체크포인트와의 대조에서 드러난다. 관심이 많은 주제일수록 복제본과
//     상호참조가 많아진다 — 즉 "관심이 곧 보안"이다.
//  3. 분기 증명 → 이중 발언을 막는다. 진영마다 다른 말을 하면(같은 순번에
//     다른 서명) 두 항목이 만나는 순간 증명되고 집계에서 제외된다.
import { sha256 } from '../blockchain.js';
import { verifyEntry, isFork } from './entry.js';
import { THRESHOLDS } from '../democracy.js';

export class WeaveNode {
  constructor({ id, interests, registry }) {
    this.id = id;
    this.interests = new Set(interests); // 이 노드가 복제하기로 선택한 주제들
    this.registry = registry; // 신원 등록부: citizenId -> publicKey (신원 계층 가정)
    this.entries = new Map(); // author -> Map(seq -> entry) — 관심 주제 항목만 (부분 복제)
    this.byHash = new Set();
    this.forkProofs = new Map(); // author -> { a, b } 분기 증명 (전파 가능한 배신의 증거)
  }

  // ── 수신: 검증 후 저장 ─────────────────────────────────────
  ingest(entry) {
    const publicKey = this.registry.get(entry.author);
    if (!publicKey) return { accepted: false, reason: '등록되지 않은 시민' };
    if (!this.interests.has(entry.topicId)) return { accepted: false, reason: '관심 밖 주제' };
    if (!verifyEntry(entry, publicKey)) return { accepted: false, reason: '서명/해시 불일치' };
    if (this.byHash.has(entry.hash)) return { accepted: false, reason: '중복' };

    let authorLog = this.entries.get(entry.author);
    if (!authorLog) {
      authorLog = new Map();
      this.entries.set(entry.author, authorLog);
    }
    const existing = authorLog.get(entry.seq);
    if (existing && isFork(existing, entry)) {
      // 같은 순번에 서로 다른 서명 = 로그 분기. 두 항목이 곧 증거다.
      this.forkProofs.set(entry.author, { a: existing, b: entry });
      return { accepted: false, reason: '로그 분기 감지', forkProof: this.forkProofs.get(entry.author) };
    }
    authorLog.set(entry.seq, entry);
    this.byHash.add(entry.hash);
    return { accepted: true };
  }

  entriesForTopic(topicId) {
    const out = [];
    for (const log of this.entries.values()) {
      for (const e of log.values()) if (e.topicId === topicId) out.push(e);
    }
    return out;
  }

  storedCount() {
    let n = 0;
    for (const log of this.entries.values()) n += log.size;
    return n;
  }

  // ── 가십 동기화: 겹치는 관심 주제의 항목과 분기 증명을 교환 ──
  static sync(a, b) {
    for (const [from, to] of [[a, b], [b, a]]) {
      for (const topicId of to.interests) {
        if (!from.interests.has(topicId)) continue;
        for (const e of from.entriesForTopic(topicId)) to.ingest(e);
      }
      for (const [author, proof] of from.forkProofs) {
        if (!to.forkProofs.has(author)) to.forkProofs.set(author, proof);
      }
    }
  }

  // ── 상태 요약과 상호참조 체크포인트 ───────────────────────
  // heads: 이 노드가 아는 각 작성자의 최대 순번. digest: 그 범위 항목 해시들의 요약.
  headsFor(topicId) {
    const heads = {};
    for (const e of this.entriesForTopic(topicId)) {
      if (e.type === 'CHECKPOINT') continue;
      heads[e.author] = Math.max(heads[e.author] ?? 0, e.seq);
    }
    return heads;
  }

  digestUpTo(topicId, heads) {
    const hashes = this.entriesForTopic(topicId)
      .filter((e) => e.type !== 'CHECKPOINT' && e.seq <= (heads[e.author] ?? 0))
      .map((e) => e.hash)
      .sort();
    return sha256(hashes.join('|'));
  }

  // 노드 운영자(시민)가 현재 주제 상태 요약을 자기 로그에 서명해 박는다.
  // 이 체크포인트는 다른 노드로 전파되어 서로의 기록을 엮는 실이 된다.
  makeCheckpoint(operatorWallet, topicId) {
    const heads = this.headsFor(topicId);
    const entry = operatorWallet.act(topicId, 'CHECKPOINT', {
      digest: this.digestUpTo(topicId, heads),
      heads,
    });
    this.ingest(entry);
    return entry;
  }

  // 내 저장소를 남들이 서명한 체크포인트와 대조한다.
  // - 서명 검증은 "고쳐 쓴 항목"을 잡고, 체크포인트 대조는 "몰래 뺀 항목"(검열)을 잡는다.
  auditAgainstCheckpoints(topicId) {
    const results = [];
    for (const e of this.entriesForTopic(topicId)) {
      if (e.type !== 'CHECKPOINT') continue;
      const { digest, heads } = e.data;
      // 체크포인트 범위를 내가 다 갖고 있는지 (부족하면 판정 불가 = 그 자체가 동기화 신호)
      const myHeads = this.headsFor(topicId);
      const covered = Object.entries(heads).every(([author, seq]) => (myHeads[author] ?? 0) >= seq);
      if (!covered) {
        results.push({ operator: e.author, seq: e.seq, status: '범위 미보유' });
        continue;
      }
      const mine = this.digestUpTo(topicId, heads);
      results.push({ operator: e.author, seq: e.seq, status: mine === digest ? '일치' : '불일치(누락/조작 의심)' });
    }
    return results;
  }

  // 저장소 자체 점검: 항목을 로컬에서 고치면 서명이 깨진다.
  verifyStorage() {
    const bad = [];
    for (const [author, log] of this.entries) {
      const publicKey = this.registry.get(author);
      for (const e of log.values()) {
        if (!verifyEntry(e, publicKey)) bad.push({ author, seq: e.seq });
      }
    }
    return { valid: bad.length === 0, bad };
  }

  // ── 집계: 항목들을 결정적으로 접어(fold) 주제 상태를 만든다 ──
  // 같은 항목 집합 → 같은 결과. 도착 순서와 무관하다(CRDT 병합).
  // 분기 증명이 있는 시민의 행위는 집계에서 제외된다.
  tally(topicId) {
    const flagged = new Set(this.forkProofs.keys());
    const all = this.entriesForTopic(topicId)
      .filter((e) => e.type !== 'CHECKPOINT' && !flagged.has(e.author))
      .sort((x, y) => (x.author < y.author ? -1 : x.author > y.author ? 1 : x.seq - y.seq));

    // 1차: 의견 등록 (의견 ID = 제안 항목의 해시 → 모든 노드에서 동일)
    const opinions = new Map();
    for (const e of all) {
      if (e.type === 'PROPOSE') {
        opinions.set(e.hash, {
          id: e.hash,
          authorId: e.author,
          title: e.data.title,
          body: e.data.body ?? '',
          evidences: [],
          challenges: [],
        });
      }
    }

    // 2차: 최신 우선(작성자별 순번) 병합 — 지지/위임은 마지막 행위만 유효
    const supportState = new Map(); // author -> Map(opinionId -> { on, seq })
    const delegationState = new Map(); // author -> { to, seq }
    const setSupport = (author, opinionId, on, seq) => {
      let m = supportState.get(author);
      if (!m) supportState.set(author, (m = new Map()));
      const cur = m.get(opinionId);
      if (!cur || seq > cur.seq) m.set(opinionId, { on, seq });
    };
    for (const e of all) {
      if (e.type === 'PROPOSE') setSupport(e.author, e.hash, true, e.seq);
      else if (e.type === 'SUPPORT') setSupport(e.author, e.data.opinionId, true, e.seq);
      else if (e.type === 'WITHDRAW') setSupport(e.author, e.data.opinionId, false, e.seq);
      else if (e.type === 'DELEGATE') {
        const cur = delegationState.get(e.author);
        if (!cur || e.seq > cur.seq) delegationState.set(e.author, { to: e.data.to, seq: e.seq });
      } else if (e.type === 'REVOKE') {
        const cur = delegationState.get(e.author);
        if (!cur || e.seq > cur.seq) delegationState.set(e.author, { to: null, seq: e.seq });
      } else if (e.type === 'EVIDENCE' && opinions.has(e.data.opinionId)) {
        opinions.get(e.data.opinionId).evidences.push({ authorId: e.author, text: e.data.text });
      } else if (e.type === 'CHALLENGE' && opinions.has(e.data.opinionId)) {
        opinions.get(e.data.opinionId).challenges.push({ authorId: e.author, text: e.data.text });
      }
    }

    // 유효 지지 가중치: 직접 참여자는 자기 목소리(1), 미참여자의 표는
    // 위임 사슬을 따라 직접 참여자에게 흐른다 (순환 안전, 직접 참여 우선).
    const directActors = new Set();
    for (const [author, m] of supportState) {
      for (const { on } of m.values()) if (on) directActors.add(author);
    }
    const weights = new Map();
    for (const actor of directActors) weights.set(actor, 1);
    for (const citizenId of this.registry.keys()) {
      if (directActors.has(citizenId) || flagged.has(citizenId)) continue;
      let current = citizenId;
      const visited = new Set([current]);
      let terminal = null;
      while (true) {
        const next = delegationState.get(current)?.to;
        if (!next || visited.has(next)) break;
        visited.add(next);
        current = next;
        if (directActors.has(current)) {
          terminal = current;
          break;
        }
      }
      if (terminal) weights.set(terminal, weights.get(terminal) + 1);
    }

    const totalCitizens = Math.max(this.registry.size, 1);
    const result = [...opinions.values()].map((o) => {
      let weight = 0;
      for (const [author, m] of supportState) {
        const s = m.get(o.id);
        if (s?.on) weight += weights.get(author) ?? 0;
      }
      const ratio = weight / totalCitizens;
      const ev = o.evidences.length;
      const ch = o.challenges.length;
      const verified = ev >= 1 && ev >= ch;
      let status;
      if (ch > ev) status = '반박됨';
      else if (ratio >= THRESHOLDS.adopt && verified) status = '채택';
      else if (ratio >= THRESHOLDS.leading) status = '우세';
      else if (ev + ch > 0) status = '검증중';
      else status = '제안됨';
      return { ...o, weight, ratio, status };
    });
    result.sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1));
    return { opinions: result, flagged: [...flagged] };
  }
}
