import type { MazeProject } from '../../core/maze/types'
import { migrateProject } from '../../core/maze/serialization'
import { renderMazeSvg } from './svg'

export interface StandaloneHtmlOptions {
  includeCreatorReplay?: boolean
  includeSecret?: boolean
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Escapes JSON for an inline script. In particular, a user-entered `</script>`
 * must never be able to end the data block.
 */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function createStandaloneHtml(
  source: MazeProject,
  options: StandaloneHtmlOptions = {},
): string {
  const project = migrateProject(source)
  if (options.includeCreatorReplay === false) project.creatorReplay = null
  if (options.includeSecret === false) {
    project.secretReveal = {
      ...project.secretReveal,
      content: { kind: 'none' },
    }
  }

  const width = Math.max(1, project.canvas.width)
  const height = Math.max(1, project.canvas.height)
  const cellWidth = width / Math.max(1, project.mazeGraph.cols)
  const cellHeight = height / Math.max(1, project.mazeGraph.rows)
  const startX = (project.startCell.col + 0.5) * cellWidth
  const startY = (project.startCell.row + 0.5) * cellHeight
  const markerRadius = Math.max(
    1.25,
    Math.min(cellWidth, cellHeight) * 0.25,
  )
  const markers = `<g aria-hidden="true"><circle id="ghost" cx="${startX}" cy="${startY}" r="${markerRadius}" fill="${escapeHtml(
    project.visualTheme.accentColor,
  )}" opacity="0" pointer-events="none"/><circle id="player" cx="${startX}" cy="${startY}" r="${markerRadius}" fill="#ffffff" stroke="${escapeHtml(
    project.visualTheme.wallColor,
  )}" stroke-width="${Math.max(1, project.visualTheme.wallWidth)}" pointer-events="none"/><g id="hint-layer" pointer-events="none"/></g>`
  const mazeSvg = renderMazeSvg(project, {
    includeEndpoints: true,
    includeBackground: true,
    includeTitle: true,
  }).replace('</svg>', `${markers}</svg>`)
  const data = safeJsonForScript(project)

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(project.title)} · MazeCraft</title>
  <style>
    :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef1f5;color:#172033}
    *{box-sizing:border-box}
    html,body{margin:0;min-height:100%;overscroll-behavior:none}
    body{min-height:100dvh;display:grid;place-items:center;padding:clamp(12px,3vw,28px);background:#eef1f5}
    button{font:inherit;min-width:44px;min-height:44px;border:1px solid #cad1db;border-radius:10px;background:#fff;color:#172033;font-weight:650;cursor:pointer}
    button:hover{background:#f7f8fa}button:focus-visible{outline:3px solid #5b75ff;outline-offset:2px}
    .app{width:min(100%,1050px);display:grid;gap:14px}
    header,.hud,.card{background:#fff;border:1px solid #d8dee8;border-radius:14px}
    header{padding:16px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px}
    h1{font-size:clamp(1.1rem,3vw,1.45rem);margin:0}p{margin:.2rem 0 0;color:#657087}
    .hud{display:flex;align-items:center;gap:16px;padding:10px 14px;flex-wrap:wrap}
    .stat{display:grid;gap:2px}.label{font-size:.75rem;color:#657087}.value{font-variant-numeric:tabular-nums;font-weight:760}
    .grow{flex:1}.maze-wrap{position:relative;display:grid;place-items:center;min-height:0;touch-action:none;overflow:hidden}
    .maze-wrap svg{display:block;width:100%;height:auto;max-height:min(70dvh,760px)}
    .controls{display:flex;gap:8px;flex-wrap:wrap}
    .primary{background:#3458eb;color:#fff;border-color:#3458eb}.primary:hover{background:#2647cd}
    .dpad{display:grid;grid-template-columns:repeat(3,52px);grid-template-rows:repeat(2,48px);gap:5px;justify-content:center}
    .dpad button[data-dir=up]{grid-column:2}.dpad button[data-dir=left]{grid-column:1;grid-row:2}.dpad button[data-dir=down]{grid-column:2;grid-row:2}.dpad button[data-dir=right]{grid-column:3;grid-row:2}
    .secret{display:none;padding:22px;text-align:center}.secret.open{display:block;animation:reveal .35s ease-out}.secret img{max-width:min(100%,620px);max-height:46dvh;border-radius:12px}.secret a{display:inline-flex;padding:11px 16px;border-radius:9px;background:#3458eb;color:#fff;text-decoration:none;font-weight:700}.secret-code{display:inline-block;padding:10px 16px;border:1px dashed #7a8497;border-radius:8px;font:700 1.2rem ui-monospace,monospace}
    #hint-layer circle{fill:#ffd84d;opacity:.6;animation:pulse 1s ease-in-out infinite alternate}
    #ghost{transition:cx .08s linear,cy .08s linear}
    @keyframes reveal{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes pulse{to{opacity:.25}}
    @media(max-width:600px){body{padding:8px}.app{gap:8px}header{padding:11px 12px}.maze-wrap svg{max-height:58dvh}.hud{gap:10px}.subtitle{display:none}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
    @media(prefers-color-scheme:dark){:root,body{background:#11151d;color:#eef2f8}header,.hud,.card,button{background:#1c222d;color:#eef2f8;border-color:#343d4b}p,.label{color:#aeb8c8}button:hover{background:#252d39}}
  </style>
</head>
<body>
  <main class="app">
    <header>
      <div><h1>${escapeHtml(project.title)}</h1><p class="subtitle">${escapeHtml(
        project.description || '풀어야만 열리는 이야기',
      )}</p></div>
      <button id="restart" type="button">처음부터</button>
    </header>
    <section class="hud" aria-label="게임 기록">
      <div class="stat"><span class="label">시간</span><span class="value" id="time">00:00.00</span></div>
      <div class="stat"><span class="label">이동</span><span class="value" id="moves">0</span></div>
      <div class="stat"><span class="label">잘못 든 길</span><span class="value" id="wrong">0</span></div>
      <div class="stat"><span class="label">힌트</span><span class="value" id="hints">${project.gameRules.allowedHints}</span></div>
      <div class="grow"></div>
      <div class="controls"><button id="pause" type="button">일시정지</button><button id="hint" type="button"${
        project.gameRules.allowedHints < 1 ? ' disabled' : ''
      }>힌트</button>${
        project.gameRules.ghostAllowed && project.creatorReplay?.completed
          ? '<button id="ghost-toggle" type="button" aria-pressed="false">고스트 대결</button>'
          : ''
      }</div>
    </section>
    <section class="card maze-wrap" id="maze" aria-label="미로 플레이 영역">${mazeSvg}</section>
    ${
      project.gameRules.showDpad
        ? `<nav class="dpad" aria-label="이동 방향">
      <button type="button" data-dir="up" aria-label="위로 이동">↑</button>
      <button type="button" data-dir="left" aria-label="왼쪽으로 이동">←</button>
      <button type="button" data-dir="down" aria-label="아래로 이동">↓</button>
      <button type="button" data-dir="right" aria-label="오른쪽으로 이동">→</button>
    </nav>`
        : ''
    }
    <section class="card secret" id="secret" aria-live="polite"><h2 id="secret-title">이야기가 열렸습니다</h2><div id="secret-content"></div><p id="result"></p></section>
  </main>
  <script>
  "use strict";
  const project=${data};
  const cells=new Map(project.mazeGraph.cells.filter(c=>c.active).map(c=>[c.row+":"+c.col,c]));
  const dirs={up:{dr:-1,dc:0,wall:"top"},right:{dr:0,dc:1,wall:"right"},down:{dr:1,dc:0,wall:"bottom"},left:{dr:0,dc:-1,wall:"left"}};
  const opposites={up:"down",right:"left",down:"up",left:"right"};
  const player=document.getElementById("player"),ghost=document.getElementById("ghost"),timeEl=document.getElementById("time"),movesEl=document.getElementById("moves"),wrongEl=document.getElementById("wrong"),hintsEl=document.getElementById("hints"),hintLayer=document.getElementById("hint-layer");
  const cw=${cellWidth},ch=${cellHeight},limitMs=${
    project.gameRules.timeLimitSeconds
      ? Math.max(0, project.gameRules.timeLimitSeconds * 1_000)
      : 0
  };
  let position={...project.startCell},moves=0,wrong=0,hints=project.gameRules.allowedHints,startedAt=0,elapsed=0,paused=false,complete=false,frameId=0,ghostOn=false,ghostStarted=0,touchStart=null;
  function key(p){return p.row+":"+p.col}
  function center(p){return{x:(p.col+.5)*cw,y:(p.row+.5)*ch}}
  function format(ms){const total=Math.max(0,ms),minutes=Math.floor(total/60000),seconds=Math.floor(total%60000/1000),hundredths=Math.floor(total%1000/10);return String(minutes).padStart(2,"0")+":"+String(seconds).padStart(2,"0")+"."+String(hundredths).padStart(2,"0")}
  function solve(from){
    const queue=[from],seen=new Set([key(from)]),parent=new Map();
    for(let qi=0;qi<queue.length;qi+=1){const current=queue[qi];if(current.row===project.endCell.row&&current.col===project.endCell.col)break;const cell=cells.get(key(current));if(!cell)continue;
      for(const [name,d] of Object.entries(dirs)){if(cell.walls[d.wall])continue;const next={row:current.row+d.dr,col:current.col+d.dc};const target=cells.get(key(next));if(!target||seen.has(key(next))||target.walls[opposites[name]])continue;seen.add(key(next));parent.set(key(next),current);queue.push(next)}
    }
    const endKey=key(project.endCell);if(!seen.has(endKey))return[];const path=[];let cursor=project.endCell;while(key(cursor)!==key(from)){path.push(cursor);cursor=parent.get(key(cursor));if(!cursor)return[]}path.push(from);return path.reverse()
  }
  const answer=new Set(solve(project.startCell).map(key));
  function drawPosition(){const p=center(position);player.setAttribute("cx",p.x);player.setAttribute("cy",p.y)}
  function tick(now){if(!paused&&!complete&&startedAt){elapsed=now-startedAt;timeEl.textContent=format(limitMs?Math.max(0,limitMs-elapsed):elapsed);if(limitMs&&elapsed>=limitMs)timeUp()}if(ghostOn)drawGhost(now);frameId=requestAnimationFrame(tick)}
  function startClock(){if(!startedAt)startedAt=performance.now()-elapsed}
  function move(name){
    if(paused||complete)return;const d=dirs[name],cell=cells.get(key(position));if(!d||!cell||cell.walls[d.wall])return;
    const target={row:position.row+d.dr,col:position.col+d.dc},targetCell=cells.get(key(target));if(!targetCell||targetCell.walls[opposites[name]])return;
    startClock();const wasAnswer=answer.has(key(position));position=target;moves+=1;if(wasAnswer&&!answer.has(key(position)))wrong+=1;movesEl.textContent=moves;wrongEl.textContent=wrong;drawPosition();hintLayer.replaceChildren();
    if(position.row===project.endCell.row&&position.col===project.endCell.col)finish()
  }
  function finish(){if(complete)return;complete=true;elapsed=startedAt?performance.now()-startedAt:0;timeEl.textContent=format(elapsed);try{const bestKey="mazecraft.best."+project.id,previous=Number(localStorage.getItem(bestKey)||0);if(!previous||elapsed<previous)localStorage.setItem(bestKey,String(elapsed))}catch{}revealSecret();const creator=project.creatorReplay?.completed?project.creatorReplay.durationMs:null;document.getElementById("result").textContent="완주 "+format(elapsed)+" · 이동 "+moves+"회 · 잘못 든 길 "+wrong+"회"+(creator?" · 제작자보다 "+format(Math.abs(elapsed-creator))+" "+(elapsed<creator?"빠름":"느림"):"")}
  function timeUp(){if(complete)return;complete=true;elapsed=limitMs;timeEl.textContent="00:00.00";document.getElementById("secret-title").textContent="시간이 끝났습니다";document.getElementById("secret-content").replaceChildren();document.getElementById("result").textContent="처음부터 버튼을 눌러 다시 도전하세요.";document.getElementById("secret").classList.add("open")}
  function revealSecret(){const host=document.getElementById("secret-content"),secret=project.secretReveal.content;host.replaceChildren();const addText=text=>{const p=document.createElement("p");p.textContent=text;host.append(p)};if(secret.kind==="message")addText(secret.message);else if(secret.kind==="image"||secret.kind==="image-message"){if(/^data:image\\/(?:png|jpeg|webp|svg\\+xml);base64,/i.test(secret.imageDataUrl)){const img=document.createElement("img");img.src=secret.imageDataUrl;img.alt=secret.alt||"숨겨진 이미지";host.append(img)}else addText("숨겨진 이미지 형식을 읽을 수 없습니다.");if(secret.message)addText(secret.message)}else if(secret.kind==="link"){const a=document.createElement("a");a.textContent=secret.label;try{const u=new URL(secret.url);if(["https:","http:","mailto:"].includes(u.protocol)){a.href=u.href;a.rel="noopener noreferrer";a.target="_blank";host.append(a)}else addText("안전하지 않은 링크는 열 수 없습니다.")}catch{addText("링크 주소를 확인해 주세요.")}}else if(secret.kind==="coupon"){const code=document.createElement("span");code.className="secret-code";code.textContent=secret.code;host.append(code);addText(secret.message)}else if(secret.kind==="hint"){addText(secret.message+" · "+secret.nextLocation)}else addText("완주했습니다.");document.getElementById("secret").classList.add("open");document.getElementById("secret").scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"})}
  function showHint(){if(paused||complete||hints<=0)return;const path=solve(position).slice(1,6);if(!path.length)return;hints-=1;hintsEl.textContent=hints;hintLayer.replaceChildren(...path.map(p=>{const c=document.createElementNS("http://www.w3.org/2000/svg","circle"),xy=center(p);c.setAttribute("cx",xy.x);c.setAttribute("cy",xy.y);c.setAttribute("r",Math.max(1,Math.min(cw,ch)*.18));return c}));setTimeout(()=>hintLayer.replaceChildren(),1800)}
  function drawGhost(now){const replay=project.creatorReplay;if(!ghostOn||!replay?.frames?.length)return;const t=(now-ghostStarted)%Math.max(1,replay.durationMs),frames=replay.frames;let frame=frames[0];for(const item of frames){if(item.atMs>t)break;frame=item}const p=center(frame);ghost.setAttribute("cx",p.x);ghost.setAttribute("cy",p.y)}
  function restart(){position={...project.startCell};moves=wrong=elapsed=0;hints=project.gameRules.allowedHints;startedAt=0;complete=paused=false;movesEl.textContent="0";wrongEl.textContent="0";hintsEl.textContent=hints;timeEl.textContent=format(limitMs||0);document.getElementById("pause").textContent="일시정지";document.getElementById("secret-title").textContent="이야기가 열렸습니다";document.getElementById("secret").classList.remove("open");hintLayer.replaceChildren();drawPosition()}
  document.addEventListener("keydown",e=>{const map={ArrowUp:"up",w:"up",W:"up",ArrowRight:"right",d:"right",D:"right",ArrowDown:"down",s:"down",S:"down",ArrowLeft:"left",a:"left",A:"left"};if(map[e.key]){e.preventDefault();move(map[e.key])}else if(e.key===" "){e.preventDefault();document.getElementById("pause").click()}});
  document.querySelectorAll("[data-dir]").forEach(button=>{let repeat=0;const go=()=>{move(button.dataset.dir);repeat=window.setInterval(()=>move(button.dataset.dir),120)};const stop=()=>clearInterval(repeat);button.addEventListener("pointerdown",go);button.addEventListener("pointerup",stop);button.addEventListener("pointercancel",stop);button.addEventListener("pointerleave",stop)});
  document.getElementById("maze").addEventListener("touchstart",e=>{if(e.touches.length===1)touchStart={x:e.touches[0].clientX,y:e.touches[0].clientY}},{passive:true});
  document.getElementById("maze").addEventListener("touchend",e=>{if(!touchStart)return;const touch=e.changedTouches[0],dx=touch.clientX-touchStart.x,dy=touch.clientY-touchStart.y;touchStart=null;if(Math.max(Math.abs(dx),Math.abs(dy))<24)return;move(Math.abs(dx)>Math.abs(dy)?(dx>0?"right":"left"):(dy>0?"down":"up"))},{passive:true});
  document.getElementById("restart").addEventListener("click",restart);document.getElementById("hint").addEventListener("click",showHint);document.getElementById("pause").addEventListener("click",e=>{if(complete)return;paused=!paused;if(paused){elapsed=startedAt?performance.now()-startedAt:elapsed;startedAt=0}else if(moves)startedAt=performance.now()-elapsed;e.currentTarget.textContent=paused?"계속":"일시정지"});
  const ghostToggle=document.getElementById("ghost-toggle");if(ghostToggle)ghostToggle.addEventListener("click",()=>{ghostOn=!ghostOn;ghostToggle.setAttribute("aria-pressed",String(ghostOn));ghostToggle.textContent=ghostOn?"고스트 끄기":"고스트 대결";ghost.style.opacity=ghostOn?".48":"0";ghostStarted=performance.now()});
  drawPosition();timeEl.textContent=format(limitMs||0);frameId=requestAnimationFrame(tick);addEventListener("beforeunload",()=>cancelAnimationFrame(frameId));
  </script>
</body>
</html>`
}

export function standaloneHtmlBlob(
  project: MazeProject,
  options: StandaloneHtmlOptions = {},
): Blob {
  return new Blob([createStandaloneHtml(project, options)], {
    type: 'text/html;charset=utf-8',
  })
}
