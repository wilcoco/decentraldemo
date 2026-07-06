// 실시간 민주주의 핵심 로직
//
// 설계 원칙
//  1. 레그(lag) 제거: 임기제 선출이 없다. 모든 지지와 위임은 언제든 즉시 철회 가능하며,
//     의견의 지위(제안됨/검증중/우세/채택/반박됨)는 매 순간 현재 지지·검증 상태로만 계산된다.
//  2. 과제 분할: 국정 과제를 분야(도메인)별 의제로 분할하고, 시민은 분야마다
//     다른 사람에게 위임하거나 직접 참여할 수 있다 (액체 민주주의).
//  3. 검증 계층: 의견은 단순 찬반이 아니라 근거(evidence)와 반론(challenge)을 통해
//     다양한 주체에 의해 검증된다. 반론이 우세하면 지지가 많아도 채택되지 않는다.
//  4. 신뢰 네트워크: 모든 행위는 서명되어 블록체인에 기록된다.
import { generateKeyPair, signTransaction, TrustChain } from './blockchain.js';

let seq = 0;
const nextId = (prefix) => `${prefix}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// 의견 지위 판정 기준은 공용 상수로 이동 (src/weave/consts.js)
import { THRESHOLDS } from './weave/consts.js';
export { THRESHOLDS };

export class Democracy {
  constructor({ chain } = {}) {
    this.chain = chain ?? new TrustChain();
    this.citizens = new Map(); // id -> { id, name, publicKey, privateKey, joinedAt }
    this.issues = new Map(); // id -> { id, title, domain, description, createdAt }
    this.opinions = new Map(); // id -> { id, issueId, authorId, title, body, supporters:Set, evidences:[], challenges:[], createdAt }
    this.delegations = new Map(); // citizenId -> Map(domain -> delegateCitizenId)
    this.domains = new Set();
  }

  // ── 기록 유틸 ──────────────────────────────────────────────
  _record(type, citizen, data) {
    const tx = {
      type,
      actor: citizen ? citizen.id : 'system',
      actorPublicKey: citizen ? citizen.publicKey : null,
      data,
      timestamp: Date.now(),
    };
    if (citizen) {
      tx.signature = signTransaction(tx, citizen.privateKey);
      this.chain.record(tx);
    }
    return tx;
  }

  // ── 시민 ──────────────────────────────────────────────────
  registerCitizen(name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error('이름이 필요합니다');
    const keys = generateKeyPair();
    const citizen = {
      id: nextId('c'),
      name: trimmed,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      joinedAt: Date.now(),
    };
    this.citizens.set(citizen.id, citizen);
    this.delegations.set(citizen.id, new Map());
    this._record('REGISTER', citizen, { name: trimmed });
    return citizen;
  }

  _citizen(id) {
    const c = this.citizens.get(id);
    if (!c) throw new Error('등록되지 않은 시민입니다');
    return c;
  }

  // ── 의제(국정 과제 분할 단위) ─────────────────────────────
  createIssue({ title, domain, description = '' }) {
    if (!title || !domain) throw new Error('의제 제목과 분야가 필요합니다');
    const issue = { id: nextId('i'), title, domain, description, createdAt: Date.now() };
    this.issues.set(issue.id, issue);
    this.domains.add(domain);
    return issue;
  }

  // ── 의견 제안 ─────────────────────────────────────────────
  propose(citizenId, issueId, title, body = '') {
    const citizen = this._citizen(citizenId);
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error('존재하지 않는 의제입니다');
    if (!String(title ?? '').trim()) throw new Error('의견 제목이 필요합니다');
    const opinion = {
      id: nextId('o'),
      issueId,
      authorId: citizenId,
      title: String(title).trim(),
      body: String(body ?? '').trim(),
      supporters: new Set([citizenId]), // 제안자는 기본 지지
      evidences: [],
      challenges: [],
      createdAt: Date.now(),
    };
    this.opinions.set(opinion.id, opinion);
    this._record('PROPOSE', citizen, { opinionId: opinion.id, issueId, title: opinion.title });
    return opinion;
  }

  _opinion(id) {
    const o = this.opinions.get(id);
    if (!o) throw new Error('존재하지 않는 의견입니다');
    return o;
  }

  // ── 실시간 지지 / 즉시 철회 ───────────────────────────────
  setSupport(citizenId, opinionId, on) {
    const citizen = this._citizen(citizenId);
    const opinion = this._opinion(opinionId);
    const had = opinion.supporters.has(citizenId);
    if (on && !had) {
      opinion.supporters.add(citizenId);
      this._record('SUPPORT', citizen, { opinionId });
    } else if (!on && had) {
      opinion.supporters.delete(citizenId);
      this._record('WITHDRAW_SUPPORT', citizen, { opinionId });
    }
    return opinion;
  }

  // ── 분야별 위임 / 즉시 회수 (액체 민주주의) ────────────────
  delegate(citizenId, domain, delegateId) {
    const citizen = this._citizen(citizenId);
    const map = this.delegations.get(citizenId);
    if (delegateId == null || delegateId === '') {
      map.delete(domain);
      this._record('REVOKE_DELEGATION', citizen, { domain });
      return null;
    }
    if (delegateId === citizenId) throw new Error('자기 자신에게 위임할 수 없습니다');
    this._citizen(delegateId);
    map.set(domain, delegateId);
    this._record('DELEGATE', citizen, { domain, to: delegateId });
    return delegateId;
  }

  // ── 검증 계층: 근거와 반론 ────────────────────────────────
  addEvidence(citizenId, opinionId, text, url = '') {
    const citizen = this._citizen(citizenId);
    const opinion = this._opinion(opinionId);
    if (!String(text ?? '').trim()) throw new Error('근거 내용이 필요합니다');
    const evidence = { id: nextId('e'), authorId: citizenId, text: String(text).trim(), url, createdAt: Date.now() };
    opinion.evidences.push(evidence);
    this._record('EVIDENCE', citizen, { opinionId, evidenceId: evidence.id, text: evidence.text });
    return evidence;
  }

  addChallenge(citizenId, opinionId, text) {
    const citizen = this._citizen(citizenId);
    const opinion = this._opinion(opinionId);
    if (!String(text ?? '').trim()) throw new Error('반론 내용이 필요합니다');
    const challenge = { id: nextId('x'), authorId: citizenId, text: String(text).trim(), createdAt: Date.now() };
    opinion.challenges.push(challenge);
    this._record('CHALLENGE', citizen, { opinionId, challengeId: challenge.id, text: challenge.text });
    return challenge;
  }

  // ── 유효 지지 가중치 계산 ─────────────────────────────────
  // 의제 단위로: 해당 의제의 어떤 의견에든 직접 지지한 시민은 자기 목소리를 쓴다.
  // 직접 행동하지 않은 시민의 표는 그 분야 위임 사슬을 따라 (순환 방지하며) 흐르고,
  // 사슬 끝이 직접 지지자인 경우에만 그 지지자의 가중치에 더해진다.
  // 즉, 직접 참여가 위임을 항상 우선한다.
  effectiveWeights(issueId) {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error('존재하지 않는 의제입니다');
    const opinionsOfIssue = [...this.opinions.values()].filter((o) => o.issueId === issueId);
    const directActors = new Set();
    for (const o of opinionsOfIssue) {
      for (const s of o.supporters) directActors.add(s);
    }
    // 각 직접 지지자의 가중치 = 1(본인) + 위임으로 흘러들어온 표
    const weights = new Map();
    for (const actor of directActors) weights.set(actor, 1);
    for (const citizenId of this.citizens.keys()) {
      if (directActors.has(citizenId)) continue;
      // 위임 사슬 추적 (순환 감지)
      let current = citizenId;
      const visited = new Set([current]);
      let terminal = null;
      while (true) {
        const next = this.delegations.get(current)?.get(issue.domain);
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
    return weights;
  }

  // 의견의 현재 지위: 저장하지 않고 매번 현재 상태로부터 계산한다 (레그 없음)
  opinionStatus(opinion, weights) {
    const totalCitizens = Math.max(this.citizens.size, 1);
    let weight = 0;
    for (const s of opinion.supporters) weight += weights.get(s) ?? 0;
    const ratio = weight / totalCitizens;
    const ev = opinion.evidences.length;
    const ch = opinion.challenges.length;
    const verified = ev >= 1 && ev >= ch;
    let status;
    if (ch > ev) status = '반박됨';
    else if (ratio >= THRESHOLDS.adopt && verified) status = '채택';
    else if (ratio >= THRESHOLDS.leading) status = '우세';
    else if (ev + ch > 0) status = '검증중';
    else status = '제안됨';
    return { weight, ratio, verified, status };
  }

  // ── 전체 상태 스냅숏 (프런트엔드용) ───────────────────────
  getState() {
    const chainCheck = this.chain.verify();
    const issues = [...this.issues.values()].map((issue) => {
      const weights = this.effectiveWeights(issue.id);
      const opinions = [...this.opinions.values()]
        .filter((o) => o.issueId === issue.id)
        .map((o) => {
          const { weight, ratio, verified, status } = this.opinionStatus(o, weights);
          return {
            id: o.id,
            issueId: o.issueId,
            authorId: o.authorId,
            authorName: this.citizens.get(o.authorId)?.name ?? '?',
            title: o.title,
            body: o.body,
            supporters: [...o.supporters],
            evidences: o.evidences.map((e) => ({ ...e, authorName: this.citizens.get(e.authorId)?.name ?? '?' })),
            challenges: o.challenges.map((c) => ({ ...c, authorName: this.citizens.get(c.authorId)?.name ?? '?' })),
            weight,
            ratio,
            verified,
            status,
            createdAt: o.createdAt,
          };
        })
        .sort((a, b) => b.weight - a.weight || b.createdAt - a.createdAt);
      return { ...issue, opinions };
    });
    return {
      citizens: [...this.citizens.values()].map((c) => ({ id: c.id, name: c.name, joinedAt: c.joinedAt })),
      domains: [...this.domains],
      issues,
      delegations: Object.fromEntries(
        [...this.delegations.entries()].map(([cid, m]) => [cid, Object.fromEntries(m)])
      ),
      chain: {
        length: this.chain.blocks.length,
        valid: chainCheck.valid,
        reason: chainCheck.reason ?? null,
      },
      thresholds: THRESHOLDS,
    };
  }
}
