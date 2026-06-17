
const $ = id => document.getElementById(id);
let charts = {}, lastItems = [], lastFilter = 'all';

function showErr(msg){
  const e = $('err'); e.textContent = msg; e.classList.remove('hidden');
}
function clearErr(){ $('err').classList.add('hidden'); }

function destroyChart(k){ if(charts[k]){ charts[k].destroy(); charts[k]=null; } }

function num(v){
  if(v===null||v===undefined||v==='') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g,''));
  return isFinite(n)?n:null;
}

function parseExamInfo(rows){
  // 3행(index 2)에 시험 정보가 있음
  // 예: "2026학년도  1학기  주간  3학년  2 강의실  중간고사  사회(역사/도덕포함):한국지리(3)"
  const row = rows[2] || [];
  const raw = row.map(c=>String(c||'').trim()).filter(Boolean).join(' ');
  // "2026학년도"가 "6학년"으로 오인되지 않도록 학년도/학기 토큰 먼저 제거
  const text = raw.replace(/\d+\s*학년도/g, '');
  const info = {raw};
  let m;
  if((m = text.match(/([1-3])\s*학년/))) info.grade = +m[1];
  const semester = (m = text.match(/(\d)\s*학기/)) ? (m[1]+'학기') : '';
  const exam = (m = text.match(/(중간고사|기말고사|수행평가|쪽지시험)/)) ? m[1] : '';
  info.examName = [semester, exam].filter(Boolean).join(' ');
  // 과목: 콜론(:) 다음 괄호 전 텍스트, 없으면 "(N)" 앞 마지막 의미있는 단어
  if((m = text.match(/:\s*([^():]+?)\s*\(/))) info.subject = m[1].trim();
  else if((m = text.match(/:\s*([^():]+)$/))) info.subject = m[1].trim();
  else if((m = text.match(/([가-힣A-Za-z]+)\s*\(\d+\)\s*$/))) info.subject = m[1].trim();
  return info;
}

function parseSheet(rows){
  // 나이스 교과목별학생답정오표 양식
  // A=학번, B=반/번호(예 1/4), C=이름, D~=문항, 끝부분=선택형점수/서답형점수/기타점수/과목총점
  // 4행=문항번호, 5행=정답, 6행=배점, 7행~=학생  (1-based) → index 3,4,5,6+
  if(rows.length < 7) throw new Error('데이터 행이 부족합니다. 나이스 교과목별학생답정오표 양식인지 확인하세요.');
  const headRow = rows[3] || [];
  const ansRow  = rows[4] || [];
  const ptsRow  = rows[5] || [];

  const colNo = 0, colCls = 1, colName = 2;

  // 요약 컬럼(선택형점수/서답형점수/기타점수/과목총점) 위치 — 행 1~6 전체에서 라벨 검색
  let colSel=-1, colDesc=-1, colEtc=-1, colTotal=-1;
  const maxCols = Math.max(...rows.slice(0,7).map(r=>(r||[]).length));
  for(let r=0;r<Math.min(7,rows.length);r++){
    const row = rows[r]||[];
    for(let c=0;c<maxCols;c++){
      const v = String(row[c]??'').replace(/\s/g,'');
      if(!v) continue;
      if(colSel<0 && v.includes('선택형점수')) colSel=c;
      if(colDesc<0 && v.includes('서답형점수')) colDesc=c;
      if(colEtc<0 && v.includes('기타점수')) colEtc=c;
      if(colTotal<0 && (v.includes('과목총점')||v==='총점')) colTotal=c;
    }
  }
  if(colTotal<0) throw new Error('과목총점 컬럼을 찾지 못했습니다. 파일 양식을 확인해주세요.');

  // 문항 컬럼: D열(인덱스 3)부터 시작, 행4가 양의 정수인 셀만, 요약컬럼 직전까지
  const summaryStart = Math.min(...[colSel,colDesc,colEtc,colTotal].filter(v=>v>=0));
  const items = [];
  for(let c=3;c<summaryStart;c++){
    const h = headRow[c];
    const qn = num(h);
    if(qn===null || qn<=0 || !Number.isInteger(qn)) continue;
    items.push({col:c, qno:qn, answer:String(ansRow[c]??'').trim(), points:num(ptsRow[c])||0});
  }
  if(items.length===0) throw new Error('문항 컬럼을 찾지 못했습니다 (D열부터 행4의 문항번호 확인).');

  // 학생 데이터 (행7~)
  const students = [];
  for(let r=6;r<rows.length;r++){
    const row = rows[r]; if(!row) continue;
    const sno = row[colNo];
    const cname = String(row[colName]??'').trim();
    if((sno===undefined||sno===null||String(sno).trim()==='') && !cname) continue;
    const total = num(row[colTotal]);
    if(total===null) continue; // 응시하지 않은 행 제외
    const sel = colSel>=0?num(row[colSel]):null;
    const desc = colDesc>=0?num(row[colDesc]):null;
    const responses = items.map(it=>String(row[it.col]??'').trim());
    students.push({
      no:String(sno??''),
      cls:String(row[colCls]??''),
      name:cname,
      sel, desc, total,
      responses
    });
  }
  if(students.length===0) throw new Error('학생 데이터가 없습니다.');
  return {items, students};
}

// ---- 등급별 색상 (1등급=빨강 → 마지막등급=보라) ----
const GRADE_COLORS_5 = ['#dc2626','#f97316','#16a34a','#2563eb','#7c3aed'];
const GRADE_COLORS_9 = ['#dc2626','#ea580c','#f97316','#eab308','#16a34a','#0891b2','#2563eb','#7c3aed','#581c87'];
function gradeColor(g, max){ return (max===9?GRADE_COLORS_9:GRADE_COLORS_5)[Math.min(g,max)-1] || '#9ca3af'; }


function isCorrect(resp){
  // '.' = 정답
  return resp === '.';
}

function pearsonCorr(xs, ys){
  const n = xs.length;
  if(n<2) return null;
  const mx = xs.reduce((a,b)=>a+b,0)/n;
  const my = ys.reduce((a,b)=>a+b,0)/n;
  let num=0, dx2=0, dy2=0;
  for(let i=0;i<n;i++){
    const dx = xs[i]-mx, dy = ys[i]-my;
    num += dx*dy; dx2 += dx*dx; dy2 += dy*dy;
  }
  const denom = Math.sqrt(dx2*dy2);
  return denom===0 ? 0 : num/denom;
}

function analyzePointRate(items){
  const xs = items.map(i=>i.points);
  const ys = items.map(i=>i.p*100);
  const r = pearsonCorr(xs, ys);
  const meanPt = xs.reduce((a,b)=>a+b,0)/items.length;
  const meanP  = ys.reduce((a,b)=>a+b,0)/items.length;
  // 4사분면 분류
  const flagged = items.map(i=>{
    const ptHigh = i.points >= meanPt;
    const pHigh  = i.p*100 >= meanP;
    let kind=null, advice='';
    if(ptHigh && pHigh){ kind='쉬운데 비쌈'; advice='고배점 문항임에도 정답률이 높음 → 점수 인플레 가능, 차기에는 동일 단원 심화 문항으로 대체 검토'; }
    else if(!ptHigh && !pHigh){ kind='어려운데 쌈'; advice='저배점 문항임에도 정답률이 낮음 → 학생 노력 보상 부족, 배점 상향 또는 난도 하향 검토'; }
    else if(ptHigh && !pHigh){ kind='적정(고난도-고배점)'; }
    else if(!ptHigh && pHigh){ kind='적정(기본-저배점)'; }
    return {qno:i.qno, points:i.points, p:i.p, kind, advice, mismatch: !!advice};
  });
  return {r, meanPt, meanP, flagged};
}
  // KR-20/Cronbach α (선택형 문항만 기준)
  const k = items.length;
  if(k < 2) return null;
  const itemTotals = students.map(s=>{
    let sum = 0;
    items.forEach((it,idx)=>{ if(s.responses[idx]==='.') sum += it.points; });
    return sum;
  });
  const n = itemTotals.length; if(n<2) return null;
  const mean = itemTotals.reduce((a,b)=>a+b,0)/n;
  const totalVar = itemTotals.reduce((a,b)=>a+(b-mean)**2,0)/n;
  if(totalVar === 0) return null;
  let itemVarSum = 0;
  items.forEach((it,idx)=>{
    let cnt=0, ok=0;
    students.forEach(s=>{
      const r = s.responses[idx];
      if(r==='' || r===undefined) return;
      cnt++;
      if(r==='.') ok++;
    });
    if(cnt===0) return;
    const p = ok/cnt;
    itemVarSum += (it.points**2) * p * (1-p);
  });
  return (k/(k-1)) * (1 - itemVarSum/totalVar);
}

function achievementMatrix(items, students){
  const groups = [
    {label:'A', filter:t=>t>=90},
    {label:'B', filter:t=>t>=80&&t<90},
    {label:'C', filter:t=>t>=70&&t<80},
    {label:'D', filter:t=>t>=60&&t<70},
    {label:'E', filter:t=>t>=40&&t<60},
    {label:'I', filter:t=>t<40},
  ];
  return groups.map(g=>{
    const grp = students.filter(s=>s.total!=null && g.filter(s.total));
    const rates = items.map((it,idx)=>{
      const valid = grp.filter(s=>s.responses[idx]!=='' && s.responses[idx]!==undefined);
      if(valid.length===0) return null;
      const ok = valid.filter(s=>s.responses[idx]==='.').length;
      return ok/valid.length;
    });
    return {label:g.label, n:grp.length, rates};
  });
}

function calcStats(students){
  const totals = students.map(s=>s.total).filter(v=>v!==null);
  const n = totals.length;
  if(n===0) return null;
  const sum = totals.reduce((a,b)=>a+b,0);
  const mean = sum/n;
  const sd = Math.sqrt(totals.reduce((a,b)=>a+(b-mean)**2,0)/n);
  const sorted = [...totals].sort((a,b)=>a-b);
  const median = n%2 ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2;
  const sels = students.map(s=>s.sel).filter(v=>v!==null);
  const descs = students.map(s=>s.desc).filter(v=>v!==null);
  return {
    n, mean, sd, median,
    max: Math.max(...totals), min: Math.min(...totals),
    selMean: sels.length? sels.reduce((a,b)=>a+b,0)/sels.length : null,
    descMean: descs.length? descs.reduce((a,b)=>a+b,0)/descs.length : null
  };
}

function calcItems(items, students){
  // sort by total desc for discrimination
  const sorted = [...students].filter(s=>s.total!==null).sort((a,b)=>b.total-a.total);
  const n = sorted.length;
  const k = Math.max(1, Math.round(n*0.27));
  const top = sorted.slice(0,k);
  const bot = sorted.slice(n-k);

  return items.map((it, idx)=>{
    // 정오표 코드: '.'=정답 / 1~5=오답 선지 / A~Z=복수답안 / '-'=무표기 / 빈칸=무응답
    let cnt=0, ok=0;
    const dist = {};
    students.forEach(s=>{
      const r = s.responses[idx];
      if(r===''||r===undefined||r==='-') return; // 무응답/무표기 제외
      cnt++;
      if(isCorrect(r)) ok++;
      const key = isCorrect(r) ? '정답' : r;
      dist[key] = (dist[key]||0) + 1;
    });
    // 매력적 오답: 가장 많이 선택된 단일 숫자 오답 선지(알파벳/복수답안 제외)
    const wrongs = Object.entries(dist)
      .filter(([k])=>k!=='정답' && /^\d+$/.test(k))
      .sort((a,b)=>b[1]-a[1]);
    const topWrong = wrongs[0] ? {choice:wrongs[0][0], n:wrongs[0][1], rate: cnt?wrongs[0][1]/cnt:0} : null;
    const p = cnt? ok/cnt : 0;
    const tOk = top.filter(s=>isCorrect(s.responses[idx])).length / k;
    const bOk = bot.filter(s=>isCorrect(s.responses[idx])).length / k;
    const d = tOk - bOk;

    let diff;
    if(p>=0.8) diff='쉬움';
    else if(p>=0.6) diff='적절';
    else if(p>=0.4) diff='다소 어려움';
    else if(p>=0.2) diff='어려움';
    else diff='매우 어려움';

    let verdict, tag, comment='';
    if(d<0){ verdict='위험 문항'; tag='t-risk'; comment='음수 변별도 — 정답/선지 검토 필요'; }
    else if(p>=0.9 && d<0.2){ verdict='과도하게 쉬움'; tag='t-easy'; comment='너무 쉬움 + 변별 낮음'; }
    else if(p<0.2){ verdict='과도하게 어려움'; tag='t-warn'; comment='정답률 20% 미만'; }
    else if(d<0.1){ verdict='검토 필요'; tag='t-warn'; comment='변별도 0.10 미만'; }
    else if(p<0.4 && d>=0.3){ verdict='고난도 변별'; tag='t-good'; comment='어렵지만 변별 우수'; }
    else if(p>=0.8){ verdict='쉬운 확인 문항'; tag='t-easy'; comment=''; }
    else if(p>=0.4 && p<=0.8 && d>=0.3){ verdict='우수 문항'; tag='t-good'; comment=''; }
    else { verdict='보통'; tag='t-mid'; comment=''; }

    return {qno:it.qno, points:it.points, answer:it.answer, n:cnt, p, d, diff, verdict, tag, comment, dist, topWrong, tOk, bOk};
  });
}

function gradeCuts(grade){
  if(grade===3) return [0.04,0.11,0.23,0.40,0.60,0.77,0.89,0.96,1.00];
  return [0.10,0.34,0.66,0.90,1.00];
}

function assignGrades(students, grade){
  // NEIS 표준: 중간석차 = 석차 + (동석차 인원수 - 1) / 2
  //           중간석차백분율 = 중간석차 / 수강자수 × 100
  // 동점자 그룹 전체에 동일한 중간석차백분율을 적용해 같은 등급 부여
  const cuts = gradeCuts(grade);
  const list = students.filter(s=>s.total!==null).sort((a,b)=>b.total-a.total);
  const n = list.length;
  let i=0;
  while(i<n){
    let j=i;
    while(j+1<n && list[j+1].total===list[i].total) j++;
    const startRank = i + 1;                        // 석차
    const groupSize = j - i + 1;
    const midRank = startRank + (groupSize - 1) / 2; // 중간석차
    const midPct = midRank / n;                       // 중간석차백분율(0~1)
    let g = cuts.length;
    for(let c=0;c<cuts.length;c++) if(midPct <= cuts[c]+1e-9){ g=c+1; break; }
    for(let x=i;x<=j;x++){
      list[x].rank = startRank;
      list[x].midRank = midRank;
      list[x].midPct = midPct;
      list[x].grade = g;
    }
    i = j+1;
  }
  students.forEach(s=>{ if(s.total===null){ s.grade=null; s.rank=null; s.midRank=null; s.midPct=null; } });
  return list;
}

function gradeDist(students, grade){
  const max = grade===3?9:5;
  const out = [];
  for(let g=1;g<=max;g++){
    const arr = students.filter(s=>s.grade===g);
    const totals = arr.map(s=>s.total);
    out.push({
      grade:g, n:arr.length,
      ratio: students.length? arr.length/students.length*100 : 0,
      min: totals.length?Math.min(...totals):null,
      max: totals.length?Math.max(...totals):null
    });
  }
  return out;
}

function histogram(students){
  const totals = students.map(s=>s.total).filter(v=>v!==null);
  // 성취도 5단계 (A/B/C/D/E) — I(40미만)는 E에 포함되며 stacked로 시각화
  const labels = ['A (90↑)','B (80~90)','C (70~80)','D (60~70)','E (60↓)'];
  const counts  = [0,0,0,0,0]; // E는 40~60만
  const iCounts = [0,0,0,0,0]; // E 위에 겹쳐 표시할 I(40미만) 인원
  totals.forEach(t=>{
    if(t>=90) counts[0]++;
    else if(t>=80) counts[1]++;
    else if(t>=70) counts[2]++;
    else if(t>=60) counts[3]++;
    else if(t>=40) counts[4]++;        // E (40~60)
    else iCounts[4]++;                  // I (40미만) → E 위에 적층
  });
  // 클릭 시 학생 필터에 사용할 범위
  const ranges = [
    {label:'A (90 이상)',     test:t=>t>=90},
    {label:'B (80 ~ 90)',     test:t=>t>=80&&t<90},
    {label:'C (70 ~ 80)',     test:t=>t>=70&&t<80},
    {label:'D (60 ~ 70)',     test:t=>t>=60&&t<70},
    {label:'E (40 ~ 60)',     test:t=>t>=40&&t<60},
  ];
  const iRange = {label:'I (40 미만 · 미도달)', test:t=>t<40};
  return {labels, data:counts, iData:iCounts, ranges, iRange};
}

function classBreakdown(students){
  const map = {};
  students.forEach(s=>{
    const cls = (s.cls||'').split('/')[0] || '미상';
    if(!map[cls]) map[cls] = [];
    if(s.total!==null) map[cls].push(s.total);
  });
  const arr = Object.entries(map).map(([cls,vs])=>({
    cls, n:vs.length,
    mean: vs.length? vs.reduce((a,b)=>a+b,0)/vs.length : 0
  })).sort((a,b)=>a.cls.localeCompare(b.cls,'ko',{numeric:true}));
  const means = arr.map(a=>a.mean);
  const spread = means.length>1 ? Math.max(...means)-Math.min(...means) : 0;
  return {classes:arr, spread};
}

function tagOf(h){ return h ? [h.unit,h.element].filter(Boolean).join(' / ') : ''; }
function reasonForHigh(item, h){
  const tag = tagOf(h);
  const intent = h?.difficulty || '';
  const intentMatch = /상|어려/.test(intent);
  if(item.d<0){
    return `${tag?tag+'에 대한 ':''}쉬운 문항임에도 음수 변별도가 나타남. 상위권 학생들이 오히려 오답을 선택했을 가능성이 있으므로 정답 처리 및 선지 표현의 모호성을 우선 검토할 필요가 있음.`;
  }
  if(item.d<0.1){
    return `${tag?tag+'에 대한 ':''}기본 개념 확인 문항으로 보이나 변별도가 낮아 모든 수준의 학생이 정답을 선택함. 변별 기능이 약하므로 차기 평가에서는 선지 구성을 보완하거나 동일 단원의 심화 문항으로 대체하는 방안을 검토할 필요가 있음.`;
  }
  if(intentMatch && item.p>=0.85){
    return `${tag?tag+'에 대해 ':''}출제 난이도는 '${intent}'으로 의도했으나 정답률이 ${(item.p*100).toFixed(1)}%로 매우 높게 나타남. 발문이 단서를 과도하게 제공했거나 선지 매력도가 낮았을 가능성이 있으므로 차기 출제 시 자료 해석·추론 과정을 강화할 필요가 있음.`;
  }
  if(item.p>=0.95){
    return `${tag?tag+'에 대한 ':''}거의 모든 학생이 정답을 선택한 기본 개념 확인 문항으로, 학습 내용에 대한 전반적 이해도가 안정적임을 보여줌. 다만 변별 측면에서는 기여도가 제한적이므로 출제 비중 조정이 필요함.`;
  }
  if(item.p>=0.9){
    return `${tag?tag+'에 대한 ':''}기본적인 개념 이해를 확인하는 문항으로 학생 대다수가 정답을 선택함. 난이도를 고려했을 때 적정한 확인 문항으로 판단됨.`;
  }
  return `${tag?tag+' ':''}기본 개념 확인 문항으로 난이도를 고려했을 때 적정한 것으로 판단됨.`;
}
function reasonForLow(item, h){
  const tag = tagOf(h);
  const intent = h?.difficulty || '';
  const intentEasy = /하|쉬/.test(intent);
  const intentHard = /상|어려/.test(intent);
  if(item.d<0){
    return `${tag?tag+' — ':''}음수 변별도(${item.d.toFixed(2)})로 나타나 하위권의 정답률이 상위권보다 높은 비정상적 패턴을 보임. 정답 처리 오류 가능성, 선지 표현의 모호성, 발문 해석의 다의성 여부를 우선 점검하고 필요 시 복수 정답 처리 또는 문항 폐기를 검토할 필요가 있음.`;
  }
  if(intentEasy){
    return `${tag?tag+'에 대한 ':''}출제 난이도는 '${intent}'(으)로 의도했으나 실제 정답률이 ${(item.p*100).toFixed(1)}%에 그침. 학생들의 사전 학습 수준과 수업 진행 속도가 출제 의도와 어긋났을 가능성이 있으므로 해당 단원의 수업 도입 단계 보완이 필요함.`;
  }
  const wrongNote = item.topWrong && item.topWrong.rate>=0.3 ? ` 학생들의 ${(item.topWrong.rate*100).toFixed(0)}%가 ${item.topWrong.choice}번 선지를 선택하여 특정 오개념이 광범위하게 형성되어 있는 것으로 판단되므로, 해당 오답 유형을 활용한 보충 지도가 효과적일 것으로 보임.` : '';
  if(intentHard){
    return `${tag?tag+'에 대한 ':''}고난도 문항으로 출제 의도(${intent})에 부합하는 결과임. 상위권 ${(item.tOk*100).toFixed(0)}% / 하위권 ${(item.bOk*100).toFixed(0)}%의 정답률 차이로 변별 기능을 적정 수준 수행함.${wrongNote}`;
  }
  return `${tag?tag+'에 대한 ':''}학생들의 이해도가 낮은 것으로 판단됨. 해당 단원에 대한 보충 지도와 함께 자료 해석·문제 해결 과정에 대한 학습 안내가 필요함.${wrongNote}`;
}


function buildReview(stats, items, gd, grade, subject, examName, students, alpha){
  const cls = classBreakdown(students);
  const totals = students.map(s=>s.total).filter(v=>v!==null);
  // 만점은 항상 100점 가정 (성취도 분할기준 A:90~100)
  const FULL = 100;
  const perfect = totals.filter(t=>t>=FULL).length;
  const aGrade = totals.filter(t=>t>=90).length;
  const eGrade = totals.filter(t=>t>=40 && t<60).length;
  const under40 = totals.filter(t=>t<40).length;
  const aRate = stats.n? aGrade/stats.n : 0;
  const under40Rate = stats.n? under40/stats.n : 0;

  // 표현 보정 (의미 있는 학급만 spread에 반영)
  const spreadDesc = cls.spread<5?'편차가 작은 편임'
    : cls.spread<10?'편차가 크지 않은 편임'
    : cls.spread<15?'편차가 다소 큰 편임':'편차가 큰 편임';
  const aDesc = aRate>=0.20?'비교적 높은 성취를 보임'
    : aRate>=0.10?'적정 수준의 성취를 보임'
    : '다소 낮은 성취를 보임';
  const meanDesc = stats.mean>=80?'매우 높은'
    : stats.mean>=70?'다소 높은'
    : stats.mean>=60?'적정한'
    : stats.mean>=50?'다소 낮은'
    : '낮은';

  // 요약 서술
  let narrative = '';
  narrative += `<p>본 평가의 응시자는 <b>${stats.n}명</b>이며, 평균 <b>${stats.mean.toFixed(1)}점</b>(표준편차 ${stats.sd.toFixed(1)}점, 최고 ${stats.max}점 / 최저 ${stats.min}점)으로 ${meanDesc} 수준의 성취를 보임. `;
  if(cls.classes.length>1){
    const spreadNote = cls.significantCount>=2
      ? `학급별(5명 이상 응시 학급 기준) 평균 차이는 약 ${cls.spread.toFixed(1)}점으로 ${spreadDesc}`
      : `응시 학급 수가 적어 학급별 비교의 통계적 의미는 제한적`;
    narrative += `${spreadNote}. `;
  }
  narrative += `</p>`;

  narrative += `<p>성취도(고정분할 기준) 분포를 보면 `;
  narrative += `<b>A(90점 이상)</b> ${aGrade}명(${(aRate*100).toFixed(1)}%)`;
  if(perfect>0) narrative += ` 가운데 만점자 ${perfect}명을 포함`;
  narrative += `, <b>E(40~60점)</b> ${eGrade}명, `;
  narrative += `<b>I(40점 미만 · 미도달)</b> <span style="color:#dc2626;font-weight:600">${under40}명(${(under40Rate*100).toFixed(1)}%)</span>으로 나타남. `;
  narrative += `해당 A구간 비중은 ${aDesc}. `;
  if(under40>0){
    narrative += `미도달(I) 학생에 대해서는 단원별 보충 지도와 함께 다음 학기 평가 전 진단·개별 피드백이 필요함. `;
  }
  narrative += `</p>`;

  // 격차/난이도 통합 코멘트
  let extra = '';
  if(stats.sd>=22) extra += `표준편차가 ${stats.sd.toFixed(1)}점으로 상·하위권 점수 격차가 크게 나타나, 학습 격차 해소를 위한 수준별 지도 보완이 필요함. `;
  else if(stats.sd<=10) extra += `표준편차가 ${stats.sd.toFixed(1)}점으로 점수 분포가 좁아 학생 간 변별이 충분히 이루어지지 않은 측면이 있음. `;
  if(stats.mean<55) extra += `전반적인 정답률이 낮아 중하위권 학생의 학습 동기 유지를 위해 기본 개념 확인 문항 비중을 보완할 필요가 있음. `;
  else if(stats.mean>=82) extra += `전반적인 정답률이 높아 상위권 변별이 어려운 구조이므로 차기 평가에서는 추론·자료 해석 중심의 고난도 문항을 추가할 필요가 있음. `;
  if(extra) narrative += `<p>${extra}</p>`;

  // 학급별 표 (5명 이상 학급은 ★ 표시)
  let classTable = '';
  if(cls.classes.length>1){
    classTable = `<table><thead><tr><th>학급</th><th>응시</th><th>평균</th></tr></thead><tbody>`
      + cls.classes.map(c=>{
          const small = c.n<5;
          const note = small ? ' <span style="color:#9ca3af;font-size:11px">(소규모)</span>' : '';
          return `<tr><td class="qcell">${c.cls}반</td><td class="qcell">${c.n}</td><td class="qcell">${c.mean.toFixed(1)}${note}</td></tr>`;
        }).join('')
      + `</tbody></table>`;
    if(cls.significantCount<cls.classes.length){
      classTable += `<p style="font-size:11.5px;color:#6b7280;margin:4px 0 0">※ 응시 인원이 5명 미만인 학급은 평균값의 통계적 신뢰성이 낮아 학급별 편차 산정에서 제외됨.</p>`;
    }
  }

  // 문항 분석 표 (90% 이상 / 30% 미만)
  const high = items.filter(i=>i.p>=0.9).sort((a,b)=>a.qno-b.qno);
  const low  = items.filter(i=>i.p<0.3).sort((a,b)=>a.qno-b.qno);
  const itemRow = (label, list, kind) => {
    if(list.length===0) return `<tr><td class="qcell" rowspan="1">${label}</td><td class="none">-</td><td class="none">해당 사항 없음</td></tr>`;
    return list.map((i,idx)=>{
      const reason = kind==='high' ? reasonForHigh(i,null) : reasonForLow(i,null);
      return `<tr>${idx===0?`<td class="qcell" rowspan="${list.length}">${label}</td>`:''}<td class="qcell">${i.qno}번 (${(i.p*100).toFixed(1)}%)</td><td>${reason}</td></tr>`;
    }).join('');
  };
  const itemTable = `<table><thead><tr><th>정답률</th><th>문항(정답률%)</th><th>원인분석 및 대책</th></tr></thead><tbody>`
    + itemRow('90% 이상', high, 'high')
    + itemRow('30% 미만', low, 'low')
    + `</tbody></table>`;

  // 매력적 오답 분석
  let attractSection = '';
  const attract = items.filter(i=>i.p<0.6 && i.topWrong && i.topWrong.rate>=0.3)
                       .sort((a,b)=>b.topWrong.rate-a.topWrong.rate);
  if(attract.length){
    const rows = attract.slice(0,8).map(i=>`<tr>
      <td class="qcell">${i.qno}번</td>
      <td class="qcell">정답 ${i.answer}</td>
      <td class="qcell">${i.topWrong.choice}번 (${(i.topWrong.rate*100).toFixed(1)}%)</td>
      <td>학생 다수가 ${i.topWrong.choice}번 선지를 선택. 해당 선지가 정답으로 보일 만한 부분 개념 또는 오개념을 활용한 보충 지도 필요.</td>
    </tr>`).join('');
    attractSection = `<h3>4. 매력적 오답 분석</h3>`
      + `<p>오답률이 30% 이상인 특정 선지가 존재하는 문항을 정리함. 매력적 오답이 형성된 문항은 학생들의 공통된 오개념을 보여주므로 해당 부분에 대한 집중 보충 지도가 필요함.</p>`
      + `<table><thead><tr><th>문항</th><th>정답</th><th>최다 오답 선지</th><th>해석 및 지도 방향</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // 변별도 위험 문항 상세
  let riskSection = '';
  const risk = items.filter(i=>i.d<0.1).sort((a,b)=>a.d-b.d);
  if(risk.length){
    const rows = risk.map(i=>{
      let cause = '';
      if(i.d<0) cause = `음수 변별도 — 정답 처리 / 선지 표현 우선 검토`;
      else if(i.p>=0.9) cause = `과도하게 쉬워 변별 미작용 — 출제 비중 조정`;
      else if(i.p<0.2) cause = `과도하게 어려워 모두 오답 경향 — 난도 조정 또는 발문 명료화`;
      else cause = `정답률은 적정하나 상하위 구분 미흡 — 선지 매력도 재점검`;
      return `<tr>
        <td class="qcell">${i.qno}번</td>
        <td class="qcell">${(i.p*100).toFixed(1)}%</td>
        <td class="qcell">${i.d.toFixed(2)}</td>
        <td class="qcell">상 ${(i.tOk*100).toFixed(0)}% / 하 ${(i.bOk*100).toFixed(0)}%</td>
        <td>${cause}</td>
      </tr>`;
    }).join('');
    riskSection = `<h3>5. 변별도 검토 필요 문항</h3>`
      + `<table><thead><tr><th>문항</th><th>정답률</th><th>변별도</th><th>상/하 정답률</th><th>원인 및 조치</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // 종합 의견
  const goodN = items.filter(i=>i.verdict==='우수 문항'||i.verdict==='고난도 변별').length;
  const reviewN = items.filter(i=>i.d<0.1).length;
  const negD = items.filter(i=>i.d<0).length;
  const goodPct = items.length? goodN/items.length*100 : 0;
  const reviewPct = items.length? reviewN/items.length*100 : 0;

  const alphaDesc = alpha==null ? null
    : alpha>=0.9 ? '매우 높은'
    : alpha>=0.8 ? '높은'
    : alpha>=0.7 ? '적정'
    : alpha>=0.6 ? '다소 낮은'
    : alpha>=0.5 ? '낮은' : '매우 낮은';
  const alphaText = alpha!=null
    ? ` 검사 신뢰도(Cronbach α)는 <b>${alpha.toFixed(3)}</b>으로 <b>${alphaDesc}</b> 수준임.`
    : '';

  // 우수 문항 비중 차기 목표 — 100% 캡
  let goalText;
  if(goodPct < 40)      goalText = `차기 평가에서는 우수 문항 비중을 <b>50% 이상</b> 수준으로 확대 필요`;
  else if(goodPct < 60) goalText = `우수 문항 비중을 <b>60~70% 수준</b>으로 높이는 것을 목표로 함`;
  else if(goodPct < 80) goalText = `우수 문항 비중을 <b>80% 수준</b>으로 향상시키는 것을 목표로 함`;
  else if(goodPct < 95) goalText = `현재 우수 문항 비중(${goodPct.toFixed(0)}%)을 <b>유지·향상</b>하며 단원별 균형에 집중`;
  else                  goalText = `현재의 우수 문항 비중(${goodPct.toFixed(0)}%)을 <b>유지</b>하며 단원별 출제 비중과 난도 균형 점검에 집중`;

  let closing = `<p>전체 ${items.length}문항 중 정답률 40~80%·변별도 0.30 이상의 <b>우수 문항</b>은 ${goodN}개(${goodPct.toFixed(0)}%), 변별도 0.10 미만으로 <b>검토가 필요한 문항</b>은 ${reviewN}개(${reviewPct.toFixed(0)}%), 그 중 음수 변별도 문항은 ${negD}개로 분석됨.${alphaText}</p>`;
  closing += `<p>`;
  // 평균 기반 코멘트
  if(stats.mean>=82) closing += `· 평균이 ${stats.mean.toFixed(1)}점으로 다소 높아 상위권 변별 여지가 제한적임. 차기 평가에서는 정답률 30~50% 구간의 고난도 추론 문항을 2~3문항 추가하여 변별 기능을 보완할 필요가 있음.<br>`;
  else if(stats.mean<55) closing += `· 평균이 ${stats.mean.toFixed(1)}점으로 낮아 학생들의 학습 동기 저하가 우려됨. 정답률 70% 이상의 기본 개념 확인 문항 비중을 30% 수준으로 확보하여 기본 학력 점검 기능을 강화할 필요가 있음.<br>`;
  else closing += `· 평균 ${stats.mean.toFixed(1)}점·표준편차 ${stats.sd.toFixed(1)}점으로 전반적인 난이도는 적정 수준임.<br>`;
  // 변별도 / 검토 필요 코멘트
  if(negD>0) closing += `· 음수 변별도 문항 ${negD}개에 대한 정답 처리·선지 표현·복수 정답 가능성 점검이 우선 필요함.<br>`;
  if(reviewPct>=25) closing += `· 검토 필요 문항 비율이 ${reviewPct.toFixed(0)}%로 다소 높아 출제 후 동료 교사 교차 검토 단계 강화가 요구됨.<br>`;
  // 신뢰도 코멘트 (보정 권고)
  if(alpha!=null && alpha<0.7) closing += `· 신뢰도(α=${alpha.toFixed(3)})가 적정 기준(0.7)에 미치지 못해, 변별도 낮은 문항 정비와 문항 수 보완이 필요함.<br>`;
  // 배점-정답률 적정성 코멘트
  const ppr = analyzePointRate(items);
  if(ppr.r != null){
    if(ppr.r > 0.1){
      closing += `· 배점-정답률 상관계수가 ${ppr.r.toFixed(2)}로 양의 관계를 보여 쉬운 문항에 더 높은 배점이 매겨진 패턴임. 차기 출제 시 배점 체계를 난이도와 일치하도록 재설계할 필요가 있음.<br>`;
    } else if(ppr.r > -0.1){
      closing += `· 배점-정답률 상관계수가 ${ppr.r.toFixed(2)}로 배점이 실제 난이도와 무관하게 매겨진 경향이 있음. 출제 단계에서 예상 정답률에 근거한 배점 부여를 검토할 필요가 있음.<br>`;
    } else if(ppr.r < -0.4){
      closing += `· 배점-정답률 상관계수가 ${ppr.r.toFixed(2)}로 배점과 실제 난이도가 잘 매칭되어 있어, 출제자의 난이도 예측이 적정한 수준임.<br>`;
    }
    const mismCnt = ppr.flagged.filter(f=>f.mismatch).length;
    if(mismCnt > items.length*0.3) closing += `· 배점-난이도 부조화 문항이 ${mismCnt}개(${Math.round(mismCnt/items.length*100)}%)로 다소 많음. 차기 출제 시 문항별 예상 정답률을 명시하고 그에 근거하여 배점을 재조정하는 절차가 필요함.<br>`;
  }
  // 학급 격차 (의미 있는 학급 수가 2개 이상일 때만)
  if(cls.spread>=10 && cls.significantCount>=2) closing += `· 학급별 평균 편차가 ${cls.spread.toFixed(1)}점으로 다소 큼. 학급 간 학습 격차 원인 분석과 진도·수업 방식 점검이 필요함.<br>`;
  // 미도달
  if(under40Rate>=0.15) closing += `· 미도달(40점 미만) 학생 비율이 ${(under40Rate*100).toFixed(0)}%로 높아 해당 학생군에 대한 별도의 학습 지원 프로그램 운영 검토가 필요함.<br>`;
  // 마무리 — 100% 캡 적용
  closing += `· ${goalText}하고, 단원별 출제 비중과 난이도 균형을 사전 협의하는 절차를 강화하고자 함.`;
  closing += `</p>`;

  const head = `<h3>${grade}학년 · ${subject||'과목'} · ${examName||'중간고사'} 결과 분석</h3>`;
  return head
    + `<h3>1. 평균 및 성취도 해석</h3>` + narrative + classTable
    + `<h3>2. 문항 분석 및 대책</h3>` + itemTable
    + (attractSection || '')
    + (riskSection || '')
    + `<h3>6. 종합 의견 및 개선 방향</h3>` + closing;
}

function animateCount(el, target, duration, decimals, suffix){
  const start = performance.now();
  function frame(now){
    const t = Math.min(1, (now-start)/duration);
    const eased = 1 - Math.pow(1-t, 3); // easeOutCubic
    const cur = target * eased;
    el.textContent = cur.toFixed(decimals) + suffix;
    if(t < 1) requestAnimationFrame(frame);
    else el.textContent = (Number.isInteger(target)?target.toString():target.toFixed(decimals)) + suffix;
  }
  requestAnimationFrame(frame);
}
function activateCountUp(){
  document.querySelectorAll('#summary .stat .v').forEach((el, i)=>{
    const text = el.textContent;
    const m = text.match(/^(-?\d+(?:\.\d+)?)(\D*)$/);
    if(!m) return;
    const target = parseFloat(m[1]);
    const suffix = m[2] || '';
    const decimals = m[1].includes('.') ? m[1].split('.')[1].length : 0;
    el.textContent = '0' + suffix;
    setTimeout(()=>animateCount(el, target, 1100, decimals, suffix), 80 + i*60);
  });
}

function renderSummary(stats, grade, alpha){
  const alphaInfo = alpha!=null ? (alpha>=0.9?'매우 높음':alpha>=0.8?'높음':alpha>=0.7?'적정':alpha>=0.6?'다소 낮음':alpha>=0.5?'낮음':'매우 낮음') : '';
  const alphaTitle = alpha!=null ? `검사 신뢰도 — ${alphaInfo} (Cronbach α)` : '신뢰도 계산 불가';
  const cards = [
    ['응시자 수', stats.n+'명'],
    ['평균', stats.mean.toFixed(2)],
    ['표준편차', stats.sd.toFixed(2)],
    ['중앙값', stats.median.toFixed(1)],
    ['최고점', stats.max],
    ['최저점', stats.min],
    ['선택형 평균', stats.selMean!==null?stats.selMean.toFixed(2):'-'],
    ['서답형 평균', stats.descMean!==null?stats.descMean.toFixed(2):'-'],
    ['신뢰도 α', alpha!=null?alpha.toFixed(3):'-', alphaTitle],
    ['등급제', grade===3?'9등급제':'5등급제'],
  ];
  $('summary').innerHTML = cards.map(([k,v,t])=>`<div class="stat"${t?` title="${t}"`:''}><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
}

function renderGradeTable(gd, grade){
  const maxG = grade===3?9:5;
  const tb = $('gradeTable').querySelector('tbody');
  tb.innerHTML = gd.map(g=>`<tr>
    <td><span style="display:inline-block;width:10px;height:10px;background:${gradeColor(g.grade,maxG)};border-radius:2px;margin-right:6px;vertical-align:middle"></span>${g.grade}등급</td>
    <td>${g.n}</td><td>${g.ratio.toFixed(1)}</td>
    <td>${g.min??'-'}</td><td>${g.max??'-'}</td>
  </tr>`).join('');
  $('gradeLegend').innerHTML = gd.map(g=>`<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:14px;height:14px;background:${gradeColor(g.grade,maxG)};border-radius:3px"></span>${g.grade}등급</span>`).join('');
}

// (HWPX/PDF 인식 코드 제거됨 — 정확도 한계)
async function _removed_pdf(){
  return;
  /* removed
  const pdf = null;
  const SCALE = 2.0;
  const pages = []; // {canvas, vp, w, h, tokens:[{x,y,w,h,text,fontH}]}
  for(let p=1;p<=pdf.numPages;p++){
    const page = await pdf.getPage(p);
    const vp = page.getViewport({scale:SCALE});
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
    await page.render({canvasContext:ctx, viewport:vp}).promise;
    const tc = await page.getTextContent();
    const tokens = tc.items.map(it=>{
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      return {x:tx[4], y:tx[5], w:(it.width||0)*SCALE, h:(it.height||0)*SCALE, text:String(it.str||'').trim(), fontH:Math.abs(tx[3])};
    }).filter(t=>t.text);
    pages.push({canvas, vp, w:canvas.width, h:canvas.height, tokens});
  }

  // 진단: 텍스트 레이어 확인
  const totalTokens = pages.reduce((a,p)=>a+p.tokens.length,0);
  if(totalTokens===0) throw new Error('PDF에 텍스트 레이어가 없습니다(스캔본일 가능성). OCR된 PDF가 필요합니다.');

  // 문항번호 후보 수집 — 다양한 패턴 허용
  // (1) "1." / "1.다음~" / "1) ~" — 토큰이 숫자.으로 시작
  // (2) "1" 단독 토큰 + 인접 토큰이 "." 또는 ".으로 시작"
  // (3) 좌측 여백에 위치한 1~2자리 숫자 (소수점 아닌)
  const cands = [];
  pages.forEach((pg, pi)=>{
    // 페이지의 좌측 컬럼 x를 추정: 모든 토큰 x의 최솟값
    const xs = pg.tokens.map(t=>t.x);
    const minX = xs.length ? Math.min(...xs) : 0;
    pg.tokens.forEach((t, ti)=>{
      let qn = null;
      // 패턴 (1): "N." 또는 "N.텍스트" — 단 소수(N.M)는 제외
      let m = t.text.match(/^(\d{1,2})[.)](?!\d)/);
      if(m){ qn = +m[1]; }
      // 패턴 (2): "N" 단일 + 다음 토큰이 "." 시작
      else if(/^\d{1,2}$/.test(t.text)){
        const next = pg.tokens[ti+1];
        if(next && (next.text==='.' || /^[.)]/.test(next.text)) && Math.abs(next.y-t.y)<10){
          qn = +t.text;
        }
      }
      if(qn===null || qn<1 || qn>50) return;
      // 좌측 여백 근처에 있는 토큰만 채택 (왼쪽 마진에서 페이지폭의 50% 이내)
      if(t.x > minX + pg.w*0.55) return;
      cands.push({qno:qn, page:pi, x:t.x, y:t.y, fontH:t.fontH||14, text:t.text});
    });
  });

  if(cands.length===0){
    throw new Error(`텍스트 ${totalTokens}개 추출됨. "1.", "1)" 형식 문항번호를 찾지 못함. PDF 형식을 확인해주세요.`);
  }
  cands.sort((a,b)=> a.page-b.page || a.y-b.y);

  // 컬럼 분할 추정: 후보들의 x값 분포에서 가장 큰 갭
  const xs = [...new Set(cands.map(c=>Math.round(c.x)))].sort((a,b)=>a-b);
  let colSplit = null, maxGap = 0;
  for(let i=1;i<xs.length;i++){
    const g = xs[i]-xs[i-1];
    if(g>maxGap){ maxGap = g; colSplit = (xs[i]+xs[i-1])/2; }
  }
  const twoCol = maxGap > 200;

  // 컬럼 고려 정렬
  const colOf = c => twoCol ? (c.x < colSplit ? 0 : 1) : 0;
  cands.sort((a,b)=> a.page-b.page || colOf(a)-colOf(b) || a.y-b.y);

  // 1, 2, 3 ... 순차 매칭. 같은 번호 여러 후보가 있을 수 있으므로 첫 출현만 채택.
  const seen = new Set();
  const seq = [];
  let expect = 1;
  for(const c of cands){
    if(seen.has(c.qno)) continue;
    if(c.qno === expect){
      seq.push(c); seen.add(c.qno); expect++;
    } else if(c.qno > expect && c.qno <= expect + 3){
      // 작은 결번 허용
      seq.push(c); seen.add(c.qno); expect = c.qno + 1;
    }
  }
  if(seq.length===0){
    // 순차 매칭 실패 시: 번호별 첫 출현만 모두 채택 (덜 보수적)
    cands.forEach(c=>{
      if(!seen.has(c.qno)){ seq.push(c); seen.add(c.qno); }
    });
    seq.sort((a,b)=>a.qno-b.qno);
  }
  if(seq.length===0) throw new Error('문항 번호 후보 ' + cands.length + '개 발견했으나 시퀀스 구성 실패.');

  // 각 문항 영역 잘라내기
  const out = {};
  for(let i=0;i<seq.length;i++){
    const q = seq[i];
    const next = seq[i+1];
    const pg = pages[q.page];
    const colLeft = !twoCol ? 0 : (colOf(q)===0 ? Math.max(0, q.x - pg.w*0.03) : Math.max(colSplit, q.x - pg.w*0.02));
    const colRight = !twoCol ? pg.w : (colOf(q)===0 ? colSplit : pg.w);
    const top = Math.max(0, q.y - q.fontH - 4);
    let bottom;
    if(next && next.page===q.page && colOf(next)===colOf(q)){
      bottom = next.y - next.fontH - 4;
    } else if(next && next.page===q.page && colOf(next)!==colOf(q)){
      bottom = pg.h - 20; // 같은 페이지에서 컬럼 전환
    } else {
      bottom = pg.h - 20;
    }
    const width = colRight - colLeft;
    const height = Math.max(40, bottom - top);
    const out2 = document.createElement('canvas');
    out2.width = width; out2.height = height;
    out2.getContext('2d').drawImage(pg.canvas, colLeft, top, width, height, 0, 0, width, height);
    out[q.qno] = out2.toDataURL('image/jpeg', 0.85);
  }
  return {map: out, count: seq.length, pages: pdf.numPages, twoCol};
}

function renderPdfPreviews(){
  const card = $('qPreviewCard');
  const grid = $('qPreview');
  if(!pdfQuestions){ card.classList.add('hidden'); grid.innerHTML=''; return; }
  card.classList.remove('hidden');
  const qnos = Object.keys(pdfQuestions).map(Number).sort((a,b)=>a-b);
  grid.innerHTML = qnos.map(q=>{
    const item = lastItems.find(i=>i.qno===q);
    const sub = item ? `정답률 ${(item.p*100).toFixed(1)}% / 변별도 ${item.d.toFixed(2)}` : '';
    return `<div class="qcard" data-q="${q}">
      <div class="qhead"><b>${q}번</b><span style="color:#6b7280">${sub}</span></div>
      <img loading="lazy" src="${pdfQuestions[q]}" alt="${q}번">
    </div>`;
  }).join('');
  grid.querySelectorAll('.qcard').forEach(el=>{
  */
}
function renderItemTable(items, filter){
  let arr = [...items];
  if(filter==='review') arr = arr.filter(i=>i.d<0.1);
  else if(filter==='good') arr = arr.filter(i=>i.verdict==='우수 문항'||i.verdict==='고난도 변별');
  else if(filter==='lowp') arr.sort((a,b)=>a.p-b.p);
  else if(filter==='lowd') arr.sort((a,b)=>a.d-b.d);
  if(filter!=='lowp'&&filter!=='lowd') arr.sort((a,b)=>a.qno-b.qno);
  const tb = $('itemTable').querySelector('tbody');
  tb.innerHTML = arr.map(i=>`<tr>
    <td>${i.qno}</td><td>${i.points}</td><td>${i.answer}</td><td>${i.n}</td>
    <td>${(i.p*100).toFixed(1)}</td><td>${i.d.toFixed(2)}</td>
    <td>${i.diff}</td>
    <td><span class="tag ${i.tag}">${i.verdict}</span></td>
    <td style="text-align:left;color:#6b7280">${i.comment}</td>
  </tr>`).join('');
}

function anonOption(){ return $('anon').checked; }

// 현재 분석 결과를 HTML 스냅샷으로 저장 (차트 포함)
function saveHtml(){
  const result = document.getElementById('result');
  const hasResult = result && !result.classList.contains('hidden');

  // 모달 닫기
  document.querySelectorAll('.qmodal.on').forEach(m=>m.classList.remove('on'));

  // 모든 canvas를 PNG 데이터 URL 이미지로 교체 (스냅샷 보존)
  const swaps = [];
  document.querySelectorAll('canvas').forEach(canvas=>{
    if(!canvas.width || !canvas.height) return;
    try{
      const dataUrl = canvas.toDataURL('image/png');
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = canvas.id || 'chart-snapshot';
      img.style.cssText = 'width:100%;height:auto;display:block;background:#fff;border-radius:6px';
      img.dataset.snapshot = '1';
      canvas.parentNode.insertBefore(img, canvas);
      canvas.style.display = 'none';
      swaps.push({canvas, img});
    }catch(e){ /* skip on taint */ }
  });

  // 저장된 파일에 안내 배너 삽입
  let banner = null;
  if(hasResult){
    banner = document.createElement('div');
    banner.dataset.savedBanner = '1';
    banner.style.cssText = 'background:linear-gradient(135deg,#5b6cff,#a78bfa);color:#fff;padding:8px 14px;border-radius:8px;margin:12px 0;font-size:12px;text-align:center';
    banner.textContent = `📁 저장된 분석 보고서 — ${new Date().toLocaleString('ko-KR')} · 차트는 스냅샷 이미지입니다 (재분석은 새 데이터 업로드 후 [분석 시작])`;
    const main = document.querySelector('main');
    if(main) main.insertBefore(banner, main.firstChild);
  }

  // 직렬화
  const html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;

  // 원복
  swaps.forEach(({canvas, img})=>{
    canvas.style.display = '';
    img.remove();
  });
  if(banner) banner.remove();

  const today = new Date().toISOString().slice(0,10);
  const blob = new Blob([html], {type:'text/html;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Exam-Lens_${today}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1500);
}

function rateColor(p){
  if(p==null) return '#f3f4f6';
  if(p>=0.9) return '#16a34a';
  if(p>=0.75) return '#65a30d';
  if(p>=0.6) return '#eab308';
  if(p>=0.4) return '#f97316';
  if(p>=0.2) return '#ef4444';
  return '#7f1d1d';
}

function renderPointRate(items){
  destroyChart('ppr');
  const a = analyzePointRate(items);
  const r = a.r;
  const interp = r==null?'-'
    : r<=-0.5 ? '강한 음의 상관 — 배점이 난이도와 매우 잘 매칭됨'
    : r<=-0.3 ? '뚜렷한 음의 상관 — 배점-난이도 매칭 양호'
    : r<=-0.1 ? '약한 음의 상관 — 배점-난이도 일치도 보통'
    : r<= 0.1 ? '상관 없음 — 배점이 난이도와 무관하게 매겨짐, 차기 출제 시 배점 체계 재검토 필요'
    :            '양의 상관(이상치) — 쉬운 문항에 더 높은 배점이 매겨진 패턴, 즉시 검토 필요';
  const rColor = r==null?'#6b7280' : r<=-0.3?'#10b981' : r<=-0.1?'#65a30d' : r<=0.1?'#f59e0b':'#dc2626';

  const mismatches = a.flagged.filter(f=>f.mismatch);
  const easyExpensive = mismatches.filter(f=>f.kind==='쉬운데 비쌈').length;
  const hardCheap = mismatches.filter(f=>f.kind==='어려운데 쌈').length;

  // 요약 박스
  $('pprSummary').innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin-bottom:4px">상관계수 (Pearson r)</div>
    <div style="font-size:26px;font-weight:800;color:${rColor};letter-spacing:-.02em;margin-bottom:6px">${r==null?'-':r.toFixed(3)}</div>
    <div style="font-size:12.5px;color:var(--ink-2);line-height:1.55;margin-bottom:10px">${interp}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <div style="flex:1;min-width:80px;background:#fff;border-radius:8px;padding:8px 10px;border:1px solid #ffd6d6">
        <div style="font-size:11px;color:#991b1b">쉬운데 비쌈</div>
        <div style="font-size:18px;font-weight:700;color:#991b1b">${easyExpensive}문항</div>
      </div>
      <div style="flex:1;min-width:80px;background:#fff;border-radius:8px;padding:8px 10px;border:1px solid #ffd6d6">
        <div style="font-size:11px;color:#991b1b">어려운데 쌈</div>
        <div style="font-size:18px;font-weight:700;color:#991b1b">${hardCheap}문항</div>
      </div>
    </div>`;

  // 부조화 문항 표
  if(mismatches.length===0){
    $('pprTable').innerHTML = '<thead><tr><th style="text-align:center">결과</th></tr></thead><tbody><tr><td style="padding:14px;text-align:center;color:#16a34a;font-weight:600">✓ 모든 문항이 배점-난이도 매칭 적정 영역에 있음</td></tr></tbody>';
  }else{
    let html = '<thead><tr><th>문항</th><th>배점</th><th>정답률</th><th>유형</th><th style="text-align:left">권고</th></tr></thead><tbody>';
    mismatches.sort((x,y)=>x.qno-y.qno).forEach(f=>{
      const tagColor = f.kind==='쉬운데 비쌈' ? '#fef3c7' : '#fee2e2';
      const tagText = f.kind==='쉬운데 비쌈' ? '#92400e' : '#991b1b';
      html += `<tr>
        <td style="text-align:center;font-weight:600">${f.qno}</td>
        <td style="text-align:right">${f.points}</td>
        <td style="text-align:right">${(f.p*100).toFixed(1)}%</td>
        <td style="text-align:center"><span style="background:${tagColor};color:${tagText};padding:2px 7px;border-radius:8px;font-size:11px;font-weight:600">${f.kind}</span></td>
        <td style="text-align:left;font-size:11.5px;color:#374151">${f.advice}</td>
      </tr>`;
    });
    html += '</tbody>';
    $('pprTable').innerHTML = html;
    makeSortable($('pprTable'));
  }

  // 산점도 (4사분면 색상)
  Chart.defaults.font.family = "'에이투지체','AtoZ','Pretendard Variable','Pretendard',sans-serif";
  const points = items.map(i=>{
    const ptHigh = i.points >= a.meanPt;
    const pHigh  = i.p*100 >= a.meanP;
    let color = '#10b981'; // 적정
    if(ptHigh && pHigh) color = '#f59e0b';   // 쉬운데 비쌈
    else if(!ptHigh && !pHigh) color = '#dc2626'; // 어려운데 쌈
    return {x:i.points, y:+(i.p*100).toFixed(1), q:i.qno, color};
  });
  charts.ppr = new Chart($('pointRateChart'), {
    type:'scatter',
    data:{datasets:[{
      label:'문항',
      data: points,
      backgroundColor: points.map(p=>p.color),
      borderColor: points.map(p=>p.color),
      pointRadius: 7, pointHoverRadius: 10, borderWidth: 1.5
    }]},
    options:{
      responsive:true, maintainAspectRatio:false,
      animation:{ duration:900, easing:'easeOutQuart' },
      plugins:{
        title:{display:true, text:`배점 ↔ 정답률 산점도 (평균 배점 ${a.meanPt.toFixed(1)}점 / 평균 정답률 ${a.meanP.toFixed(1)}%)`, color:'#1a1f2e', font:{size:13.5,weight:'600'}, padding:{bottom:8}},
        legend:{display:false},
        tooltip:{
          backgroundColor:'rgba(26,31,46,.92)', titleColor:'#fff', bodyColor:'#e5e7eb',
          padding:10, cornerRadius:8,
          callbacks:{
            label:c=>`${c.raw.q}번 — 배점 ${c.raw.x}점 / 정답률 ${c.raw.y}%`
          }
        }
      },
      scales:{
        x:{title:{display:true, text:'배점', color:'#6b7280'}, grid:{color:'rgba(229,232,240,.6)'}},
        y:{title:{display:true, text:'정답률(%)', color:'#6b7280'}, min:0, max:100, grid:{color:'rgba(229,232,240,.6)'}}
      }
    }
  });
}

function renderMatrix(items, students){
  const m = achievementMatrix(items, students);
  let html = '<thead><tr><th style="text-align:center">성취도(인원)</th>';
  items.forEach(it=>{ html += `<th style="text-align:center">${it.qno}</th>`; });
  html += '</tr></thead><tbody>';
  m.forEach(g=>{
    html += `<tr><td style="text-align:center;font-weight:600">${g.label} (${g.n})</td>`;
    g.rates.forEach(r=>{
      const txt = r==null ? '-' : Math.round(r*100);
      const bg = r==null ? '#f9fafb' : rateColor(r);
      const fg = r==null ? '#9ca3af' : (r>=0.4 && r<0.75 ? '#1a1f2e' : '#fff');
      html += `<td style="text-align:center;background:${bg};color:${fg};font-weight:600;padding:6px 4px">${txt}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody>';
  $('matrixTable').innerHTML = html;
}

// 정오표 코드 해석 헬퍼 (A=1,2 / B=1,3 / ... / Z=1,2,3,4,5 등 복수답안)
const MULTI_CODE_MAP = {
  A:'1,2', B:'1,3', C:'1,4', D:'1,5', E:'2,3', F:'2,4', G:'2,5', H:'3,4', I:'3,5', J:'4,5',
  K:'1,2,3', L:'1,2,4', M:'1,2,5', N:'1,3,4', O:'1,3,5', P:'1,4,5', Q:'2,3,4', R:'2,3,5', S:'2,4,5', T:'3,4,5',
  U:'1,2,3,4', V:'1,2,3,5', W:'1,2,4,5', X:'1,3,4,5', Y:'2,3,4,5', Z:'1,2,3,4,5'
};

function renderDistribution(items, students){
  // 단일 숫자 선지(1~5 등)만 컬럼으로 노출. 알파벳=복수답안, '-'/공백=무응답
  const choiceSet = new Set();
  items.forEach((it,idx)=>{
    students.forEach(s=>{
      const r = s.responses[idx];
      if(r==='' || r===undefined || r==='.' || r==='-') return;
      if(/^\d+$/.test(r)) choiceSet.add(r);
    });
  });
  const choices = Array.from(choiceSet).sort((a,b)=>parseInt(a)-parseInt(b));

  let html = '<thead><tr><th style="text-align:center">문항</th><th style="text-align:center">정답</th><th style="text-align:right">정답률</th>';
  choices.forEach(c=>{ html += `<th style="text-align:center">${c}번</th>`; });
  html += '<th style="text-align:center">복수답안</th><th style="text-align:center">무응답</th></tr></thead><tbody>';

  items.forEach((it, idx)=>{
    let cnt=0, ok=0, blank=0, multi=0;
    const distMap = {};
    students.forEach(s=>{
      const r = s.responses[idx];
      if(r===''||r===undefined||r==='-'){ blank++; return; }
      cnt++;
      if(r==='.') ok++;
      else if(/^\d+$/.test(r)) distMap[r] = (distMap[r]||0)+1;
      else { multi++; distMap[r]=(distMap[r]||0)+1; } // 알파벳 등 복수답안
    });
    const total = cnt + blank;
    const p = cnt? ok/cnt : 0;

    const fmt = (n, denom)=> n>0 ? `${n}명(${(n/denom*100).toFixed(0)}%)` : '0명';
    const cell = (n, denom, opts={})=>{
      const txt = fmt(n, denom);
      const clickable = n>0 && opts.dataIdx!=null && opts.choice!=null;
      let style = 'text-align:center;padding:5px 4px;';
      if(opts.correct){ style += 'background:#dcfce7;color:#166534;font-weight:600;'; }
      else if(opts.attractive){ style += 'background:#fee2e2;color:#991b1b;font-weight:600;'; }
      else if(n===0){ style += 'color:#cbd5e1;'; }
      else { style += 'color:#374151;'; }
      if(clickable) style += 'cursor:pointer;text-decoration:underline dotted transparent;';
      const dataAttr = clickable ? ` data-idx="${opts.dataIdx}" data-choice="${opts.choice}" data-label="${opts.label||''}"` : '';
      const prefix = opts.correct ? '✓ ' : '';
      return `<td style="${style}" class="${clickable?'dist-cell':''}"${dataAttr}>${prefix}${txt}</td>`;
    };

    html += `<tr><td style="text-align:center;font-weight:600">${it.qno}</td>`;
    html += `<td style="text-align:center">${it.answer}</td>`;
    html += `<td style="text-align:right;font-weight:600">${(p*100).toFixed(1)}%</td>`;
    const correctChoices = String(it.answer).split(',').map(x=>x.trim());
    choices.forEach(c=>{
      const isCorrectChoice = correctChoices.includes(String(c));
      const n = isCorrectChoice ? ok : (distMap[c]||0);
      const rate = cnt? n/cnt : 0;
      html += cell(n, cnt, {
        correct: isCorrectChoice,
        attractive: !isCorrectChoice && rate>=0.3,
        dataIdx: idx,
        choice: isCorrectChoice ? '.' : c,
        label: `${it.qno}번 — ${isCorrectChoice?'정답('+c+'번)':c+'번 선지'}`
      });
    });
    // 복수답안 컬럼
    html += cell(multi, cnt, {dataIdx: idx, choice:'__MULTI__', label:`${it.qno}번 — 복수답안 응답`});
    // 무응답 컬럼 (분모: 전체 응시자)
    html += cell(blank, total, {dataIdx: idx, choice:'__BLANK__', label:`${it.qno}번 — 무응답`});
    html += '</tr>';
  });
  html += '</tbody>';
  $('distTable').innerHTML = html;

  // 셀 클릭 → 학생 명단 모달
  $('distTable').querySelectorAll('.dist-cell').forEach(el=>{
    el.addEventListener('click', ()=>{
      const idx = +el.dataset.idx;
      const choice = el.dataset.choice;
      const label = el.dataset.label || '문항 응답';
      showResponseStudents(students, idx, choice, label);
    });
  });
}

// 특정 문항에 특정 선지로 응답한 학생 목록 모달
function showResponseStudents(students, itemIdx, choice, title){
  const filterFn = (s)=>{
    const r = s.responses[itemIdx];
    if(choice === '.') return r === '.';
    if(choice === '__BLANK__') return r==='' || r===undefined || r==='-';
    if(choice === '__MULTI__') return r && r!=='.' && r!=='-' && !/^\d+$/.test(r);
    return r === choice;
  };
  const arr = students.filter(filterFn).sort((a,b)=>(b.total??-1)-(a.total??-1));
  const totalN = students.filter(s=>s.total!=null).length;
  const anon = $('anon').checked;
  let extraNote = '';
  if(choice && choice.length===1 && MULTI_CODE_MAP[choice]){
    extraNote = ` <span style="color:#6b7280;font-weight:400;font-size:12px">(${choice} = ${MULTI_CODE_MAP[choice]}번 복합)</span>`;
  }
  $('gModalTitle').innerHTML = `<span style="display:inline-block;width:14px;height:14px;background:#5b6cff;border-radius:3px;vertical-align:middle;margin-right:8px"></span>${title} · ${arr.length}명${extraNote}`;
  const tb = $('gModalTable').querySelector('tbody');
  if(arr.length===0){
    tb.innerHTML = `<tr><td colspan="6" style="padding:20px;text-align:center;color:#9ca3af">해당 학생이 없습니다.</td></tr>`;
  }else{
    tb.innerHTML = arr.map((s,i)=>{
      const {ban, num} = splitCls(s.cls);
      return `<tr>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6;text-align:center">${ban}</td>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6;text-align:center">${num}</td>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6">${anon?`학생${String(i+1).padStart(3,'0')}`:s.name}</td>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:600">${s.total??'-'}</td>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6;text-align:right">${s.rank!=null?`${s.rank}등 / ${totalN}명`:'-'}</td>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6;text-align:right">${s.grade??'-'}등급</td>
      </tr>`;
    }).join('');
  }
  makeSortable($('gModalTable'));
  $('gModal').classList.add('on');
}

// ---- 표 정렬 기능 ----
function makeSortable(tableEl){
  if(!tableEl || tableEl.dataset.sortable==='1') return;
  tableEl.dataset.sortable = '1';
  const ths = tableEl.querySelectorAll('thead th');
  const state = {col:-1, asc:true};
  ths.forEach((th, idx)=>{
    // 정렬 인디케이터 추가
    if(!th.querySelector('.sort-ind')){
      const ind = document.createElement('span');
      ind.className = 'sort-ind';
      ind.textContent = '⇅';
      th.appendChild(ind);
    }
    th.addEventListener('click', ()=>{
      if(state.col===idx) state.asc = !state.asc;
      else { state.col = idx; state.asc = true; }
      const tbody = tableEl.querySelector('tbody');
      if(!tbody) return;
      const rows = Array.from(tbody.querySelectorAll('tr'));
      rows.sort((a,b)=>{
        const av = (a.children[idx]?.textContent || '').trim();
        const bv = (b.children[idx]?.textContent || '').trim();
        const an = parseFloat(av.replace(/[^\d.\-]/g,''));
        const bn = parseFloat(bv.replace(/[^\d.\-]/g,''));
        const numeric = !isNaN(an) && !isNaN(bn) && av.match(/\d/) && bv.match(/\d/);
        const cmp = numeric ? (an - bn) : av.localeCompare(bv, 'ko');
        return state.asc ? cmp : -cmp;
      });
      rows.forEach(r=>tbody.appendChild(r));
      // 헤더 인디케이터 갱신
      ths.forEach((t,i)=>{
        const ind = t.querySelector('.sort-ind');
        if(i===idx){
          t.classList.add('sorted');
          if(ind) ind.textContent = state.asc ? '▲' : '▼';
        }else{
          t.classList.remove('sorted');
          if(ind) ind.textContent = '⇅';
        }
      });
    });
  });
}

function showStudentsBy(students, filterFn, title, anon, color){
  const totalN = students.filter(s=>s.total!=null).length;
  const arr = students.filter(s=>s.total!=null && filterFn(s.total))
                      .sort((a,b)=>(b.total??-1)-(a.total??-1));
  const badge = color ? `<span style="display:inline-block;width:14px;height:14px;background:${color};border-radius:3px;vertical-align:middle;margin-right:8px"></span>` : '';
  $('gModalTitle').innerHTML = `${badge}${title} · ${arr.length}명`;
  const tb = $('gModalTable').querySelector('tbody');
  if(arr.length===0){
    tb.innerHTML = `<tr><td colspan="6" style="padding:20px;text-align:center;color:#9ca3af">해당 학생이 없습니다.</td></tr>`;
  }else{
    tb.innerHTML = arr.map((s,i)=>{
      const {ban, num} = splitCls(s.cls);
      return `<tr>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6;text-align:center">${ban}</td>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6;text-align:center">${num}</td>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6">${anon?`학생${String(i+1).padStart(3,'0')}`:s.name}</td>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:600">${s.total??'-'}</td>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6;text-align:right">${s.rank!=null?`${s.rank}등 / ${totalN}명`:'-'}</td>
        <td style="padding:6px;border-bottom:1px solid #f3f4f6;text-align:right">${s.grade??'-'}등급</td>
      </tr>`;
    }).join('');
  }
  makeSortable($('gModalTable'));
  $('gModal').classList.add('on');
}

function showGradeStudents(students, grade, anon, maxG){
  const totalN = students.filter(s=>s.total!=null).length;
  const arr = students.filter(s=>s.grade===grade)
                      .sort((a,b)=>(b.total??-1)-(a.total??-1));
  $('gModalTitle').innerHTML = `<span style="display:inline-block;width:14px;height:14px;background:${gradeColor(grade,maxG)};border-radius:3px;vertical-align:middle;margin-right:8px"></span>${grade}등급 학생 (${arr.length}명)`;
  const tb = $('gModalTable').querySelector('tbody');
  if(arr.length===0){
    tb.innerHTML = `<tr><td colspan="6" style="padding:20px;text-align:center;color:#9ca3af">해당 등급 학생이 없습니다.</td></tr>`;
  }else{
    tb.innerHTML = arr.map((s,i)=>{
      const {ban, num} = splitCls(s.cls);
      return `<tr>
        <td style="padding:5px;border-bottom:1px solid #f3f4f6;text-align:center">${ban}</td>
        <td style="padding:5px;border-bottom:1px solid #f3f4f6;text-align:center">${num}</td>
        <td style="padding:5px;border-bottom:1px solid #f3f4f6">${anon?`학생${String(i+1).padStart(3,'0')}`:s.name}</td>
        <td style="padding:5px;border-bottom:1px solid #f3f4f6;text-align:right">${s.total??'-'}</td>
        <td style="padding:5px;border-bottom:1px solid #f3f4f6;text-align:right">${s.rank!=null?`${s.rank}등 / ${totalN}명`:'-'}</td>
        <td style="padding:5px;border-bottom:1px solid #f3f4f6;text-align:right">${s.grade??'-'}등급</td>
      </tr>`;
    }).join('');
  }
  makeSortable($('gModalTable'));
  $('gModal').classList.add('on');
}

function splitCls(cls){
  const parts = String(cls||'').split('/');
  return {ban: parts[0]||'', num: parts[1]||''};
}
function renderStudents(students, anon){
  const sorted = [...students].sort((a,b)=>(b.total??-1)-(a.total??-1));
  const tb = $('studentTable').querySelector('tbody');
  tb.innerHTML = sorted.map((s,i)=>{
    const {ban, num} = splitCls(s.cls);
    return `<tr>
      <td>${ban}</td><td>${num}</td>
      <td>${anon?`학생${String(i+1).padStart(3,'0')}`:s.name}</td>
      <td>${s.sel??'-'}</td><td>${s.desc??'-'}</td>
      <td>${s.total??'-'}</td>
      <td>${s.rank??'-'}</td>
      <td>${s.grade??'-'}</td>
    </tr>`;
  }).join('');
}

function drawCharts(items, hist, gd, students, grade, anon){
  destroyChart('hist'); destroyChart('grade'); destroyChart('p'); destroyChart('d'); destroyChart('scatter'); destroyChart('rank'); destroyChart('correctness');
  const maxG = grade===3?9:5;

  // Chart.js 글로벌 폰트/애니메이션 설정
  Chart.defaults.font.family = "'에이투지체','AtoZ','Pretendard Variable','Pretendard',-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#374151';
  const baseAnim = { duration: 1100, easing: 'easeOutQuart' };
  // 차트별 맞춤 애니메이션
  const staggerBar = (per=40)=>({
    duration: 900, easing:'easeOutQuart',
    delay: (ctx)=> ctx.type==='data' && ctx.mode==='default' ? ctx.dataIndex*per : 0
  });
  const waveBar = (per=10)=>({  // 많은 막대용 빠른 wave
    duration: 700, easing:'easeOutCubic',
    delay: (ctx)=> ctx.type==='data' && ctx.mode==='default' ? ctx.dataIndex*per : 0
  });
  const popScatter = {
    radius: { duration: 900, easing:'easeOutBack', from: 0, to: 6,
              delay: (ctx)=> ctx.type==='data' && ctx.mode==='default' ? ctx.dataIndex*30 : 0 },
    numbers: { duration: 800, easing:'easeOutQuart' }
  };
  const stackGrow = {  // 적층 막대: 세그먼트별 stagger
    duration: 1000, easing:'easeOutQuart',
    delay: (ctx)=> ctx.type==='data' && ctx.mode==='default' ? ctx.datasetIndex*250 + ctx.dataIndex*60 : 0
  };

  // 막대 위에 값 표시 플러그인 (formatter가 배열 반환 시 다단 표시)
  const valueLabel = {
    id:'valueLabel',
    afterDatasetsDraw(chart, args, opts){
      if(!opts) return;
      const {ctx} = chart;
      const lineH = 13;
      chart.data.datasets.forEach((ds, dsi)=>{
        const meta = chart.getDatasetMeta(dsi);
        meta.data.forEach((el, i)=>{
          const v = ds.data[i];
          if(v==null || v===0) return;
          ctx.save();
          ctx.fillStyle = opts.color||'#1a1f2e';
          ctx.font = `600 11px ${Chart.defaults.font.family}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const out = opts.formatter ? opts.formatter(v, {dsi, i, chart}) : String(v);
          const lines = Array.isArray(out) ? out : [out];
          lines.forEach((line, idx)=>{
            ctx.fillText(line, el.x, el.y - 4 - (lines.length-1-idx)*lineH);
          });
          ctx.restore();
        });
      });
    }
  };
  const baseTooltip = {
    backgroundColor: 'rgba(26,31,46,.92)',
    titleColor: '#fff', bodyColor:'#e5e7eb',
    titleFont:{weight:'600',size:12.5}, bodyFont:{size:12},
    padding:10, cornerRadius:8, displayColors:true,
    borderColor:'rgba(255,255,255,.1)', borderWidth:1
  };
  const baseTitle = {color:'#1a1f2e', font:{size:13.5,weight:'600'}, padding:{bottom:10}};
  const baseGrid = {color:'rgba(229,232,240,.6)', drawTicks:false};
  // A → E 빨강 → 파랑, I(미도달)는 보라(E 위에 적층)
  const HIST_COLORS = ['#dc2626','#f97316','#eab308','#16a34a','#2563eb'];
  const I_COLOR = '#7c3aed';
  charts.hist = new Chart($('histChart'), {
    type:'bar',
    plugins:[valueLabel],
    data:{
      labels:hist.labels,
      datasets:[
        {
          label:'성취도', data:hist.data, backgroundColor:HIST_COLORS,
          // E(인덱스4)에 I 적층되면 윗변은 평평(0), 그 외엔 둥근 윗변(6). 아랫변은 축에 붙도록 항상 평평.
          borderRadius: hist.data.map((_,i)=> (i===4 && hist.iData[4]>0) ? 0 : 6),
          borderSkipped:'bottom',
          stack:'s', categoryPercentage:0.7, barPercentage:0.85
        },
        {
          label:'I (40미만)', data:hist.iData, backgroundColor:I_COLOR,
          borderRadius:6, borderSkipped:'bottom',
          stack:'s', categoryPercentage:0.7, barPercentage:0.85
        }
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false, animation:stackGrow,
      onClick:(evt, els)=>{
        if(!els.length) return;
        const el = els[0];
        const isI = el.datasetIndex===1;
        if(isI){
          showStudentsBy(students, hist.iRange.test, hist.iRange.label, anon, I_COLOR);
        }else{
          const r = hist.ranges[el.index];
          showStudentsBy(students, r.test, r.label, anon, HIST_COLORS[el.index]);
        }
      },
      onHover:(e,els)=>{ e.native.target.style.cursor = els.length?'pointer':'default'; },
      plugins:{
        title:{display:true,text:'성취도 분포 (막대 클릭 시 학생 목록 · I는 E 위에 적층)',...baseTitle},
        legend:{display:true,position:'bottom',labels:{boxWidth:14,boxHeight:14,padding:12,font:{size:11.5},generateLabels:()=>[
          {text:'A (90↑)', fillStyle:HIST_COLORS[0], strokeStyle:'transparent', lineWidth:0},
          {text:'B (80~90)', fillStyle:HIST_COLORS[1], strokeStyle:'transparent', lineWidth:0},
          {text:'C (70~80)', fillStyle:HIST_COLORS[2], strokeStyle:'transparent', lineWidth:0},
          {text:'D (60~70)', fillStyle:HIST_COLORS[3], strokeStyle:'transparent', lineWidth:0},
          {text:'E (40~60)', fillStyle:HIST_COLORS[4], strokeStyle:'transparent', lineWidth:0},
          {text:'I (40미만)', fillStyle:I_COLOR, strokeStyle:'transparent', lineWidth:0}
        ]}},
        tooltip:{...baseTooltip, callbacks:{
          label:c=>`${c.dataset.label}: ${c.raw}명`,
          footer:c=>{
            const el = c[0];
            if(el.datasetIndex===1) return '클릭 → I(40미만) 학생 보기';
            return '클릭 → ' + hist.labels[el.dataIndex] + ' 학생 보기';
          }
        }},
        valueLabel:{formatter:(v)=>{
          const total = hist.data.reduce((s,n)=>s+n,0) + hist.iData.reduce((s,n)=>s+n,0);
          if(total===0) return [v+'명'];
          return [v+'명', (v/total*100).toFixed(1)+'%'];
        }}
      },
      scales:{
        x:{stacked:true, grid:{display:false}},
        y:{stacked:true, beginAtZero:true, ticks:{precision:0}, grid:baseGrid}
      }
    }
  });
  charts.grade = new Chart($('gradeChart'), {
    type:'bar',
    plugins:[valueLabel],
    data:{labels:gd.map(g=>g.grade+'등급'), datasets:[{label:'인원', data:gd.map(g=>g.n),
      backgroundColor: gd.map(g=>gradeColor(g.grade,maxG)), borderRadius:6, borderSkipped:false}]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:staggerBar(60),
      onClick: (evt, els)=>{
        if(!els.length) return;
        const g = gd[els[0].index].grade;
        showGradeStudents(students, g, anon, maxG);
      },
      onHover:(e,els)=>{ e.native.target.style.cursor = els.length?'pointer':'default'; },
      plugins:{
        title:{display:true,text:'등급 분포 (막대 클릭 시 학생 목록)',...baseTitle},
        legend:{display:false},
        tooltip:{...baseTooltip, callbacks:{footer:()=>'클릭하여 학생 보기'}},
        valueLabel:{formatter:v=>v+'명'}
      },
      scales:{y:{beginAtZero:true, ticks:{precision:0}, grid:baseGrid}, x:{grid:{display:false}}}
    }
  });

  // 석차순 점수 분포 (1등 → 꼴찌, 등급별 색상)
  const ranked = [...students].filter(s=>s.total!==null && s.grade!=null)
                              .sort((a,b)=>(b.total)-(a.total));
  const labels = ranked.map((s,i)=>`${i+1}등`);
  const data = ranked.map(s=>s.total);
  const colors = ranked.map(s=>gradeColor(s.grade, maxG));
  // 등급별 범례용 데이터셋 (실제 표시는 단일 막대지만 색상은 등급별)
  charts.rank = new Chart($('rankChart'), {
    type:'bar',
    data:{labels, datasets:[{label:'점수', data, backgroundColor:colors, borderWidth:0, categoryPercentage:0.95, barPercentage:1.0, borderRadius:3}]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:waveBar(8),
      plugins:{
        title:{display:true,text:`석차순 점수 분포 (전체 ${ranked.length}명, 색상: 등급)`,...baseTitle},
        legend:{display:false},
        tooltip:{...baseTooltip, callbacks:{
          title:c=>{
            const s = ranked[c[0].dataIndex];
            const {ban, num} = splitCls(s.cls);
            const sid = `${grade}${String(ban).padStart(2,'0')}${String(num).padStart(2,'0')}`;
            const nm = anon ? `학생${String(c[0].dataIndex+1).padStart(3,'0')}` : (s.name||'');
            return `${sid} · ${nm}`;
          },
          label:c=>{
            const s = ranked[c.dataIndex];
            const {ban, num} = splitCls(s.cls);
            return `${ban}반 ${num}번 · 총점 ${s.total} · ${s.grade}등급 · 석차 ${c.dataIndex+1}등 (중간석차 ${s.midRank?.toFixed(1)})`;
          }
        }}
      },
      scales:{
        x:{ ticks:{maxTicksLimit:20, autoSkip:true, font:{size:10}}, grid:{display:false} },
        y:{ beginAtZero:true, title:{display:true,text:'점수',color:'#6b7280'}, grid:baseGrid }
      }
    }
  });
  charts.p = new Chart($('pChart'), {
    type:'bar',
    data:{labels:items.map(i=>i.qno), datasets:[{label:'정답률(%)', data:items.map(i=>+(i.p*100).toFixed(1)),
      backgroundColor: items.map(i=>i.p<0.4?'#ef4444':i.p>=0.8?'#94a3b8':'#5b6cff'), borderRadius:4, borderSkipped:false}]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:staggerBar(35),
      plugins:{title:{display:true,text:'문항별 정답률',...baseTitle}, legend:{display:false}, tooltip:baseTooltip},
      scales:{y:{min:0,max:100, grid:baseGrid}, x:{grid:{display:false}}}
    }
  });
  charts.d = new Chart($('dChart'), {
    type:'bar',
    data:{labels:items.map(i=>i.qno), datasets:[{label:'변별도', data:items.map(i=>+i.d.toFixed(3)),
      backgroundColor: items.map(i=>i.d<0?'#7f1d1d':i.d<0.1?'#ef4444':i.d<0.3?'#f59e0b':'#10b981'), borderRadius:4, borderSkipped:false}]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:staggerBar(35),
      plugins:{title:{display:true,text:'문항별 변별도',...baseTitle}, legend:{display:false}, tooltip:baseTooltip},
      scales:{y:{grid:baseGrid}, x:{grid:{display:false}}}
    }
  });
  // 정답률 구간별 문항 수 (양 끝 빨강 = 검토 대상)
  const cBuckets = [
    {label:'≥90% (변별 부족)', short:'≥90', from:0.9, to:Infinity, color:'#dc2626', note:'변별 부족 — 문항 검토 필요'},
    {label:'80~90% (쉬움)',     short:'80~90', from:0.8, to:0.9, color:'#94a3b8', note:'쉬움'},
    {label:'70~80% (적정)',     short:'70~80', from:0.7, to:0.8, color:'#10b981', note:'적정'},
    {label:'60~70% (적정)',     short:'60~70', from:0.6, to:0.7, color:'#10b981', note:'적정'},
    {label:'50~60% (적정-약간 어려움)', short:'50~60', from:0.5, to:0.6, color:'#65a30d', note:'적정-약간 어려움'},
    {label:'40~50% (어려움)',    short:'40~50', from:0.4, to:0.5, color:'#eab308', note:'어려움'},
    {label:'20~40% (고난도)',    short:'20~40', from:0.2, to:0.4, color:'#f97316', note:'고난도'},
    {label:'<20% (킬러)',         short:'<20',   from:0,   to:0.2, color:'#7f1d1d', note:'킬러문항급 — 사유서 작성 검토'}
  ];
  const cCounts = cBuckets.map(b=>items.filter(i=>i.p>=b.from && i.p<b.to).length);
  const cColors = cBuckets.map(b=>b.color);
  charts.correctness = new Chart($('correctnessChart'), {
    type:'bar',
    plugins:[valueLabel],
    data:{labels:cBuckets.map(b=>b.short), datasets:[{label:'문항 수', data:cCounts, backgroundColor:cColors, borderRadius:6, borderSkipped:false}]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:staggerBar(60),
      plugins:{
        title:{display:true,text:'정답률 구간별 문항 수 (양 끝 빨강 = 검토 대상)',...baseTitle},
        legend:{display:false},
        tooltip:{...baseTooltip, callbacks:{
          title:c=>cBuckets[c[0].dataIndex].label,
          label:c=>`${c.raw}문항 — ${cBuckets[c.dataIndex].note}`,
          footer:c=>{
            const b = cBuckets[c[0].dataIndex];
            const matching = items.filter(i=>i.p>=b.from && i.p<b.to).map(i=>i.qno);
            return matching.length ? '문항: ' + matching.join(', ') + '번' : '';
          }
        }},
        valueLabel:{formatter:v=>v+'문항'}
      },
      scales:{
        x:{grid:{display:false}, ticks:{font:{size:10.5}, maxRotation:0, autoSkip:false}},
        y:{beginAtZero:true, ticks:{precision:0}, grid:baseGrid}
      }
    }
  });

  charts.scatter = new Chart($('scatter'), {
    type:'scatter',
    data:{datasets:[{label:'문항(정답률 vs 변별도)',
      data: items.map(i=>({x:+(i.p*100).toFixed(1), y:+i.d.toFixed(3), q:i.qno})),
      backgroundColor:'rgba(91,108,255,.7)', borderColor:'#5b6cff', borderWidth:1.5, pointRadius:6, pointHoverRadius:9}]},
    options:{
      responsive:true, maintainAspectRatio:false, animations:popScatter,
      plugins:{
        title:{display:true,text:'정답률 ↔ 변별도 산점도',...baseTitle},
        legend:{display:false},
        tooltip:{...baseTooltip, callbacks:{label:c=>`${c.raw.q}번  정답률 ${c.raw.x}%, 변별도 ${c.raw.y}`}}
      },
      scales:{
        x:{title:{display:true,text:'정답률(%)',color:'#6b7280'}, min:0, max:100, grid:baseGrid},
        y:{title:{display:true,text:'변별도',color:'#6b7280'}, grid:baseGrid}
      }
    }
  });
}

async function run(){
  clearErr();
  const files = selectedFiles.length ? selectedFiles : Array.from($('file').files);
  if(files.length===0){ showErr('엑셀 파일을 선택해주세요.'); return; }
  try{
    const anon = $('anon').checked;
    let items = null;
    const students = [];
    const fileLog = [];

    for(const f of files){
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, {type:'array'});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
      const parsed = parseSheet(rows);

      if(items===null){
        items = parsed.items;
        // 첫 파일에서 시험 정보 보강 (사용자가 비워둔 경우만)
        const info = parseExamInfo(rows);
        if(info.grade && [1,2,3].includes(info.grade)) $('grade').value = String(info.grade);
        if(info.subject && !$('subject').value.trim()) $('subject').value = info.subject;
        if(info.examName && !$('examName').value.trim()) $('examName').value = info.examName;
      }else{
        // verify item consistency (qno + answer + points)
        if(parsed.items.length !== items.length)
          throw new Error(`${f.name}: 문항 수가 다릅니다 (${parsed.items.length} vs ${items.length})`);
        for(let i=0;i<items.length;i++){
          if(parsed.items[i].qno !== items[i].qno)
            throw new Error(`${f.name}: ${i+1}번째 문항번호 불일치 (${parsed.items[i].qno} vs ${items[i].qno})`);
        }
      }
      parsed.students.forEach(s=>{ s._src = f.name; students.push(s); });
      fileLog.push(`${f.name} (${parsed.students.length}명)`);
    }

    $('fileList').innerHTML = `<div style="background:#dcfce7;color:#166534;padding:8px 12px;border-radius:9px;font-size:12.5px;margin-top:6px;font-weight:500">✓ 병합 완료: ${fileLog.join(', ')} · 총 <b>${students.length}명</b></div>`;

    // 시험 정보 보강 후 최종값 읽기
    const grade = +$('grade').value;
    const subject = $('subject').value.trim();
    const examName = $('examName').value.trim();

    const stats = calcStats(students);
    if(!stats){ showErr('총점 데이터를 계산할 수 없습니다.'); return; }
    assignGrades(students, grade);
    const gd = gradeDist(students, grade);
    const itemRes = calcItems(items, students);
    const hist = histogram(students);

    const alpha = calcCronbach(items, students);
    $('title').textContent = `${subject||'분석 결과'} ${examName? '— '+examName:''}`;
    renderSummary(stats, grade, alpha);
    activateCountUp();
    renderGradeTable(gd, grade);
    lastItems = itemRes; lastFilter='all';
    renderItemTable(itemRes, 'all');
    renderStudents(students, anon);
    drawCharts(itemRes, hist, gd, students, grade, anon);
    renderPointRate(itemRes);
    renderMatrix(items, students);
    renderDistribution(items, students);
    $('review').innerHTML = buildReview(stats, itemRes, gd, grade, subject, examName, students, alpha);

    // 모든 메인 표에 정렬 기능 부여
    makeSortable($('itemTable'));
    makeSortable($('studentTable'));
    makeSortable($('gradeTable'));
    makeSortable($('distTable'));

    $('result').classList.remove('hidden');
    window.scrollTo({top:$('result').offsetTop-10, behavior:'smooth'});
  }catch(e){
    console.error(e);
    showErr('분석 실패: '+e.message);
  }
}

$('run').addEventListener('click', run);

// 인쇄 시 Chart.js 캔버스 강제 리사이즈
// (print 미디어쿼리로 컨테이너만 축소되면 캔버스 픽셀 크기는 그대로라 잘림)
function resizeAllCharts(){
  Object.values(charts).forEach(c=>{ if(c){ try{ c.resize(); }catch(e){} } });
}
window.addEventListener('beforeprint', resizeAllCharts);
window.addEventListener('afterprint',  resizeAllCharts);
// matchMedia 콜백도 함께 (일부 브라우저에서 beforeprint 누락)
if(window.matchMedia){
  const mql = window.matchMedia('print');
  if(mql.addEventListener) mql.addEventListener('change', resizeAllCharts);
}
// 파일 누적 선택 — 여러 번 [파일 선택]을 눌러도 기존 파일에 추가됨
let selectedFiles = [];

function renderFileList(){
  const box = $('fileList');
  if(selectedFiles.length===0){ box.innerHTML = ''; return; }
  let html = '<div style="display:flex;flex-direction:column;gap:5px;margin-top:6px">';
  selectedFiles.forEach((f,i)=>{
    html += `<div style="display:flex;align-items:center;gap:8px;padding:7px 11px;background:#fff;border:1px solid var(--line);border-radius:9px;font-size:12.5px">
      <span style="font-size:14px">📄</span>
      <span style="flex:1;color:var(--ink-2);font-weight:500;word-break:break-all">${f.name} <span style="color:var(--muted-2);font-weight:400">(${(f.size/1024).toFixed(0)} KB)</span></span>
      <button class="ghost remove-file" data-idx="${i}" style="padding:3px 10px;font-size:11px;font-weight:600;border-radius:7px;color:#991b1b;border-color:#fecaca;box-shadow:none">제거</button>
    </div>`;
  });
  html += `<div style="font-size:12px;color:var(--muted);margin-top:4px">총 <b style="color:var(--pri-deep)">${selectedFiles.length}개</b> 파일 선택됨 · [파일 선택]을 다시 누르면 추가 업로드됩니다</div>`;
  if(window._examInfoMsg) html += `<div style="font-size:12px;color:var(--pri-deep);margin-top:2px">자동 인식: ${window._examInfoMsg}</div>`;
  html += '</div>';
  box.innerHTML = html;
  box.querySelectorAll('.remove-file').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      selectedFiles.splice(+btn.dataset.idx, 1);
      renderFileList();
    });
  });
}

$('file').addEventListener('change', async e=>{
  const newFiles = Array.from(e.target.files);
  if(!newFiles.length) return;
  // 같은 파일(name+size) 중복 제외 후 추가
  newFiles.forEach(f=>{
    if(!selectedFiles.some(s=>s.name===f.name && s.size===f.size)){
      selectedFiles.push(f);
    }
  });
  e.target.value = ''; // 같은 파일 다시 선택 가능하도록 초기화
  // 첫 파일에서 시험 정보 자동 추출
  if(selectedFiles.length>0){
    try{
      const buf = await selectedFiles[0].arrayBuffer();
      const wb = XLSX.read(buf, {type:'array'});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
      const info = parseExamInfo(rows);
      const detected = [];
      if(info.grade && [1,2,3].includes(info.grade)){ $('grade').value=String(info.grade); detected.push(`${info.grade}학년`); }
      if(info.subject && !$('subject').value.trim()){ $('subject').value=info.subject; detected.push(`과목: ${info.subject}`); }
      if(info.examName && !$('examName').value.trim()){ $('examName').value=info.examName; detected.push(`시험명: ${info.examName}`); }
      window._examInfoMsg = detected.length ? detected.join(' / ') : '';
    }catch(e){ /* 무시 */ }
  }
  renderFileList();
});
document.querySelectorAll('.filters button').forEach(b=>{
  b.addEventListener('click', ()=>{ lastFilter=b.dataset.f; renderItemTable(lastItems, lastFilter); });
});
