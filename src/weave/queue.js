// 지지 줄서기(Support Queue) — "지지는 그 의견 뒤에 줄을 서는 것이다"
//
// 구조
//  - 의견(PROPOSE)이 줄의 머리가 된다.
//  - 지지(JOIN)는 "나는 이 항목(들) 뒤에 선다"를 서명하는 것이다. 서명이
//    앞사람 항목의 해시를 덮으므로, 줄에 서는 행위 자체가 앞사람들의 증인이
//    되는 행위다. 내 뒤에 누군가 서는 순간 내 자리는 지워질 수 없게 고정된다.
//    → 검증 노동이 따로 없다. 참여가 곧 검증이다.
//  - 줄의 길이 = 링크 수가 아니라 "현재 서 있는 사람 수". 링크는 지울 수
//    없는 역사로 남고, 떠나기(LEAVE)는 자기 로그에 기록되어 길이만 줄인다.
//
// 동시성: 두 사람이 같은 줄 끝에 동시에 서면 줄이 갈라진다. 이는 부정이
// 아니라 분산 시스템의 자연 현상이므로, 다음 사람이 갈라진 끝(팁)들을 모두
// 참조하며 서면 줄은 도로 아문다(DAG 병합). 사람 수는 중복 없이 센다.
//
// 분기(AMEND): 의견에 동의하되 수정하고 싶으면 줄의 한 지점에서 갈라져
// 수정안의 새 줄을 시작한다. 의견은 이렇게 나무(변형 계보)로 진화하고,
// 시민의 "현재 위치"는 가족(원안+모든 수정안) 안에서 최신 행위 하나로
// 정해진다 — 수정안 줄로 옮겨 서면 원안 줄에서는 자동으로 빠진다.
const QUEUE_TYPES = new Set(['PROPOSE', 'AMEND', 'JOIN', 'LEAVE']);

// 어떤 의견 줄의 현재 팁(아무도 뒤에 서지 않은 항목들)
export function tips(node, opinionId) {
  const opinionEntry = node.byHash.get(opinionId);
  if (!opinionEntry) return [];
  const joins = [...node.byHash.values()].filter((e) => e.type === 'JOIN' && e.data.opinionId === opinionId);
  const referenced = new Set(joins.flatMap((j) => j.data.behind));
  return [opinionEntry, ...joins].filter((e) => !referenced.has(e.hash)).map((e) => e.hash);
}

// 줄에 서기: 이 노드가 아는 팁들 뒤에 선다 (갈라진 줄이 있으면 모두 참조해 아물게 한다)
export function joinLine(node, wallet, topicId, opinionId) {
  const behind = tips(node, opinionId);
  if (!behind.length) throw new Error('알 수 없는 의견 줄입니다');
  const entry = wallet.act(topicId, 'JOIN', { opinionId, behind });
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

// 줄 무결성 점검: 모든 JOIN의 behind 참조가 실제 항목으로 해석되어야 한다.
// 누군가 줄 중간의 항목을 몰래 지우면, 그 뒤에 선 사람의 참조가 허공에 뜬다 —
// 뒤에 선 사람 전원이 지워진 항목의 증인이다.
export function lineIntegrity(node, opinionId) {
  const joins = [...node.byHash.values()].filter((e) => e.type === 'JOIN' && e.data.opinionId === opinionId);
  const dangling = [];
  for (const j of joins) {
    for (const h of j.data.behind) {
      if (!node.byHash.has(h)) dangling.push({ witness: j.author, missing: h });
    }
  }
  return { intact: dangling.length === 0, dangling };
}

// 주제의 줄서기 상태: 의견 나무(원안·수정안)와 각 줄의 현재 길이.
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

  // 현재 위치: 가족 안에서 작성자별 최신 행위 하나 (LWW)
  // 제안/수정안 작성 = 그 줄에 서기, JOIN = 그 줄에 서기, LEAVE = 어디에도 안 서기
  const standing = new Map(); // familyRoot -> Map(author -> { opinionId, seq })
  const stand = (family, author, opinionId, seq) => {
    let m = standing.get(family);
    if (!m) standing.set(family, (m = new Map()));
    const cur = m.get(author);
    if (!cur || seq > cur.seq) m.set(author, { opinionId, seq });
  };
  for (const e of entries) {
    if (e.type === 'PROPOSE') stand(e.hash, e.author, e.hash, e.seq);
    else if (e.type === 'AMEND' && opinions.has(e.hash)) stand(opinions.get(e.hash).familyRoot, e.author, e.hash, e.seq);
    else if (e.type === 'JOIN' && opinions.has(e.data.opinionId)) stand(opinions.get(e.data.opinionId).familyRoot, e.author, e.data.opinionId, e.seq);
    else if (e.type === 'LEAVE') stand(e.data.familyRoot, e.author, null, e.seq);
  }

  const standersByOpinion = new Map();
  for (const m of standing.values()) {
    for (const [author, { opinionId }] of m.entries()) {
      if (!opinionId) continue;
      if (!standersByOpinion.has(opinionId)) standersByOpinion.set(opinionId, []);
      standersByOpinion.get(opinionId).push(author);
    }
  }
  for (const list of standersByOpinion.values()) list.sort();

  const total = Math.max(node.registry.size, 1);
  return {
    opinions: [...opinions.values()]
      .map((o) => {
        const standers = standersByOpinion.get(o.id) ?? [];
        return { ...o, standers, weight: standers.length, ratio: standers.length / total };
      })
      .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1)),
    flagged: [...flagged],
  };
}
