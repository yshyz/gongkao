const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf-8');

// 提取 COURSES 数组
const start = html.indexOf('const COURSES = [');
const end = html.indexOf('];', start);
const data = html.substring(start, end + 2);

// 逐行提取课程: {cat:'xxx',name:"xxx",quark:'xxx'}
const courseRegex = /\{cat:'([^']+)',name:"([^"]+)",quark:'([^']+)'\}/g;
const COURSES = [];
let m;
while ((m = courseRegex.exec(data)) !== null) {
  COURSES.push({ cat: m[1], name: m[2], quark: m[3] });
}

// 统计分类
const cats = {};
COURSES.forEach(c => { cats[c.cat] = (cats[c.cat] || 0) + 1; });
console.log('=== 当前分类 ===');
Object.keys(cats).sort().forEach(k => console.log('  ' + k + ': ' + cats[k]));
console.log('总计: ' + COURSES.length);

// getYear
function getYear(n) {
  const m = n.match(/20\d{2}/);
  if (m) return parseInt(m[0]);
  const m2 = n.match(/(?:^|[^\d])(2[7-9])(?:[^\d]|$)/);
  if (m2) return 2000 + parseInt(m2[1]);
  const m3 = n.match(/(?:^|[^\d])(2[0-6])(?:[^\d]|$)/);
  if (m3) return 2000 + parseInt(m3[1]);
  return 0;
}

const y2027 = COURSES.filter(c => getYear(c.name) >= 2027);
console.log('\n=== 27/2027年课程: ' + y2027.length + ' 门 ===');
y2027.forEach((c, i) => console.log((i+1) + '. [' + c.cat + '] ' + c.name));

const ytmn = COURSES.filter(c => c.cat === '押题模拟');
console.log('\n=== 押题模拟: ' + ytmn.length + ' 门 ===');
ytmn.forEach((c, i) => console.log((i+1) + '. ' + c.name));
