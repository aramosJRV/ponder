const { chromium } = require('playwright');
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/home/claude/ig/slides.json','utf8'));

const W=1080, H=1350;

const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Source+Sans+3:ital,wght@0,400;0,600;0,700&display=swap");
*{margin:0;padding:0;box-sizing:border-box}
:root{--paper:#FAF6EF;--ink:#1F1B16;--muted:#6E6659;--moss:#3D5A44;--deep:#2C4232;--rust:#A4552E;--hair:#E7DFD2}
body{width:${W}px;height:${H}px;background:var(--paper);color:var(--ink);
  font-family:'Source Sans 3',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.slide{width:${W}px;height:${H}px;padding:96px 92px;display:flex;flex-direction:column;position:relative;overflow:hidden}
.label{font-size:24px;letter-spacing:.20em;text-transform:uppercase;font-weight:600;color:var(--moss)}
.rule{height:1px;background:var(--hair);margin:28px 0 0}
.spacer{flex:1}
h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:500;color:var(--ink);letter-spacing:-.005em}
em{font-style:italic;color:var(--rust)}
.cover h1{font-size:112px;line-height:1.04}
.foot{font-size:26px;color:var(--muted);letter-spacing:.01em}
.foot .url{color:var(--moss);font-weight:600}
.num{font-family:"Cormorant Garamond",serif;font-size:128px;line-height:.9;color:var(--hair);font-weight:600}
.q h1{font-size:82px;line-height:1.1;margin-top:18px}
.a{font-size:34px;line-height:1.5;color:var(--muted);max-width:820px;margin-top:34px}
.cta{background:var(--deep);color:var(--paper)}
.cta .label{color:#9BB3A2}
.cta .rule{background:#4B6653}
.cta h1{font-size:96px;line-height:1.06;color:var(--paper)}
.cta em{color:#E0A57F}
.cta .kicker{font-family:'Cormorant Garamond',serif;font-style:italic;font-size:44px;color:#9BB3A2;margin-bottom:26px}
.cta .foot{color:#C9D6CC;font-size:30px;line-height:1.5}
.cta .foot .url{color:var(--paper)}
.quote h1{font-size:96px;line-height:1.1}
.verse .ref{font-family:'Source Sans 3',sans-serif;font-size:28px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;color:var(--rust);margin-bottom:30px}
.verse h1{font-size:78px;line-height:1.16}
.verse .note{font-size:32px;line-height:1.5;color:var(--muted);margin-top:38px;max-width:820px}
.pg{position:absolute;right:92px;bottom:92px;font-size:24px;color:var(--muted);letter-spacing:.14em;font-weight:600}
.mark{position:absolute;left:92px;bottom:92px;font-family:'Cormorant Garamond',serif;font-size:30px;color:var(--moss);letter-spacing:.06em}
.glyph{position:absolute;right:-90px;top:-90px;width:420px;height:420px;border-radius:50%;background:#3D5A440D}
`;

function slideHTML(s, idx, total){
  if(s.kind==='cover') return `<div class="slide cover"><div class="glyph"></div>
    <div class="label">${s.label}</div><div class="rule"></div><div class="spacer"></div>
    <h1>${s.title}</h1><div class="spacer"></div>
    <div class="foot">${s.foot}</div><div class="pg">${idx}/${total}</div></div>`;
  if(s.kind==='q') return `<div class="slide q">
    <div class="label">${s.lab || ("Question "+s.n)}</div><div class="rule"></div><div class="spacer"></div>
    ${s.n?`<div class="num">${s.n}</div>`:""}<h1>${s.q}</h1><div class="a">${s.a}</div><div class="spacer"></div>
    <div class="mark">Ponder</div><div class="pg">${idx}/${total}</div></div>`;
  if(s.kind==='cta') return `<div class="slide cta"><div class="glyph"></div>
    <div class="label">Ponder</div><div class="rule"></div><div class="spacer"></div>
    <div class="kicker">${s.kicker}</div><h1>${s.title}</h1><div class="spacer"></div>
    <div class="foot">${s.foot}</div><div class="pg">${idx}/${total}</div></div>`;
  if(s.kind==='verse') return `<div class="slide verse">
    <div class="label">Scripture</div><div class="rule"></div><div class="spacer"></div>
    <div class="ref">${s.ref}</div><h1>${s.text}</h1><div class="note">${s.note}</div><div class="spacer"></div>
    <div class="mark">Ponder</div><div class="pg">${idx}/${total}</div></div>`;
  return `<div class="slide quote"><div class="glyph"></div>
    <div class="label">${s.label}</div><div class="rule"></div><div class="spacer"></div>
    <h1>${s.quote}</h1><div class="spacer"></div>
    <div class="foot"><span class="url">${s.foot}</span></div></div>`;
}

(async ()=>{
  const b = await chromium.launch();
  const p = await b.newPage({viewport:{width:W,height:H}, deviceScaleFactor:1});
  const jobs=[];
  Object.keys(data).filter(k=>k.startsWith('carousel_')).forEach(key=>{
    const tag = key.replace('carousel_','').toUpperCase();
    const arr = data[key];
    arr.forEach((s,i)=>jobs.push({html:slideHTML(s,i+1,arr.length),out:`${tag}-${String(i+1).padStart(2,'0')}.png`}));
  });
  data.singles.forEach(s=>jobs.push({html:slideHTML(s),out:`${s.file}.png`}));
  for(const j of jobs){
    await p.setContent(`<style>${CSS}</style>${j.html}`, {waitUntil:'networkidle'});
    await p.evaluate(()=>document.fonts.ready);
    await p.waitForTimeout(250);
    await p.screenshot({path:`/home/claude/ig/out/${j.out}`});
    console.log('rendered', j.out);
  }
  await b.close();
})();
