// 데모 초기 데이터: 국정 주요 과제를 분야별 의제로 분할하고,
// 시민·의견·지지·위임·검증 활동을 미리 채워 시스템 동작을 보여준다.
export function seed(democracy) {
  const issues = [
    {
      title: '저출생 대응 재정 배분',
      domain: '복지',
      description: '현금 지원, 돌봄 인프라, 주거 지원 중 어디에 재정을 집중할 것인가.',
    },
    {
      title: '국민연금 개혁 방향',
      domain: '복지',
      description: '보험료율·소득대체율 조정과 세대 간 부담 배분 방안.',
    },
    {
      title: '에너지 전환 로드맵',
      domain: '환경·에너지',
      description: '재생에너지·원자력·화석연료의 중장기 비중과 전환 속도.',
    },
    {
      title: '수도권 주거 안정 대책',
      domain: '경제',
      description: '공급 확대, 수요 관리, 임대차 보호 중 우선순위 결정.',
    },
    {
      title: 'AI 산업 규제 프레임',
      domain: '과학기술',
      description: '고위험 AI의 사전 규제와 산업 진흥 사이의 균형점.',
    },
    {
      title: '지역 의료 공백 해소',
      domain: '보건',
      description: '지역 필수의료 인력 확보와 공공의료 확충 방안.',
    },
  ];
  const issueRefs = issues.map((i) => democracy.createIssue(i));

  const names = ['김하늘', '이도윤', '박서연', '최지호', '정유나', '한민준', '오세아', '류지원', '신다은', '조현우', '문가온', '배수아'];
  const citizens = names.map((n) => democracy.registerCitizen(n));
  const [haneul, doyun, seoyeon, jiho, yuna, minjun, sea, jiwon, daeun, hyunwoo, gaon, sua] = citizens;

  // 저출생: 두 의견 경쟁
  const o1 = democracy.propose(
    haneul.id,
    issueRefs[0].id,
    '돌봄 인프라 중심 투자',
    '현금성 지원보다 국공립 돌봄 시설과 돌봄 인력 처우 개선에 재정을 집중해야 출산·양육의 실질 부담이 줄어든다.'
  );
  const o2 = democracy.propose(
    doyun.id,
    issueRefs[0].id,
    '주거 지원 우선',
    '신혼·육아 가구 대상 장기 공공임대와 저리 대출을 대폭 확대하는 것이 출산 결정에 가장 큰 영향을 준다.'
  );
  democracy.setSupport(seoyeon.id, o1.id, true);
  democracy.setSupport(jiho.id, o1.id, true);
  democracy.setSupport(yuna.id, o2.id, true);
  democracy.addEvidence(
    seoyeon.id,
    o1.id,
    '국공립 돌봄 이용 가구의 둘째 출산 의향이 유의미하게 높다는 국책연구 결과가 있다.',
    'https://example.org/care-study'
  );
  democracy.addChallenge(minjun.id, o2.id, '주거 지원만으로는 돌봄 공백 문제가 해결되지 않는다는 반례가 다수 지역에서 확인된다.');

  // 에너지 전환
  const o3 = democracy.propose(
    sea.id,
    issueRefs[2].id,
    '재생에너지 60% + 원전 보완',
    '2040년까지 재생에너지 비중을 60%로 올리되, 계통 안정성을 위해 기존 원전을 계속 운전한다.'
  );
  democracy.setSupport(jiwon.id, o3.id, true);
  democracy.setSupport(daeun.id, o3.id, true);
  democracy.addEvidence(jiwon.id, o3.id, '전력 계통 시뮬레이션에서 재생 60% + 원전 유지 조합이 정전 위험을 최소화했다.');

  // 주거 안정
  const o4 = democracy.propose(
    hyunwoo.id,
    issueRefs[3].id,
    '공급 확대: 역세권 고밀 개발',
    '수도권 역세권 용적률을 상향하고 공공기여로 공공주택을 확보한다.'
  );
  democracy.setSupport(gaon.id, o4.id, true);

  // AI 규제
  const o5 = democracy.propose(
    sua.id,
    issueRefs[4].id,
    '위험 기반 단계 규제',
    '고위험 용도(의료·채용·치안)만 사전 심사하고, 저위험 AI는 사후 책임 원칙으로 진흥한다.'
  );
  democracy.addEvidence(sua.id, o5.id, 'EU AI Act 시행 사례에서 위험 기반 규제가 산업 위축 없이 안전성을 확보했다.');

  // 분야별 위임: 전문가에게 실시간 위임 (언제든 회수 가능)
  democracy.delegate(minjun.id, '복지', seoyeon.id);
  democracy.delegate(gaon.id, '복지', seoyeon.id);
  democracy.delegate(haneul.id, '환경·에너지', sea.id);
  democracy.delegate(doyun.id, '환경·에너지', sea.id);
  democracy.delegate(yuna.id, '과학기술', sua.id);

  return { issues: issueRefs, citizens };
}
