// 지지 줄서기(Support Queue) — "지지는 그 의견 뒤에 줄을 서는 것이다"
//
// 구조
//  - 의견(PROPOSE)이 줄의 머리가 된다. 의견마다 두 개의 줄이 선다:
//    지지 줄(JOIN)과 반대 줄(OPPOSE). 두 줄 모두 같은 머리(의견 항목)에서
//    출발하는 별도의 DAG다.
//  - 줄에 서기 = "나는 이 항목(들) 뒤에 선다"를 서명하는 것. 서명이 앞사람
//    항목의 해시를 덮으므로, 줄에 서는 행위 자체가 앞사람들의 증인이 되는
//    행위다. 내 뒤에 누군가 서는 순간 내 자리는 지워질 수 없게 고정된다.
//    → 검증 노동이 따로 없다. 참여가 곧 검증이다. (지지·반대 모두 동일)
//  - 줄에 설 때 자기 의견(comment)을 첨부할 수 있다. 이것이 그 의견의
//    지지의견/반대의견 목록으로 축적된다 (링크는 역사이므로 목록도 역사다).
//  - 줄의 길이 = 링크 수가 아니라 "현재 서 있는 사람 수". 링크는 지울 수
//    없는 역사로 남고, 떠나기(LEAVE)는 자기 로그에 기록되어 길이만 줄인다.
//
// 입장은 가족(원안+수정안 전체)당 하나다: 어떤 의견을 지지하거나, 어떤
// 의견에 반대하거나, 아무 입장도 없거나. 새 입장이 이전 입장을 대체한다
// (LWW) — 지지에서 반대로 옮기면 지지 줄에서 자동으로 빠진다.
//
// 동시성: 두 사람이 같은 줄 끝에 동시에 서면 줄이 갈라진다. 이는 부정이
// 아니라 분산 시스템의 자연 현상이므로, 다음 사람이 갈라진 끝(팁)들을 모두
// 참조하며 서면 줄은 도로 아문다(DAG 병합). 사람 수는 중복 없이 센다.
//
// 분기(AMEND): 의견에 동의하되 수정하고 싶으면 줄의 한 지점에서 갈라져
// 수정안의 새 줄을 시작한다. 의견은 이렇게 나무(변형 계보)로 진화한다.
import { THRESHOLDS } from '../democracy.js';

const QUEUE_TYPES = new Set(['PROPOSE', 'AMEND', 'JOIN', 'OPPOSE', 'LEAVE']);
const SIDE_TYPE = { support: 'JOIN', oppose: 'OPPOSE' };

// 어떤 의견 줄(지지 또는 반대)의 현재 팁(아무도 뒤에 서지 않은 항목들)
export function tips(node, opinionId, side = 'support') {
  const opinionEntry = node.byHash.get(opinionId);
  if (!opinionEntry) return [];
  const type = SIDE_TYPE[side];
  const joins = [...node.byHash.values()].filter((e) => e.type === type && e.data.opinionId === opinionId);
  const referenced = new Set(joins.flatMap((j) => j.data.behind));
  return [opinionEntry, ...joins].filter((e) => !referenced.has(e.hash)).map((e) => e.hash);
}

// 지지 줄에 서기 (의견 첨부 가능): 이 노드가 아는 팁들 뒤에 선다
export function joinLine(node, wallet, topicId, opinionId, comment = null) {
  const behind = tips(node, opinionId, 'support');
  if (!behind.length) throw new Error('알 수 없는 의견 줄입니다');
  const data = { opinionId, behind };
  if (comment) data.comment = String(comment);
  const entry = wallet.act(topicId, 'JOIN', data);
  node.ingest(entry);
  return entry;
}

// 반대 줄에 서기 (의견 첨부 가능): 반대도 줄이다 — 같은 증인 구조가 적용된다
export function opposeLine(node, wallet, topicId, opinionId, comment = null) {
  const behind = tips(node, opinionId, 'oppose');
  if (!behind.length) throw new Error('알 수 없는 의견 줄입니다');
  const data = { opinionId, behind };
  if (comment) data.comment = String(comment);
  const entry = wallet.act(topicId, 'OPPOSE', data);
  node.ingest(entry);
  return entry;
}

// 줄 떠나기: 가족(원안+수정안 전체) 어디에도 서지 않은 상태가 된다
export function leaveLine(node, wallet, topicId, familyRoot) {
  const entry = wallet.act(topicId, 'LEAVE', { familyRoot });
  node.ingest(entry);
  return entry;
}

// 분기: 부모 의견의 한 지점(behind)에서 갈라져 수정안의 새 줄을 시작한다
export function amendLine(node, wallet, topicId, parentId, { title, body = '', behind = null }) {
  const entry = wallet.act(topicId, 'AMEND', { parentId, behind: behind ?? parentId, title, body });
  node.ingest(entry);
  return entry;
}

// 줄 무결성 점검: 모든 줄서기(지지·반대)의 behind 참조가 실제 항목으로
// 해석되어야 한다. 누군가 줄 중간의 항목을 몰래 지우면, 그 뒤에 선 사람의
// 참조가 허공에 뜬다 — 뒤에 선 사람 전원이 지워진 항목의 증인이다.
export function lineIntegrity(node, opinionId) {
  const links = [...node.byHash.values()].filter(
    (e) => (e.type === 'JOIN' || e.type === 'OPPOSE') && e.data.opinionId === opinionId
  );
  const dangling = [];
  for (const j of links) {
    for (const h of j.data.behind) {
      if (!node.byHash.has(h)) dangling.push({ witness: j.author, missing: h });
    }
  }
  return { intact: dangling.length === 0, dangling };
}

// 주제의 줄서기 상태: 의견 나무(원안·수정안)와 각 의견의 지지/반대 현황.
// 결정적 계산 — 같은 항목 집합이면 어느 노드가 계산해도 동일하다.
export function queueState(node, topicId) {
  const flagged = new Set(node.forkProofs.keys());
  const entries = node
    .entriesForTopic(topicId)
    .filter((e) => QUEUE_TYPES.has(e.type) && !flagged.has(e.author))
    .sort((x, y) => (x.author < y.author ? -1 : x.author > y.author ? 1 : x.seq - y.seq));

  // 의견 등록: 원안(PROPOSE), 수정안(AMEND — 부모가 해석될 때까지 반복)
  const opinions = new Map();
  for (const e of entries) {
    if (e.type === 'PROPOSE') {
      opinions.set(e.hash, {
        id: e.hash,
        parentId: null,
        familyRoot: e.hash,
        title: e.data.title,
        body: e.data.body ?? '',
        authorId: e.author,
      });
    }
  }
  let added = true;
  while (added) {
    added = false;
    for (const e of entries) {
      if (e.type !== 'AMEND' || opinions.has(e.hash)) continue;
      const parent = opinions.get(e.data.parentId);
      if (!parent) continue; // 부모 미도착 — 동기화되면 해석된다
      opinions.set(e.hash, {
        id: e.hash,
        parentId: parent.id,
        familyRoot: parent.familyRoot,
        title: e.data.title,
        body: e.data.body ?? '',
        authorId: e.author,
      });
      added = true;
    }
  }

  // 현재 입장: 가족 안에서 작성자별 최신 행위 하나 (LWW)
  // 제안/수정안 작성·JOIN = 그 의견 지지, OPPOSE = 그 의견 반대, LEAVE = 입장 없음
  const standing = new Map(); // familyRoot -> Map(author -> { opinionId, side, seq })
  const stand = (family, author, opinionId, side, seq) => {
    let m = standing.get(family);
    if (!m) standing.set(family, (m = new Map()));
    const cur = m.get(author);
    if (!cur || seq > cur.seq) m.set(author, { opinionId, side, seq });
  };
  // 첨부된 의견(지지의견/반대의견)은 역사다 — 입장을 바꿔도 목록에 남는다
  const supportComments = new Map(); // opinionId -> [{authorId, text, ts}]
  const opposeComments = new Map();
  const pushComment = (map, opinionId, e) => {
    if (!e.data.comment) return;
    if (!map.has(opinionId)) map.set(opinionId, []);
    map.get(opinionId).push({ authorId: e.author, text: e.data.comment, ts: e.ts });
  };
  for (const e of entries) {
    if (e.type === 'PROPOSE') stand(e.hash, e.author, e.hash, 'support', e.seq);
    else if (e.type === 'AMEND' && opinions.has(e.hash)) {
      stand(opinions.get(e.hash).familyRoot, e.author, e.hash, 'support', e.seq);
    } else if (e.type === 'JOIN' && opinions.has(e.data.opinionId)) {
      stand(opinions.get(e.data.opinionId).familyRoot, e.author, e.data.opinionId, 'support', e.seq);
      pushComment(supportComments, e.data.opinionId, e);
    } else if (e.type === 'OPPOSE' && opinions.has(e.data.opinionId)) {
      stand(opinions.get(e.data.opinionId).familyRoot, e.author, e.data.opinionId, 'oppose', e.seq);
      pushComment(opposeComments, e.data.opinionId, e);
    } else if (e.type === 'LEAVE') {
      stand(e.data.familyRoot, e.author, null, null, e.seq);
    }
  }

  const standersByOpinion = new Map();
  const opposersByOpinion = new Map();
  for (const m of standing.values()) {
    for (const [author, { opinionId, side }] of m.entries()) {
      if (!opinionId) continue;
      const bucket = side === 'oppose' ? opposersByOpinion : standersByOpinion;
      if (!bucket.has(opinionId)) bucket.set(opinionId, []);
      bucket.get(opinionId).push(author);
    }
  }
  for (const list of standersByOpinion.values()) list.sort();
  for (const list of opposersByOpinion.values()) list.sort();

  const total = Math.max(node.registry.size, 1);
  return {
    opinions: [...opinions.values()]
      .map((o) => {
        const standers = standersByOpinion.get(o.id) ?? [];
        const opposers = opposersByOpinion.get(o.id) ?? [];
        const weight = standers.length;
        const against = opposers.length;
        let status;
        if (against > weight) status = '반대 우세';
        else if (weight / total >= THRESHOLDS.leading && weight > against) status = '우세';
        else if (against > 0) status = '경합';
        else status = '제안됨';
        return {
          ...o,
          standers,
          opposers,
          weight,
          against,
          ratio: weight / total,
          status,
          supportComments: supportComments.get(o.id) ?? [],
          opposeComments: opposeComments.get(o.id) ?? [],
        };
      })
      .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1)),
    flagged: [...flagged],
  };
}
