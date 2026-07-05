// 신뢰 네트워크(TrustChain)
// 모든 민주적 행위(제안, 지지, 위임, 검증)를 ECDSA 서명 트랜잭션으로 만들어
// 해시 체인 블록에 기록한다. 누구나 체인 전체를 재검증할 수 있다.
import { createHash, createSign, createVerify, generateKeyPairSync } from 'node:crypto';

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// 트랜잭션의 서명 대상 직렬화 (서명 필드 제외, 키 순서 고정)
export function txPayload(tx) {
  return JSON.stringify({
    type: tx.type,
    actor: tx.actor,
    data: tx.data,
    timestamp: tx.timestamp,
  });
}

export function signTransaction(tx, privateKey) {
  const signer = createSign('SHA256');
  signer.update(txPayload(tx));
  return signer.sign(privateKey, 'base64');
}

export function verifyTransaction(tx) {
  if (tx.type === 'GENESIS') return true;
  try {
    const verifier = createVerify('SHA256');
    verifier.update(txPayload(tx));
    return verifier.verify(tx.actorPublicKey, tx.signature, 'base64');
  } catch {
    return false;
  }
}

export class Block {
  constructor({ index, prevHash, transactions, timestamp }) {
    this.index = index;
    this.prevHash = prevHash;
    this.transactions = transactions;
    this.timestamp = timestamp;
    this.nonce = 0;
    this.hash = this.computeHash();
  }

  computeHash() {
    return sha256(
      `${this.index}|${this.prevHash}|${this.timestamp}|${this.nonce}|` +
        JSON.stringify(this.transactions)
    );
  }

  // 데모용 간단한 작업 증명: difficulty 개수만큼 앞자리가 0이 될 때까지 nonce 탐색
  mine(difficulty) {
    const prefix = '0'.repeat(difficulty);
    while (!this.hash.startsWith(prefix)) {
      this.nonce += 1;
      this.hash = this.computeHash();
    }
  }
}

export class TrustChain {
  constructor({ difficulty = 2 } = {}) {
    this.difficulty = difficulty;
    const genesis = new Block({
      index: 0,
      prevHash: '0'.repeat(64),
      transactions: [
        {
          type: 'GENESIS',
          actor: 'system',
          data: { message: '실시간 민주주의 신뢰 네트워크 시작' },
          timestamp: Date.now(),
        },
      ],
      timestamp: Date.now(),
    });
    genesis.mine(this.difficulty);
    this.blocks = [genesis];
  }

  get head() {
    return this.blocks[this.blocks.length - 1];
  }

  // 서명된 트랜잭션 하나를 새 블록으로 채굴해 붙인다 (데모: 트랜잭션 1개 = 블록 1개)
  record(tx) {
    if (!verifyTransaction(tx)) {
      throw new Error('서명 검증 실패: 트랜잭션을 기록할 수 없습니다');
    }
    const block = new Block({
      index: this.blocks.length,
      prevHash: this.head.hash,
      transactions: [tx],
      timestamp: Date.now(),
    });
    block.mine(this.difficulty);
    this.blocks.push(block);
    return block;
  }

  // 체인 전체 무결성 검증: 해시 연결, 작업 증명, 트랜잭션 서명
  verify() {
    const prefix = '0'.repeat(this.difficulty);
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      if (block.hash !== block.computeHash()) {
        return { valid: false, reason: `블록 ${i}의 해시가 내용과 불일치` };
      }
      if (!block.hash.startsWith(prefix)) {
        return { valid: false, reason: `블록 ${i}의 작업 증명 불충족` };
      }
      if (i > 0 && block.prevHash !== this.blocks[i - 1].hash) {
        return { valid: false, reason: `블록 ${i}의 이전 해시 연결이 끊어짐` };
      }
      for (const tx of block.transactions) {
        if (!verifyTransaction(tx)) {
          return { valid: false, reason: `블록 ${i}의 트랜잭션 서명 위조` };
        }
      }
    }
    return { valid: true };
  }

  toJSON() {
    return this.blocks.map((b) => ({
      index: b.index,
      hash: b.hash,
      prevHash: b.prevHash,
      nonce: b.nonce,
      timestamp: b.timestamp,
      transactions: b.transactions.map((t) => ({
        type: t.type,
        actor: t.actor,
        data: t.data,
        timestamp: t.timestamp,
        signature: t.signature ? t.signature.slice(0, 24) + '…' : null,
      })),
    }));
  }
}
