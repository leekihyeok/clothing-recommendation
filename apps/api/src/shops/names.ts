// Display clean-up for public-data shop names that have no Kakao name: drop the company in front and space out the
// branch ("삼성물산비이커성수" → "비이커 성수"). Same company list as services/model/pipeline/blogs.py (CORP_PREFIX).
const CORP_PREFIX =
  /^(삼성물산|에스제이그룹|신세계인터내셔날|인동에프엔|티에스리테일|브랜디드라이프스타일|엘엑스컴퍼니|스타럭스|위비스|코오롱인더스트리|한섬|엘에프|이랜드리테일|에프알엘|세정|패션그룹형지|형지|이터널그룹|더휴컴퍼니|지엔코|아이디룩|한세엠케이|비케이브랜즈|코웰패션|주식회사|\(주\)|㈜)\s*/;
// Area words public data glues to the end of a name.
const AREA_SUFFIX = /(성수|홍대|한남|이태원|명동|강남|신촌|연남|망원|압구정|가로수길|청담|잠실|건대|합정|을지로|종로|동대문)(\d*|점)?$/;

export function cleanName(name: string): string {
  // 29CM's shops are registered as "무신사이구홈" / "무신사이구키즈": the brand is 이구홈 / 이구키즈.
  let n = name.trim().replace(/^무신사(이구)/, '$1');
  const stripped = n.replace(CORP_PREFIX, '');
  if (stripped.length >= 2) n = stripped;
  // "무신사무신사스탠다드" → "무신사스탠다드": a brand repeated by the registration form.
  n = n.replace(/^(.{2,6})\1/, '$1');
  // "비이커성수" → "비이커 성수" (only when the area is glued on without a space)
  const m = n.match(AREA_SUFFIX);
  if (m && m.index && m.index >= 2 && n[m.index - 1] !== ' ') n = `${n.slice(0, m.index)} ${n.slice(m.index)}`;
  return n;
}
