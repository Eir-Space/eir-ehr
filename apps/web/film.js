// Language switch and chapter list for the explainer films. Plain files under /video/, no third parties.
const films = {
  en: [
    ['01-what-and-why', 'What Eir is and why', '1:24'],
    ['02-how-it-works', 'How it works', '2:18'],
    ['03-how-to-contribute', 'How to contribute', '2:07'],
  ],
  sv: [
    ['01-vad-och-varfor', 'Vad Eir är och varför', '1:42'],
    ['02-sa-fungerar-det', 'Så fungerar det', '2:43'],
    ['03-sa-bidrar-du', 'Så bidrar du', '2:33'],
  ],
};
const labels = { en: 'English', sv: 'Svenska' };
const headings = {
  en: 'Watch: what Eir is and why we build it',
  sv: 'Se filmen: vad Eir är och varför vi bygger det',
};
const title = document.getElementById('film-title');
const player = document.getElementById('film-player');
const captions = document.getElementById('film-captions');
const list = document.getElementById('film-list');
if (player && captions && list) {
  const remembered = (() => {
    try {
      return localStorage.getItem('film-lang');
    } catch {
      return null;
    }
  })();
  let lang = remembered in films ? remembered : navigator.language?.startsWith('sv') ? 'sv' : 'en';
  let index = 0;
  const show = (play) => {
    const [id] = films[lang][index];
    const suffix = lang;
    player.poster = `/video/${id}.jpg`;
    player.src = `/video/${id}.mp4`;
    captions.src = `/video/${id}.${suffix}.vtt`;
    captions.srclang = lang;
    captions.label = labels[lang];
    if (title) title.textContent = headings[lang];
    document.getElementById('film').setAttribute('lang', lang);
    player.load();
    if (play) player.play().catch(() => {});
    document.querySelectorAll('.film-lang button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    });
    list.replaceChildren(
      ...films[lang].map(([, title, length], i) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `${i + 1}. ${title}`;
        const span = document.createElement('span');
        span.textContent = length;
        button.append(span);
        button.setAttribute('aria-current', String(i === index));
        button.addEventListener('click', () => {
          index = i;
          show(true);
        });
        li.append(button);
        return li;
      }),
    );
  };
  document.querySelectorAll('.film-lang button').forEach((b) =>
    b.addEventListener('click', () => {
      lang = b.dataset.lang;
      try {
        localStorage.setItem('film-lang', lang);
      } catch {}
      index = 0;
      show(false);
    }),
  );
  player.addEventListener('ended', () => {
    if (index < films[lang].length - 1) {
      index += 1;
      show(true);
    }
  });
  show(false);
}
