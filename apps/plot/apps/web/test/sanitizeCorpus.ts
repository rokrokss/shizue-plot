/**
 * Creator markup as it is actually written, kept apart from the assertions so the
 * corpus reads as a gallery of cards rather than as a test file.
 *
 * Every entry is markup a display script's OUT template produces once its captures
 * and macros have been bound — so `$1` and `{{getvar::hp}}` appear here already
 * substituted, which is the string `sanitizeCustomHtml` is handed at render time.
 */
export interface CorpusCase {
  name: string;
  /** What the card is, in the words a creator would use. */
  about: string;
  html: string;
}

export const CORPUS: CorpusCase[] = [
  {
    name: 'status-window',
    about: 'The RisuAI status block: a stylesheet, a heading and a row of stats.',
    html: `<style>
.status { border: 1px solid #3a3a44; border-radius: 12px; padding: 10px 14px; background: #17171c; }
.status .title { font-weight: 700; font-size: 13px; letter-spacing: 0.02em; color: #d8b4fe; }
.status .row { display: flex; gap: 12px; margin-top: 6px; }
.status .row span { font-size: 12px; color: #b8b6c2; }
.status .row span b { color: #ecebef; }
</style>
<div class="status">
  <div class="title">루미의 상태</div>
  <div class="row">
    <span>체력 <b>72</b></span>
    <span>기분 <b>들뜸</b></span>
    <span>소지금 <b>1,240</b></span>
  </div>
</div>`,
  },
  {
    name: 'hp-gauge',
    about: 'A bar whose fill is an inline width, which is how every gauge is built.',
    html: `<div class="gauge">
  <div class="gauge-label">HP 72 / 100</div>
  <div class="gauge-track" style="height: 8px; border-radius: 4px; background: #2a2a32; overflow: hidden">
    <div class="gauge-fill" style="width: 72%; height: 100%; background: linear-gradient(90deg, #7c3aed, #d8b4fe)"></div>
  </div>
</div>`,
  },
  {
    name: 'themed-card',
    about: 'A themed card: media query, decorative ::before, shadow, transition.',
    html: `<style>
.card { position: relative; padding: 12px 16px; border-radius: 14px; background: #1b1b21; box-shadow: 0 2px 12px rgba(0,0,0,0.45); transition: transform 120ms ease; }
.card::before { content: ''; position: absolute; left: 0; top: 0; width: 3px; height: 100%; background: #d8b4fe; border-radius: 3px 0 0 3px; }
.card h3 { margin: 0 0 4px; font-size: 14px; }
@media (max-width: 480px) { .card { padding: 8px 10px; } .card h3 { font-size: 13px; } }
@supports (display: grid) { .card .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; } }
</style>
<div class="card"><h3>여관 · 2층 객실</h3><div class="grid"><span>밤</span><span>비</span></div></div>`,
  },
  {
    name: 'stat-table',
    about: 'A stat sheet as a table, spans and all.',
    html: `<table class="sheet">
  <caption>파티 상태</caption>
  <colgroup><col span="1" width="90"><col span="2"></colgroup>
  <thead><tr><th>이름</th><th colspan="2">상태</th></tr></thead>
  <tbody>
    <tr><td rowspan="2">루미</td><td>HP</td><td>72</td></tr>
    <tr><td>MP</td><td>18</td></tr>
  </tbody>
  <tfoot><tr><td colspan="3">턴 12</td></tr></tfoot>
</table>`,
  },
  {
    name: 'portrait',
    about: 'A character asset, the url `{{img::slug}}` resolves to, inside a figure.',
    html: `<figure class="portrait" style="margin: 0; text-align: center">
  <img src="/api/plots/8f2c/assets/lumi-smile.png" alt="루미" width="120" height="120" style="border-radius: 12px">
  <figcaption style="font-size: 11px; color: #9a99a6">웃는 얼굴</figcaption>
</figure>`,
  },
  {
    name: 'background-asset',
    about: 'A same-origin `url()` in CSS, which is what a themed status window uses.',
    html: `<style>
.scene { min-height: 90px; border-radius: 12px; background-image: url('/api/plots/8f2c/assets/inn-night.png'); background-size: cover; background-position: center; }
.scene .caption { padding: 6px 8px; font-size: 11px; background: rgba(0,0,0,0.55); }
</style>
<div class="scene"><div class="caption">여관 · 밤</div></div>`,
  },
  {
    name: 'choice-buttons',
    about: 'What `{{button::라벨::입력}}` renders to: the one interactive element.',
    html: `<div class="choices" style="display: flex; gap: 8px; flex-wrap: wrap">
  <button type="button" data-shizue-fill="문을 두드린다">문을 두드린다</button>
  <button type="button" data-shizue-fill="창문으로 돌아간다">창문으로 돌아간다</button>
</div>`,
  },
  {
    name: 'disclosure',
    about: 'Native widgets creators reach for: details, progress, meter, time.',
    html: `<details class="log">
  <summary>지난 기록</summary>
  <p>비가 그치지 않았다.</p>
  <progress value="72" max="100"></progress>
  <meter value="0.4" min="0" max="1" low="0.3" high="0.7" optimum="1"></meter>
  <p><time datetime="2026-08-06">8월 6일</time> · <abbr title="여관">INN</abbr></p>
</details>`,
  },
  {
    name: 'external-link',
    about: 'A hyperlink the creator wrote out in full — no interpolation in it.',
    html: `<p class="note">설정은 <a href="https://blog.example.test/lumi">여기</a>에.</p>`,
  },
  {
    name: 'risu-import-status',
    about:
      'The shape the RisuAI compat layer produces: an OUT template with its own ' +
      'namespaced classes, a scoped stylesheet and the capture already bound.',
    html: `<div class="risu-status">
<style>
.risu-status { font-family: inherit; border: 1px solid rgba(216,180,254,0.35); border-radius: 10px; padding: 8px 12px; }
.risu-status .k { color: #9a99a6; font-size: 11px; }
.risu-status .v { color: #ecebef; font-size: 13px; font-weight: 600; }
.risu-status .bar { height: 6px; background: #2a2a32; border-radius: 3px; }
.risu-status .bar > i { display: block; height: 100%; background: #d8b4fe; border-radius: 3px; }
</style>
<div><span class="k">호감도</span> <span class="v">55</span></div>
<div class="bar"><i style="width: 55%"></i></div>
<div><span class="k">위치</span> <span class="v">여관 2층</span></div>
</div>`,
  },
  {
    name: 'risu-import-inline',
    about: 'A RisuAI template written entirely in inline styles, as many of them are.',
    html: `<div style="border:1px solid #444;border-radius:8px;padding:6px 10px;font-size:12px;color:#ddd;background:#1a1a1f">
<span style="color:#d8b4fe;font-weight:700">[상태]</span>
<span style="margin-left:6px">HP <b style="color:#fff">72</b></span>
<span style="margin-left:6px">MP <b style="color:#fff">18</b></span>
<div style="margin-top:4px;height:6px;background:#2a2a32"><div style="width:72%;height:6px;background:#7c3aed"></div></div>
</div>`,
  },
  {
    name: 'prose-decorations',
    about: 'The plain typographic tags a card uses inside a status block.',
    html: `<blockquote class="quote"><p><b>루미</b>: <i>“비 그치면 나가자.”</i></p></blockquote>
<ul class="items"><li>우산 <mark>1</mark></li><li>등불 <s>2</s> <small>(젖음)</small></li></ul>
<hr>
<pre class="raw"><code>hp=72 mp=18</code></pre>`,
  },
];

/**
 * What today's sanitizer makes of each card, pinned.
 *
 * This is the compat gate the design document asked for: a sanitizer rule is
 * allowed to change, but not silently. Any edit that drops a tag, an attribute or
 * a CSS declaration one of these cards depends on shows up here as a diff, and
 * somebody has to look at it and decide the new output is the one they meant —
 * which is the decision that was being made implicitly, in the dark, before.
 *
 * Regenerating this block to make a test pass is the one thing it exists to stop.
 */
export const PINNED: Record<string, string> = {
  'status-window': `<style>.shizue-msg .x-shizue-status {
  border: 1px solid #3a3a44;
  border-radius: 12px;
  padding: 10px 14px;
  background: #17171c;
}

.shizue-msg .x-shizue-status .x-shizue-title {
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.02em;
  color: #d8b4fe;
}

.shizue-msg .x-shizue-status .x-shizue-row {
  display: flex;
  gap: 12px;
  margin-top: 6px;
}

.shizue-msg .x-shizue-status .x-shizue-row span {
  font-size: 12px;
  color: #b8b6c2;
}

.shizue-msg .x-shizue-status .x-shizue-row span b {
  color: #ecebef;
}</style>
<div class="x-shizue-status">
  <div class="x-shizue-title">루미의 상태</div>
  <div class="x-shizue-row">
    <span>체력 <b>72</b></span>
    <span>기분 <b>들뜸</b></span>
    <span>소지금 <b>1,240</b></span>
  </div>
</div>`,
  'hp-gauge': `<div class="x-shizue-gauge">
  <div class="x-shizue-gauge-label">HP 72 / 100</div>
  <div class="x-shizue-gauge-track" style="height: 8px; border-radius: 4px; background: #2a2a32; overflow: hidden">
    <div class="x-shizue-gauge-fill" style="width: 72%; height: 100%; background: linear-gradient(90deg, #7c3aed, #d8b4fe)"></div>
  </div>
</div>`,
  'themed-card': `<style>.shizue-msg .x-shizue-card {
  position: relative;
  padding: 12px 16px;
  border-radius: 14px;
  background: #1b1b21;
  box-shadow: 0 2px 12px rgba(0,0,0,0.45);
  transition: transform 120ms ease;
}

.shizue-msg .x-shizue-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  width: 3px;
  height: 100%;
  background: #d8b4fe;
  border-radius: 3px 0 0 3px;
}

.shizue-msg .x-shizue-card h3 {
  margin: 0 0 4px;
  font-size: 14px;
}

@media (max-width: 480px) {
  .shizue-msg .x-shizue-card {
    padding: 8px 10px;
  }

  .shizue-msg .x-shizue-card h3 {
    font-size: 13px;
  }
}

@supports (display: grid) {
  .shizue-msg .x-shizue-card .x-shizue-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
}</style>
<div class="x-shizue-card"><h3>여관 · 2층 객실</h3><div class="x-shizue-grid"><span>밤</span><span>비</span></div></div>`,
  'stat-table': `<table class="x-shizue-sheet">
  <caption>파티 상태</caption>
  <colgroup><col span="1" width="90"><col span="2"></colgroup>
  <thead><tr><th>이름</th><th colspan="2">상태</th></tr></thead>
  <tbody>
    <tr><td rowspan="2">루미</td><td>HP</td><td>72</td></tr>
    <tr><td>MP</td><td>18</td></tr>
  </tbody>
  <tfoot><tr><td colspan="3">턴 12</td></tr></tfoot>
</table>`,
  'portrait': `<figure class="x-shizue-portrait" style="margin: 0; text-align: center">
  <img src="/api/plots/8f2c/assets/lumi-smile.png" alt="루미" width="120" height="120" style="border-radius: 12px">
  <figcaption style="font-size: 11px; color: #9a99a6">웃는 얼굴</figcaption>
</figure>`,
  'background-asset': `<style>.shizue-msg .x-shizue-scene {
  min-height: 90px;
  border-radius: 12px;
  background-image: url('/api/plots/8f2c/assets/inn-night.png');
  background-size: cover;
  background-position: center;
}

.shizue-msg .x-shizue-scene .x-shizue-caption {
  padding: 6px 8px;
  font-size: 11px;
  background: rgba(0,0,0,0.55);
}</style>
<div class="x-shizue-scene"><div class="x-shizue-caption">여관 · 밤</div></div>`,
  'choice-buttons': `<div class="x-shizue-choices" style="display: flex; gap: 8px; flex-wrap: wrap">
  <button type="button" data-shizue-fill="문을 두드린다">문을 두드린다</button>
  <button type="button" data-shizue-fill="창문으로 돌아간다">창문으로 돌아간다</button>
</div>`,
  'disclosure': `<details class="x-shizue-log">
  <summary>지난 기록</summary>
  <p>비가 그치지 않았다.</p>
  <progress value="72" max="100"></progress>
  <meter value="0.4" min="0" max="1" low="0.3" high="0.7" optimum="1"></meter>
  <p><time datetime="2026-08-06">8월 6일</time> · <abbr title="여관">INN</abbr></p>
</details>`,
  'external-link': `<p class="x-shizue-note">설정은 <a href="https://blog.example.test/lumi" target="_blank" rel="noopener noreferrer nofollow">여기</a>에.</p>`,
  'risu-import-status': `<style>.shizue-msg .x-shizue-risu-status {
  font-family: inherit;
  border: 1px solid rgba(216,180,254,0.35);
  border-radius: 10px;
  padding: 8px 12px;
}

.shizue-msg .x-shizue-risu-status .x-shizue-k {
  color: #9a99a6;
  font-size: 11px;
}

.shizue-msg .x-shizue-risu-status .x-shizue-v {
  color: #ecebef;
  font-size: 13px;
  font-weight: 600;
}

.shizue-msg .x-shizue-risu-status .x-shizue-bar {
  height: 6px;
  background: #2a2a32;
  border-radius: 3px;
}

.shizue-msg .x-shizue-risu-status .x-shizue-bar > i {
  display: block;
  height: 100%;
  background: #d8b4fe;
  border-radius: 3px;
}</style><div class="x-shizue-risu-status">

<div><span class="x-shizue-k">호감도</span> <span class="x-shizue-v">55</span></div>
<div class="x-shizue-bar"><i style="width: 55%"></i></div>
<div><span class="x-shizue-k">위치</span> <span class="x-shizue-v">여관 2층</span></div>
</div>`,
  'risu-import-inline': `<div style="border: 1px solid #444; border-radius: 8px; padding: 6px 10px; font-size: 12px; color: #ddd; background: #1a1a1f">
<span style="color: #d8b4fe; font-weight: 700">[상태]</span>
<span style="margin-left: 6px">HP <b style="color: #fff">72</b></span>
<span style="margin-left: 6px">MP <b style="color: #fff">18</b></span>
<div style="margin-top: 4px; height: 6px; background: #2a2a32"><div style="width: 72%; height: 6px; background: #7c3aed"></div></div>
</div>`,
  'prose-decorations': `<blockquote class="x-shizue-quote"><p><b>루미</b>: <i>“비 그치면 나가자.”</i></p></blockquote>
<ul class="x-shizue-items"><li>우산 <mark>1</mark></li><li>등불 <s>2</s> <small>(젖음)</small></li></ul>
<hr>
<pre class="x-shizue-raw"><code>hp=72 mp=18</code></pre>`,
};
