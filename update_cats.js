const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf-8');

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

// 1. CATS: 押题模拟 → 最新
html = html.replace("'押题模拟'", "'最新'");

// 2. CAT_ICONS: 押题模拟 → 最新
html = html.replace('押题模拟:\'🎯\'', "最新:'🆕'");

// 3. 逐行处理 COURSES: 押题模拟→公考名师, 27/2027课程→最新
const lines = html.split('\n');
let count1 = 0, count2 = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // 匹配课程行
  const m = line.match(/^(\s*)\{cat:'([^']+)',name:"([^"]+)",quark:'([^']+)'\}(,?)/);
  if (m) {
    let cat = m[2], name = m[3];
    let newCat = null;

    if (cat === '押题模拟') {
      newCat = '公考名师';
      count1++;
    } else if (getYear(name) >= 2027) {
      newCat = '最新';
      count2++;
    }

    if (newCat) {
      lines[i] = line.replace("cat:'" + cat + "'", "cat:'" + newCat + "'");
    }
  }
}

fs.writeFileSync('index.html', lines.join('\n'), 'utf-8');
console.log('押题模拟→公考名师: ' + count1 + ' 门');
console.log('27/2027→最新: ' + count2 + ' 门');
console.log('✅ 完成');
