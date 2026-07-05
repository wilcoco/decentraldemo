// 신원 계층 — 시빌 공격(1인 다계정) 방어의 시작점
//
// 개방 등록(공개키 = 시민)에서는 계정을 무한 생성해 여론을 위조할 수 있다.
// 1인 1목소리를 위해서는 "이 공개키는 실존 유권자의 것"이라는 자격증명이
// 필요하다. 이 모듈은 그 최소 형태를 구현한다:
//
//   발급자(Issuer)가 시민의 공개키에 서명한 자격증명(credential)을 발급하고,
//   피어는 신뢰하는 발급자 목록에 있는 서명이 붙은 신원만 등록부에 올린다.
//
// 실제 시스템에서의 발전 방향 (이 프로토타입의 한계):
//  - 발급자 단일화는 새로운 중앙이다 → 복수 발급 기관의 임계 서명(threshold
//    signature)으로 분산해야 한다.
//  - 발급자가 "누가 언제 참여하는지"를 알 수 있다 → 영지식 증명(예: Semaphore
//    방식)으로 "나는 유효한 유권자 집합의 익명 구성원이다"만 증명하도록
//    바꿔야 한다. 발급자는 집합 가입만 관리하고 개별 행위는 볼 수 없게 된다.
//  - 키 분실·도난 대응(키 순환, 소셜 복구)이 필요하다.
import { createSign, createVerify } from 'node:crypto';
import { generateKeyPair } from '../blockchain.js';

const payload = (credential) =>
  JSON.stringify({ subject: credential.subject, issuedAt: credential.issuedAt });

export class CredentialIssuer {
  constructor(name = '발급기관') {
    const keys = generateKeyPair();
    this.name = name;
    this.publicKey = keys.publicKey;
    this.privateKey = keys.privateKey;
  }

  // 시민의 공개키에 대한 자격증명 발급.
  // 실제로는 여기서 주민 신원 확인(대면/공인 인증)이 선행된다.
  issue(citizenPublicKey) {
    const credential = {
      subject: citizenPublicKey,
      issuedAt: Date.now(),
      issuer: this.publicKey,
      issuerName: this.name,
    };
    const signer = createSign('SHA256');
    signer.update(payload(credential));
    credential.signature = signer.sign(this.privateKey, 'base64');
    return credential;
  }
}

// 자격증명 검증: 신뢰하는 발급자의 서명인지, 대상 공개키가 일치하는지
export function verifyCredential(credential, subjectPublicKey, trustedIssuers) {
  try {
    if (!credential || credential.subject !== subjectPublicKey) return false;
    if (!trustedIssuers.includes(credential.issuer)) return false;
    const verifier = createVerify('SHA256');
    verifier.update(payload(credential));
    return verifier.verify(credential.issuer, credential.signature, 'base64');
  } catch {
    return false;
  }
}
