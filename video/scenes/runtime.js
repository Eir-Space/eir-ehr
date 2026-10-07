// Scene runtime (v3). A scene is plain HTML/CSS/SVG. The build injects `window.__timing` (this
// scene's narration lines with start/end and word times) and calls `window.__setTime(t)` for every
// frame, so a frame is a pure function of t: reproducible, and scrubbable by hand (scene.html?t=3.2).
//
// Attributes on any element:
//   data-line="N"       appear when narration line N starts (0-based, within the scene)
//   data-cue="N:W"      appear when word W of line N starts (finer sync to the voice)
//   data-at="S"         appear S seconds into the scene
//   data-delay="S"      extra delay         data-dur="S"  length of the reveal (default 0.8)
//   data-anim="..."     up (default) | down | left | right | scale | fade | wipe | draw | type | count
//   data-stagger="S"    on a container: its children appear one after another, S seconds apart
//   data-hide-line="N"  fade out when line N starts
//   data-pulse="N"      glow while line N is spoken
//   data-flow="n"       on an SVG path: n dots travel along it once the path is visible
//   data-count="to"     with data-anim="count": counts up from 0 to the number
//   <i data-icon="name" data-size="40"></i>  Lucide icon (see icons.js)
(() => {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const out = (x) => 1 - Math.pow(1 - x, 3);
  const outQuint = (x) => 1 - Math.pow(1 - x, 5);
  const inOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const params = new URLSearchParams(location.search);
  const T = () => window.__timing;
  const SVG = 'http://www.w3.org/2000/svg';

  const state = new WeakMap(); // per-element cached facts (text for typing, path length)
  const flowState = new WeakMap(); // dots belong to flow(); reveal() keeps its own facts in `state`
  let revealed = [],
    pulses = [],
    flows = [],
    ready = false,
    captionLine = -1;

  // On-screen text lives in per-language files (video/locales). A scene names a key; the build injects
  // the strings for the video's language. data-t sets text, data-th sets trusted markup from our own files.
  function strings() {
    const s = window.__strings || {};
    const missing = [];
    document.querySelectorAll('[data-t],[data-th]').forEach((el) => {
      const key = el.dataset.t || el.dataset.th;
      const v = s[key];
      if (v === undefined) return void missing.push(key);
      if (el.dataset.t) el.textContent = v;
      else el.innerHTML = v;
    });
    if (missing.length) console.warn('Missing strings: ' + missing.join(', '));
    window.__missingStrings = missing;
  }

  function icons() {
    document.querySelectorAll('i[data-icon]').forEach((el) => {
      const nodes = (window.ICONS || {})[el.dataset.icon];
      if (!nodes) return;
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('class', 'icon');
      for (const [tag, attrs] of nodes) {
        const n = document.createElementNS(SVG, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        svg.appendChild(n);
      }
      el.style.display = 'inline-block';
      el.style.fontSize = (el.dataset.size || '1em') + (el.dataset.size ? 'px' : '');
      el.appendChild(svg);
    });
  }

  function chrome() {
    const t = T();
    const light = document.documentElement.classList.contains('light');
    const bg = document.createElement('div');
    bg.className = 'bg';
    document.body.prepend(bg);
    const bar = document.createElement('div');
    bar.className = 'topbar';
    bar.innerHTML = `<img src="../assets/${light ? 'wordmark-light' : 'wordmark'}.png" alt="eir SPACE" onerror="this.outerHTML='<b style=&quot;font:700 34px var(--sans);letter-spacing:-0.03em&quot;>eir <span style=&quot;color:var(--gold-400);font-weight:600;letter-spacing:0.08em;font-size:26px&quot;>SPACE</span></b>'"><div class="chapter">${t.chapter || ''}</div>`;
    document.body.appendChild(bar);
    const prog = document.createElement('div');
    prog.className = 'progress';
    prog.innerHTML = '<i></i>';
    document.body.appendChild(prog);
    const cap = document.createElement('div');
    cap.id = 'caption';
    cap.innerHTML = '<div class="pill"></div>';
    document.body.appendChild(cap);
  }

  function distribute() {
    // A container with data-stagger hands its line and a growing delay to its children.
    document.querySelectorAll('[data-stagger]').forEach((box) => {
      const step = parseFloat(box.dataset.stagger);
      const line = box.dataset.line,
        at = box.dataset.at,
        cue = box.dataset.cue;
      [...box.children].forEach((child, i) => {
        if (
          child.dataset.line === undefined &&
          child.dataset.at === undefined &&
          child.dataset.cue === undefined
        ) {
          if (line !== undefined) child.dataset.line = line;
          if (at !== undefined) child.dataset.at = at;
          if (cue !== undefined) child.dataset.cue = cue;
          child.dataset.delay = String(
            parseFloat(child.dataset.delay || '0') +
              parseFloat(box.dataset.delay || '0') +
              i * step,
          );
          if (!child.dataset.anim) child.dataset.anim = box.dataset.childAnim || 'up';
        }
      });
      delete box.dataset.line;
      delete box.dataset.at;
      delete box.dataset.cue;
      box.style.opacity = 1;
    });
  }

  function startOf(el) {
    const tm = T();
    if (el.dataset.at !== undefined) return parseFloat(el.dataset.at);
    if (el.dataset.cue !== undefined) {
      const [l, w] = el.dataset.cue.split(':').map(Number);
      const word = tm.lines[l] && tm.lines[l].words && tm.lines[l].words[w];
      return word ? word.start : tm.lines[l] ? tm.lines[l].start : 0;
    }
    const line = tm.lines[parseInt(el.dataset.line, 10)];
    return line ? line.start : 0;
  }

  function reveal(el, t) {
    const info = state.get(el) || {};
    const start = startOf(el) + parseFloat(el.dataset.delay || '0');
    const dur = parseFloat(el.dataset.dur || '0.8');
    const raw = clamp((t - start) / dur);
    const p = out(raw);
    const anim = el.dataset.anim || 'up';
    let gone = 1;
    if (el.dataset.hideLine !== undefined) {
      const h = T().lines[parseInt(el.dataset.hideLine, 10)];
      if (h) gone = 1 - clamp((t - h.start) / 0.4);
    }
    el.style.opacity = (anim === 'draw' || anim === 'type' ? (raw > 0 ? 1 : 0) : p) * gone;
    const m = {
      up: `translateY(${(1 - p) * 18}px)`,
      down: `translateY(${(1 - p) * -18}px)`,
      left: `translateX(${(1 - p) * -28}px)`,
      right: `translateX(${(1 - p) * 28}px)`,
      scale: `scale(${0.965 + 0.035 * p})`,
    };
    el.style.transform = m[anim] || '';
    if (anim === 'wipe') el.style.clipPath = `inset(0 ${(1 - outQuint(raw)) * 100}% 0 0)`;
    if (anim === 'draw' && el.getTotalLength) {
      info.len = info.len || el.getTotalLength();
      el.style.strokeDasharray = info.len;
      el.style.strokeDashoffset = info.len * (1 - outQuint(raw));
    }
    if (anim === 'type') {
      if (info.text === undefined) info.text = el.textContent;
      const n = Math.floor(info.text.length * raw);
      const caret = raw > 0 && raw < 1 ? '▌' : '';
      el.textContent = info.text.slice(0, n) + caret;
    }
    if (anim === 'count') {
      const to = parseFloat(el.dataset.count);
      el.textContent = String(Math.round(to * outQuint(raw)));
    }
    state.set(el, info);
  }

  function pulse(el, t) {
    const l = T().lines[parseInt(el.dataset.pulse, 10)];
    if (!l) return;
    const a = clamp((t - (l.start - 0.15)) / 0.35) * (1 - clamp((t - (l.end + 0.1)) / 0.5));
    el.style.boxShadow =
      a > 0 ? `0 0 0 ${(7 * a).toFixed(2)}px rgba(61,181,198,${(0.12 * a).toFixed(3)})` : '';
    el.style.borderColor = a > 0 ? `rgba(61,181,198,${(0.15 + 0.5 * a).toFixed(3)})` : '';
  }

  function flow(path, t) {
    const info =
      flowState.get(path) ||
      (() => {
        const n = parseInt(path.dataset.flow || '3', 10);
        const circles = Array.from({ length: n }, () => {
          const c = document.createElementNS(SVG, 'circle');
          c.setAttribute('r', '6');
          c.setAttribute('class', 'dot' + (path.classList.contains('gold') ? ' gold' : ''));
          path.parentNode.appendChild(c);
          return c;
        });
        const i = { circles, len: path.getTotalLength() };
        flowState.set(path, i);
        return i;
      })();
    const vis = parseFloat(path.style.opacity || '1');
    const period = parseFloat(path.dataset.period || '2.8');
    info.circles.forEach((c, i) => {
      const u = ((((t - startOf(path)) / period + i / info.circles.length) % 1) + 1) % 1;
      const pt = path.getPointAtLength(u * info.len);
      c.setAttribute('cx', pt.x);
      c.setAttribute('cy', pt.y);
      c.style.opacity = vis > 0.98 && t > startOf(path) + 0.9 ? Math.sin(Math.PI * u) : 0;
    });
  }

  function caption(t) {
    const tm = T();
    if (params.get('captions') === '0')
      return void (document.getElementById('caption').style.display = 'none');
    const box = document.getElementById('caption');
    const idx = tm.lines.findIndex((l) => t >= l.start - 0.1 && t <= l.end + 0.5);
    if (idx !== captionLine) {
      captionLine = idx;
      const pill = box.firstChild;
      pill.innerHTML = '';
      if (idx >= 0) {
        const l = tm.lines[idx];
        (l.words && l.words.length
          ? l.words
          : [{ text: l.text, start: l.start, end: l.end }]
        ).forEach((w, i, all) => {
          const s = document.createElement('span');
          s.className = 'w';
          s.textContent = w.text;
          pill.appendChild(s);
          if (i < all.length - 1) pill.appendChild(document.createTextNode(' '));
        });
      }
    }
    if (idx < 0) return void (box.style.opacity = 0);
    const l = tm.lines[idx];
    const words = box.firstChild.querySelectorAll('.w');
    const src = l.words && l.words.length ? l.words : [{ start: l.start, end: l.end }];
    words.forEach((el, i) => {
      const w = src[i];
      const next = src[i + 1];
      const past = t >= w.start,
        now = past && t < (next ? next.start : w.end + 0.15);
      el.className = 'w' + (now ? ' now' : past ? ' past' : '');
    });
    box.style.opacity =
      clamp((t - (l.start - 0.1)) / 0.25) * (1 - clamp((t - (l.end + 0.25)) / 0.25));
  }

  window.__setTime = (t) => {
    if (!ready) return;
    const tm = T();
    revealed.forEach((el) => reveal(el, t));
    pulses.forEach((el) => pulse(el, t));
    flows.forEach((el) => flow(el, t));
    caption(t);
    // Slow ambient motion: the glow drifts, the stage creeps toward the viewer. Both are barely
    // noticeable on purpose; they keep a still frame from feeling dead.
    const u = t / Math.max(1, tm.duration);
    const root = document.documentElement.style;
    root.setProperty('--gx', `${18 + 7 * Math.sin(t * 0.17)}%`);
    root.setProperty('--gy', `${6 + 5 * Math.cos(t * 0.13)}%`);
    root.setProperty('--hx', `${86 - 7 * Math.sin(t * 0.15 + 1)}%`);
    root.setProperty('--hy', `${96 - 6 * Math.cos(t * 0.11)}%`);
    const stage = document.querySelector('.stage');
    if (stage)
      stage.style.transform = `scale(${(1 + 0.014 * inOut(u)).toFixed(5)}) translateY(${(-6 * u).toFixed(2)}px)`;
    const bar = document.querySelector('.progress i');
    if (bar && tm.total)
      bar.style.width = `${(100 * clamp(((tm.globalStart || 0) + t) / tm.total)).toFixed(3)}%`;
    document.body.dataset.ready = '1';
  };

  function start() {
    if (ready) return;
    if (window.__theme === 'light' || params.get('theme') === 'light')
      document.documentElement.classList.add('light');
    if (!window.__timing) {
      const n = [...document.querySelectorAll('[data-line]')].reduce(
        (m, e) => Math.max(m, parseInt(e.dataset.line, 10) || 0),
        0,
      );
      window.__timing = {
        duration: (n + 1) * 4 + 2,
        chapter: document.title,
        lines: Array.from({ length: n + 1 }, (_, i) => ({
          start: 1 + i * 4,
          end: 4 + i * 4,
          text: `(linje ${i})`,
          words: [],
        })),
      };
    }
    strings();
    icons();
    chrome();
    distribute();
    revealed = [...document.querySelectorAll('[data-line],[data-at],[data-cue]')].filter(
      (e) => !e.matches('[data-flow]') || true,
    );
    pulses = [...document.querySelectorAll('[data-pulse]')];
    flows = [...document.querySelectorAll('[data-flow]')];
    ready = true;
    window.__setTime(parseFloat(params.get('t') || '0'));
  }
  window.__start = start;
  // The build starts scenes itself, after injecting timing and strings; a browser starts them on load.
  window.addEventListener('DOMContentLoaded', () => {
    if (!window.__manual) start();
  });
})();
