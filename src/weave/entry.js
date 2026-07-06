// 위브(Weave) — 관심 기반 상호참조 로그 네트워크: 항목(entry)과 지갑(wallet)
//
// 블록체인과의 근본적 차이:
//  - 전역 체인이 없다. 시민마다 자기만의 서명 로그(개인 해시 체인)를 가진다.
//  - 채굴/경쟁이 없다. 행위 1건의 비용 = 서명 1개.
//  - 전역 합의가 없다. 의견 표명은 이중지불 문제가 없으므로 전역 순서가 불필요하다.
//    각 시민의 "최신 상태"만 알면 되고, 이는 (작성자, 순번) 기준 최신 우선 병합으로
//    어떤 순서로 항목이 도착해도 같은 결과에 수렴한다(CRDT).
//  - 유일한 부정행위는 자기 로그를 분기시키는 것(equivocation: 같은 순번에 서로 다른
//    내용을 서명해 진영마다 다른 말을 하는 것)이며, 이는 두 항목만 맞대면
//    암호학적으로 증명되는 배신이다. 합의 대신 "탐지와 책임"으로 대체한다.
import { createSign, createVerify } from 'node:crypto';
import { generateKeyPair } from '../blockchain.js';
import { sha256 } from './hash.js';

// 서명 대상 직렬화 (키 순서 고정)
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

export function entryHash(e) {
  return sha256(canonical(e));
}

// 항목을 직접 조립한다 (지갑 내부용 + 공격 시뮬레이션용)
export function craftEntry({ author, privateKey, seq, prevHash, topicId, type, data, ts }) {
  const entry = { author, seq, prevHash, topicId, type, data, ts };
  entry.hash = entryHash(entry);
  const signer = createSign('SHA256');
  signer.update(canonical(entry));
  entry.sig = signer.sign(privateKey, 'base64');
  return entry;
}

// 항목 검증: 내용 해시 일치 + 신원 등록부의 공개키로 서명 확인.
// 서명이 내용 전체를 덮으므로 저장된 항목을 한 글자라도 고치면 즉시 탄로 난다.
export function verifyEntry(entry, publicKey) {
  try {
    if (entry.hash !== entryHash(entry)) return false;
    const verifier = createVerify('SHA256');
    verifier.update(canonical(entry));
    return verifier.verify(publicKey, entry.sig, 'base64');
  } catch {
    return false;
  }
}

// 로그 분기 증명: 같은 작성자가 같은 순번에 서로 다른 내용을 서명했다면
// 두 항목 자체가 이전 불가능한 부정행위의 증거가 된다.
export function isFork(a, b) {
  return a.author === b.author && a.seq === b.seq && a.hash !== b.hash;
}

// 지갑: 시민 단말을 표현한다. 개인키는 여기(시민의 기기)에만 존재하며
// 네트워크로는 서명된 항목만 나간다 — 서버가 명의를 위조할 수 없는 이유.
export class Wallet {
  constructor(name) {
    const keys = generateKeyPair();
    this.name = name;
    this.publicKey = keys.publicKey;
    this.privateKey = keys.privateKey;
    // 신원은 공개키에서 유도된다 (자기주권 신원). 실제 시스템에서는 여기에
    // "실존 유권자" 자격증명(DID + 영지식 증명)이 결합된다.
    this.citizenId = 'c_' + sha256(keys.publicKey).slice(0, 12);
    this.seq = 0;
    this.lastHash = '0'.repeat(64);
  }

  // 행위 1건 = 자기 로그에 항목 1개 추가 (채굴 없음, 서명 1개)
  act(topicId, type, data) {
    this.seq += 1;
    const entry = craftEntry({
      author: this.citizenId,
      privateKey: this.privateKey,
      seq: this.seq,
      prevHash: this.lastHash,
      topicId,
      type,
      data,
      ts: Date.now(),
    });
    this.lastHash = entry.hash;
    return entry;
  }
}
